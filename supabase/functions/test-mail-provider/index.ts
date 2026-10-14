// TEST DOUBLE (feature 5, stage 3): an email provider with a sending limit, in front of Mailpit.
// Real providers (Resend, Postmark, SES, …) allow N emails per second and answer 429 above
// that. Mailpit has no limit, so this function plays the provider: it counts accepted emails in
// the database (so the limit holds across parallel callers), refuses with 429 + Retry-After when
// the last second is full, otherwise forwards to Mailpit. Limit: test_mail_provider_settings.
// Only the project's own functions may call it (secret key).
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
const MAILPIT = Deno.env.get('MAILPIT_URL') ?? 'http://inbucket:8025'
const secretKeys = [
  ...Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
].filter(Boolean)

Deno.serve(async (req) => {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!bearer || !secretKeys.includes(bearer)) return Response.json({ error: 'Not allowed' }, { status: 401 })
  const email = await req.json().catch(() => null)
  if (!email?.To?.length) return Response.json({ error: 'Expected a Mailpit-style message' }, { status: 400 })

  // Count-then-insert under one lock, so parallel callers can't all slip under the limit.
  const accepted = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended('test-mail-provider', 0))`
    const [{ limit_per_second: limit }] = await tx`select limit_per_second from public.test_mail_provider_settings where id = 1`
    const [{ n }] = await tx`select count(*)::int as n from public.test_mail_provider_log
                              where accepted and at > clock_timestamp() - interval '1 second'`
    const ok = n < limit
    await tx`insert into public.test_mail_provider_log (accepted) values (${ok})`
    return ok
  })
  if (!accepted) {
    return Response.json({ error: 'rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '1' } })
  }

  const res = await fetch(`${MAILPIT}/api/v1/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(email) })
  if (!res.ok) return Response.json({ error: `Mailpit: HTTP ${res.status}` }, { status: 502 })
  return Response.json({ accepted: true }, { status: 202 })
})
