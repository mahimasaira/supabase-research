// Feature 4 (DocuSign), stage 3: DocuSign Connect calls this when an agreement is signed,
// declined or voided. Public endpoint (DocuSign sends no Supabase key; verify_jwt = false),
// so EVERY message must carry a valid HMAC signature:
//   X-DocuSign-Signature-1 = base64( HMAC-SHA256( Connect key, raw request body ) )
// (-2, -3 … during key rotation). Anything unsigned or wrongly signed: 401, nothing changes.
//
// Needs a public URL to receive real messages (hosted project or tunnel). Locally it's tested
// with simulated, correctly signed messages (npm run probe:docusign:proof:receive).
// The state change itself is public.docusign_apply_envelope_status (shared with docusign-sync).
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
const reply = (status: number, body: unknown) => Response.json(body, { status })

// DocuSign event → result recorded on the booking. Other events (sent, delivered, …) are acknowledged and ignored.
const RESULTS: Record<string, string> = {
  'envelope-completed': 'completed',
  'envelope-declined': 'declined',
  'envelope-voided': 'voided',
}

async function hmacBase64(key: string, body: Uint8Array) {
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, body))))
}

// Constant-time comparison, so response timing doesn't reveal how much of a guess was right.
function sameText(a: string, b: string) {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'POST only' })
  const key = Deno.env.get('DOCUSIGN_CONNECT_HMAC_KEY')
  if (!key) return reply(500, { error: 'Webhook not configured' })

  // 1. Signature over the exact bytes received (before any JSON parsing).
  const raw = new Uint8Array(await req.arrayBuffer())
  const expected = await hmacBase64(key, raw)
  const signatures = [...req.headers.entries()]
    .filter(([name]) => /^x-docusign-signature-\d+$/i.test(name))
    .map(([, value]) => value.trim())
  if (!signatures.some((s) => sameText(s, expected))) return reply(401, { error: 'Invalid signature' })

  // 2. What happened, and is it about our account?
  let message
  try {
    message = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return reply(400, { error: 'Expected JSON (Connect "SIM" format)' })
  }
  const envelopeId = message?.data?.envelopeId
  const result = RESULTS[message?.event]
  if (!envelopeId || !result) return reply(200, { ok: true, ignored: `event ${message?.event ?? '?'}` })
  if (String(message.data.accountId ?? '').toLowerCase() !== (Deno.env.get('DOCUSIGN_ACCOUNT_ID') ?? '').toLowerCase()) {
    return reply(200, { ok: true, ignored: 'other account' })
  }

  // 3. Apply it, labelled as DocuSign in the audit log. Repeats and late messages change nothing.
  const changed = await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', '{"role":"docusign"}', true)`
    const [row] = await tx`select public.docusign_apply_envelope_status(${envelopeId}, ${result}) as changed`
    return row.changed
  })
  // 200 even when nothing changed: DocuSign would otherwise keep retrying.
  return reply(200, { ok: true, result, changed })
})
