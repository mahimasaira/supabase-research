// Feature 4 (DocuSign), stage 4: withdraw (void) an agreement whose booking was cancelled,
// so the guest can't sign for a booking that no longer exists.
//
// Called by the database (pg_net, trigger bookings_queue_signature_void) with { envelope_id }
// and the project's secret key, like docusign-send. Not meant for browsers.
// Re-checks the database before voiding: only when NO booking with this agreement is still
// waiting or confirmed (a recurring series shares one agreement).
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'
import { voidEnvelope } from '../_shared/docusign.ts'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
const secretKeys = [
  ...Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
].filter(Boolean)
const reply = (status: number, body: unknown) => Response.json(body, { status })

// Writes labelled as DocuSign for the audit log, in one transaction.
const asDocuSign = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', '{"role":"docusign"}', true)`
    return fn(tx)
  })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'POST only' })
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!bearer || !secretKeys.includes(bearer)) return reply(401, { error: 'Not allowed' })

  const { envelope_id: envelopeId } = await req.json().catch(() => ({}))
  if (typeof envelopeId !== 'string' || !envelopeId) return reply(400, { error: 'Expected { envelope_id }' })

  const [usage] = await sql`
    select count(*) filter (where status in ('pending_signature', 'confirmed'))::int as active,
           count(*)::int as total
      from public.bookings where envelope_id = ${envelopeId}`
  if (usage.total === 0) return reply(200, { voided: false, reason: 'unknown agreement' })
  if (usage.active > 0) return reply(200, { voided: false, reason: 'still in use by an active booking' })

  try {
    await voidEnvelope(envelopeId, 'The booking was cancelled.')
  } catch (err) {
    // Typically: already voided, or signed just before the cancellation. Recorded, not retried.
    const message = err instanceof Error ? err.message : String(err)
    await asDocuSign((tx) => tx`
      update public.bookings set signature_error = ${message.slice(0, 500)} where envelope_id = ${envelopeId}`)
    return reply(200, { voided: false, error: message })
  }

  // 'expired' stays 'expired' (that's why it was withdrawn); everything else becomes 'voided'.
  await asDocuSign((tx) => tx`
    update public.bookings
       set signature_status = 'voided', signature_updated_at = now()
     where envelope_id = ${envelopeId} and signature_status in ('pending', 'sending', 'sent', 'failed')`)
  return reply(200, { voided: true })
})
