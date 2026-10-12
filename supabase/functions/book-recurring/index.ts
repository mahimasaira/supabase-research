// Advanced feature 1, stage 3: recurring booking in an Edge Function that talks to Postgres
// over a DIRECT connection and runs the transaction itself: BEGIN … COMMIT / ROLLBACK.
//
// The catch: SUPABASE_DB_URL logs in as `postgres`, the database owner, which BYPASSES RLS.
// So before touching any table, every transaction does what PostgREST does for each API request:
//   1. verify who the caller is (publishable key = anonymous guest, or a signed user JWT)
//   2. SET ROLE to anon / authenticated, and put the JWT claims where auth.uid() reads them
// From then on the same grants and RLS policies apply as for supabase-js in the browser.
//
// verify_jwt is off for this function (supabase/config.toml): the built-in check accepts the
// publishable key without saying who the caller is, so this function does the check itself.
import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

const WEEK_MS = 7 * 24 * 3600_000 // same as split.js and the SQL function (168 hours)

// One connection per function instance. prepare: false keeps it compatible with
// Supabase's transaction pooler (port 6543), which hosted projects should use.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })

// Only used to verify JWTs (getClaims checks signature + expiry against the project's JWKS).
const auth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
  auth: { persistSession: false },
}).auth
const publishableKeys = Object.values(JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}'))

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: cors })

type Identity = { role: 'anon' | 'authenticated'; claims: Record<string, unknown> }

// Who is calling? Returns an identity, or an error Response.
async function identify(req: Request): Promise<Identity | Response> {
  const apikey = req.headers.get('apikey') ?? ''
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''

  // Every request must come from this project's own frontend (publishable key).
  if (!publishableKeys.includes(apikey)) return reply(401, { error: 'Missing or unknown apikey' })

  // No login: supabase-js sends the publishable key itself as the bearer token.
  // That's not a JWT, it's an anonymous guest.
  if (!bearer || bearer === apikey) return { role: 'anon', claims: { role: 'anon' } }

  // Otherwise it must be a JWT that Supabase Auth signed.
  const { data, error } = await auth.getClaims(bearer)
  if (error || !data) return reply(401, { error: 'Invalid or expired token' })
  const role = data.claims.role
  // Never accept service_role (or anything else) here: it would bypass RLS.
  if (role !== 'anon' && role !== 'authenticated') return reply(403, { error: `Role "${role}" not allowed` })
  return { role, claims: data.claims as Record<string, unknown> }
}

type Input = { hostId: string; firstStartsAt: string; weeks: number; guestName: string; guestEmail: string }

function parseInput(body: Record<string, unknown>): Input | null {
  const { hostId, firstStartsAt, weeks, guestName, guestEmail } = body ?? {}
  const ok = typeof hostId === 'string' && typeof firstStartsAt === 'string' && !isNaN(Date.parse(firstStartsAt))
    && Number.isInteger(weeks) && typeof guestName === 'string' && typeof guestEmail === 'string'
  return ok ? { hostId, firstStartsAt, weeks, guestName, guestEmail } as Input : null
}

// Thrown inside the transaction to make it roll back, and caught to build the response.
class BookingRejected extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super('booking rejected')
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'POST only' })

  const who = await identify(req)
  if (who instanceof Response) return who
  const input = parseInput(await req.json().catch(() => null))
  if (!input) return reply(400, { error: 'Expected { hostId, firstStartsAt, weeks, guestName, guestEmail }' })

  const first = new Date(input.firstStartsAt)
  const seriesId = crypto.randomUUID()
  const tx = await sql.reserve() // one dedicated connection for BEGIN … COMMIT
  let ranAs: Record<string, unknown> | undefined

  try {
    await tx`begin`

    // Apply the caller's identity for THIS transaction only (is_local = true):
    // the same two settings PostgREST makes for every API request.
    await tx`select set_config('role', ${who.role}, true),
                    set_config('request.jwt.claims', ${JSON.stringify(who.claims)}, true)`
    ;[ranAs] = await tx`select current_user as role, auth.uid() as uid`

    // 1. Enough weeks offered from this date? As anon, RLS only shows free future slots.
    const visible = await tx`select starts_at from public.slots
                             where host_id = ${input.hostId} and starts_at >= ${first}`
    const offsets = visible.map((s) => s.starts_at.getTime() - first.getTime()).filter((d) => d % WEEK_MS === 0)
    const offered = Math.max(0, ...offsets) / WEEK_MS + 1
    if (offered < input.weeks) {
      throw new BookingRejected(422, { notEnoughWeeks: { requested: input.weeks, available: offered } })
    }

    // 2. The series.
    await tx`insert into public.booking_series (id, host_id, guest_name, guest_email, weekday, start_time, weeks)
             values (${seriesId}, ${input.hostId}, ${input.guestName}, ${input.guestEmail},
                     ${first.getUTCDay()}, ${first.toISOString().slice(11, 16)}, ${input.weeks})`

    // 3. One booking per week (the slot trigger marks each slot taken in this same transaction).
    const weeks = []
    for (let week = 1; week <= input.weeks; week++) {
      const startsAt = new Date(first.getTime() + (week - 1) * WEEK_MS)
      const clash = (reason: string) =>
        new BookingRejected(409, { clash: { week, startsAt: startsAt.toISOString(), reason } })

      const [slot] = await tx`select id from public.slots
                              where host_id = ${input.hostId} and starts_at = ${startsAt} and not is_booked`
      if (!slot) throw clash('not available')

      const cancelToken = crypto.randomUUID()
      try {
        await tx`insert into public.bookings (slot_id, guest_name, guest_email, cancel_token, series_id, week_no)
                 values (${slot.id}, ${input.guestName}, ${input.guestEmail}, ${cancelToken}, ${seriesId}, ${week})`
      } catch (err) {
        // 23505 unique index / 42501 insert policy: booked by someone else since our lookup.
        if (err.code === '23505' || err.code === '42501') throw clash('just taken')
        throw err
      }
      weeks.push({ week, startsAt: startsAt.toISOString(), cancelToken })
    }

    await tx`commit`
    return reply(200, { ok: true, seriesId, weeks, ranAs })
  } catch (err) {
    await tx`rollback` // undoes the series and every week already inserted
    if (err instanceof BookingRejected) return reply(err.status, { ok: false, ...err.body, ranAs })
    // Database errors (e.g. 23514 invalid email): pass the code on, like PostgREST does.
    if (err.code) return reply(400, { ok: false, error: { code: err.code, message: err.message }, ranAs })
    console.error(err)
    return reply(500, { ok: false, error: { message: 'Internal error' } })
  } finally {
    tx.release()
  }
})
