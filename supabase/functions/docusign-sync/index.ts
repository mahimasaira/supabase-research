// Feature 4 (DocuSign), stage 3: "Check signature status". The logged-in host asks; this
// function asks DocuSign about the host's agreements that are still out, and applies any
// result (signed / declined / voided). The fallback for when the webhook can't reach us
// (e.g. locally), and handy if a webhook message was lost.
//
// Called from the browser with the host's JWT (supabase.functions.invoke). verify_jwt is off
// for the same reason as book-recurring: the token is verified here, with getClaims.
// Only bookings on the caller's OWN slots are checked.
import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { getEnvelopeStatus } from '../_shared/docusign.ts'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
const auth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } }).auth

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: cors })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'POST only' })

  // 1. Who is asking? Must be a logged-in user (a host); guests have no slots to check.
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const { data, error } = bearer.startsWith('ey') ? await auth.getClaims(bearer) : { data: null, error: true }
  if (error || !data || data.claims.role !== 'authenticated') return reply(401, { error: 'Log in as a host' })
  const hostId = data.claims.sub as string

  // 2. The host's agreements that are still out.
  const envelopes = await sql`
    select distinct b.envelope_id
      from public.bookings b join public.slots s on s.id = b.slot_id
     where s.host_id = ${hostId}
       and b.status = 'pending_signature'
       and b.signature_status = 'sent'
       and b.envelope_id is not null`

  // 3. Ask DocuSign and apply the results (labelled as DocuSign in the audit log).
  const results = []
  for (const { envelope_id: envelopeId } of envelopes) {
    try {
      const status = await getEnvelopeStatus(envelopeId)
      const changed = await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', '{"role":"docusign"}', true)`
        const [row] = await tx`select public.docusign_apply_envelope_status(${envelopeId}, ${status}) as changed`
        return row.changed
      })
      results.push({ status, changed })
    } catch (err) {
      results.push({ error: err instanceof Error ? err.message : String(err) })
    }
  }
  return reply(200, {
    checked: envelopes.length,
    signed: results.filter((r) => r.status === 'completed' && r.changed).length,
    cancelled: results.filter((r) => (r.status === 'declined' || r.status === 'voided') && r.changed).length,
    waiting: results.filter((r) => r.status && !r.changed).length,
    errors: results.filter((r) => r.error).map((r) => r.error),
  })
})
