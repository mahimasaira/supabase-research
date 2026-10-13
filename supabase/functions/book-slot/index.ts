// Feature 3 (spam protection), stage 3: book one slot after a CAPTCHA check.
//
// For hosts who require a CAPTCHA, this is the only way in: the database refuses direct API
// bookings for them (bookings_check_captcha). Flow:
//   1. who is calling (publishable key = guest, or a user JWT)
//   2. verify the Cloudflare Turnstile token (from the widget on the booking page)
//   3. book over a direct connection, as the caller's role, with the client IP forwarded
//      (so the stage 2 rate limits apply) and the transaction marked as CAPTCHA-verified.
// RLS, the slot rules, the rate limits and the DocuSign trigger all apply as for a direct booking.
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'
import { applyCaller, clientIp, cors, identify, reply, statusFor, verifyCaptcha } from '../_shared/caller.ts'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'POST only' })

  const who = await identify(req)
  if (who instanceof Response) return who
  const body = await req.json().catch(() => ({}))
  const { slotId, guestName, guestEmail, cancelToken, captchaToken } = body ?? {}
  if (![slotId, cancelToken].every((v) => typeof v === 'string' && GUID.test(v)) || typeof guestName !== 'string' || typeof guestEmail !== 'string') {
    return reply(400, { error: { code: 'bad_request', message: 'Expected { slotId, guestName, guestEmail, cancelToken, captchaToken }' } })
  }

  // Checked before touching the database: no CAPTCHA, no booking (and no rate-limit quota used).
  const ip = clientIp(req)
  const captcha = await verifyCaptcha(captchaToken, ip)
  if (!captcha.ok) {
    return reply(403, { error: { code: 'captcha_failed', message: 'The CAPTCHA check failed. Please try again.', details: captcha.codes } })
  }

  try {
    await sql.begin(async (tx) => {
      await applyCaller(tx, who, ip, true)
      await tx`insert into public.bookings (slot_id, guest_name, guest_email, cancel_token)
               values (${slotId}, ${guestName}, ${guestEmail}, ${cancelToken})`
    })
    return reply(201, { ok: true })
  } catch (err) {
    // Same codes the booking page already knows from direct bookings (42501 taken, PT429 limit, …).
    return reply(statusFor(err.code), { error: { code: err.code ?? 'error', message: err.message } })
  }
})
