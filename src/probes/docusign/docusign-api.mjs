// DocuSign eSignature API from Node, for the proof scripts only (same JWT grant as
// scripts/docusign-check.mjs). Reads the DOCUSIGN_* values from .env.local (node --env-file).
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const env = (n) => (process.env[n] ?? '').trim().replace(/^["']|["']$/g, '')
let cached = null

async function token() {
  if (cached && Date.now() < cached.expiresAt) return cached.token
  const authServer = env('DOCUSIGN_AUTH_SERVER').replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const b64 = (d) => Buffer.from(JSON.stringify(d)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: env('DOCUSIGN_INTEGRATION_KEY'), sub: env('DOCUSIGN_USER_ID'), aud: authServer, iat: now, exp: now + 600, scope: 'signature impersonation' })}`
  const assertion = `${unsigned}.${sign('sha256', Buffer.from(unsigned), createPrivateKey(readFileSync(env('DOCUSIGN_PRIVATE_KEY_PATH'), 'utf8'))).toString('base64url')}`
  const res = await fetch(`https://${authServer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  }).then((r) => r.json())
  cached = { token: res.access_token, expiresAt: Date.now() + 5 * 60_000 }
  return cached.token
}

// e.g. docusign('GET', `/envelopes/${id}`), docusign('PUT', `/envelopes/${id}`, { status: 'voided', voidedReason: '…' })
export async function docusign(method, path, body) {
  const base = env('DOCUSIGN_BASE_URI').replace(/\/+$/, '').replace(/\/restapi$/, '')
  const res = await fetch(`${base}/restapi/v2.1/accounts/${env('DOCUSIGN_ACCOUNT_ID')}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
