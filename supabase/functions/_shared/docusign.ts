// DocuSign helpers shared by the Edge Functions (feature 4).
// Same JWT grant as scripts/docusign-check.mjs. Secrets come from the function's environment
// (locally supabase/functions/.env, written by `npm run probe:docusign:setup`; hosted: Supabase
// secrets). The private key is base64-encoded PEM, because a deployed function has no key file.
import { createPrivateKey, sign } from 'node:crypto'

const env = (name: string) => {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

const config = () => ({
  integrationKey: env('DOCUSIGN_INTEGRATION_KEY'),
  userId: env('DOCUSIGN_USER_ID'),
  accountId: env('DOCUSIGN_ACCOUNT_ID'),
  authServer: env('DOCUSIGN_AUTH_SERVER').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  baseUri: env('DOCUSIGN_BASE_URI').replace(/\/+$/, '').replace(/\/restapi$/, ''),
  privateKeyPem: atob(env('DOCUSIGN_PRIVATE_KEY_BASE64')),
})

// One token per function instance, reused until 5 minutes before it expires.
let cached: { token: string; expiresAt: number } | null = null

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token
  const c = config()
  const b64url = (data: unknown) =>
    btoa(typeof data === 'string' ? data : JSON.stringify(data)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: c.integrationKey, sub: c.userId, aud: c.authServer, iat: now, exp: now + 3600, scope: 'signature impersonation',
  })}`
  const signature = sign('sha256', new TextEncoder().encode(unsigned), createPrivateKey(c.privateKeyPem)).toString('base64url')

  const res = await fetch(`https://${c.authServer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`DocuSign token: HTTP ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim())
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 300) * 1000 }
  return cached.token
}

export type Signer = { name: string; email: string }

// Sends an HTML document to one signer. The document must contain the anchor texts
// /sig1/ and /date1/ where the signature and the signing date go.
export async function createEnvelope(opts: { subject: string; html: string; documentName: string; signer: Signer }): Promise<string> {
  const c = config()
  const res = await fetch(`${c.baseUri}/restapi/v2.1/accounts/${c.accountId}/envelopes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      emailSubject: opts.subject,
      documents: [{
        documentId: '1',
        name: opts.documentName,
        fileExtension: 'html',
        documentBase64: btoa(String.fromCharCode(...new TextEncoder().encode(opts.html))),
      }],
      recipients: {
        signers: [{
          recipientId: '1',
          routingOrder: '1',
          name: opts.signer.name,
          email: opts.signer.email,
          tabs: {
            signHereTabs: [{ anchorString: '/sig1/', anchorUnits: 'pixels', anchorYOffset: '-10' }],
            dateSignedTabs: [{ anchorString: '/date1/', anchorUnits: 'pixels', anchorYOffset: '-10' }],
          },
        }],
      },
      status: 'sent', // send right away (not a draft)
      // Stage 3: ask DocuSign to report the result to our webhook. Only possible with a public
      // URL (hosted project or tunnel), so only when DOCUSIGN_WEBHOOK_URL is set. includeHMAC
      // signs each message with the account's Connect key (DocuSign admin → Connect → Connect Keys).
      ...(Deno.env.get('DOCUSIGN_WEBHOOK_URL') ? {
        eventNotification: {
          url: Deno.env.get('DOCUSIGN_WEBHOOK_URL'),
          deliveryMode: 'SIM',
          events: ['envelope-completed', 'envelope-declined', 'envelope-voided'],
          eventData: { version: 'restv2.1' },
          includeHMAC: 'true',
          requireAcknowledgment: 'true',
        },
      } : {}),
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`DocuSign create envelope: HTTP ${res.status} ${body.errorCode ?? ''} ${body.message ?? ''}`.trim())
  return body.envelopeId
}

// Stage 3: the envelope's current status ('sent', 'delivered', 'completed', 'declined', 'voided', …).
export async function getEnvelopeStatus(envelopeId: string): Promise<string> {
  const c = config()
  const res = await fetch(`${c.baseUri}/restapi/v2.1/accounts/${c.accountId}/envelopes/${encodeURIComponent(envelopeId)}`, {
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`DocuSign get envelope: HTTP ${res.status} ${body.errorCode ?? ''} ${body.message ?? ''}`.trim())
  return body.status
}

export const accountId = () => config().accountId

// Stage 4: withdraw an agreement. DocuSign then tells the guest it was voided, and it can no
// longer be signed. Throws if DocuSign refuses (e.g. already signed or already voided).
export async function voidEnvelope(envelopeId: string, reason: string): Promise<void> {
  const c = config()
  const res = await fetch(`${c.baseUri}/restapi/v2.1/accounts/${c.accountId}/envelopes/${encodeURIComponent(envelopeId)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'voided', voidedReason: reason.slice(0, 200) }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`DocuSign void: HTTP ${res.status} ${body.errorCode ?? ''} ${body.message ?? ''}`.trim())
  }
}
