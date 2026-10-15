// Edge Function: measurement helper for the hosted checks (HOSTED_CHECKS.md). Not used by the app.
//
// Locked: every request needs the header x-probe-token = the secret HOSTED_PROBE_TOKEN
// (set with `supabase secrets set` on the hosted project; unset locally = always 401).
// verify_jwt = false only because the token check replaces it.
//
// POST { mode: 'headers' }                  → the IP-related headers this request arrived with
// POST { mode: 'dbrole' }                   → which database role SUPABASE_DB_URL connects as
// POST { mode: 'sleep', seconds, run }      → sleeps, writing a heartbeat row every 5 s
//                                             (public.hosted_probe_heartbeats), then 'done'
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
const TOKEN = Deno.env.get('HOSTED_PROBE_TOKEN') ?? ''
const IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-envoy-external-address', 'forwarded']

Deno.serve(async (req) => {
  if (!TOKEN || req.headers.get('x-probe-token') !== TOKEN) return Response.json({ error: 'Not allowed' }, { status: 401 })
  const body = await req.json().catch(() => ({}))

  if (body.mode === 'headers') {
    return Response.json(Object.fromEntries(IP_HEADERS.map((h) => [h, req.headers.get(h)])))
  }

  if (body.mode === 'dbrole') {
    const [row] = await sql`select current_user as role, rolsuper as superuser, rolbypassrls as bypass_rls
                              from pg_roles where rolname = current_user`
    const [owner] = await sql`select tableowner from pg_tables where schemaname = 'public' and tablename = 'bookings'`
    return Response.json({ ...row, bookings_owner: owner?.tableowner })
  }

  if (body.mode === 'sleep') {
    const run = String(body.run ?? crypto.randomUUID())
    const seconds = Math.min(Number(body.seconds) || 1, 900)
    const started = Date.now()
    const beat = (note: string) =>
      sql`insert into public.hosted_probe_heartbeats (run_id, second, note) values (${run}, ${Math.round((Date.now() - started) / 1000)}, ${note})`
    await beat('start')
    while (Date.now() - started < seconds * 1000) {
      await new Promise((ok) => setTimeout(ok, Math.min(5000, seconds * 1000 - (Date.now() - started))))
      await beat('beat')
    }
    await beat('done')
    return Response.json({ run, slept: seconds })
  }

  return Response.json({ error: 'mode must be headers, dbrole or sleep' }, { status: 400 })
})
