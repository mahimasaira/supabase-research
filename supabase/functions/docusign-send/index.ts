// Feature 4 (DocuSign), stage 2: send the agreement for a booking that waits for a signature.
//
// Called by the database (pg_net, trigger bookings_queue_signature_request) with
// { booking_id } and the project's secret key as bearer token. Not meant for browsers.
//
// Flow: claim the booking(s) → build the agreement → create the DocuSign envelope →
// record envelope_id + 'sent', or 'failed' + the error. A recurring series is claimed and
// sent as ONE envelope. The claim (pending → sending, committed before calling DocuSign)
// makes repeated or concurrent calls harmless: only one of them finds something to send.
//
// Database access: direct connection as `postgres` (a system process, no user to apply).
// Writes are labelled with JWT claims {"role": "docusign"}, so the audit log shows
// "DocuSign" as the actor.
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'
import { createEnvelope } from '../_shared/docusign.ts'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })

// Accept the project's secret keys (new sb_secret_… keys, or the legacy service_role key).
const secretKeys = [
  ...Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
].filter(Boolean)

const reply = (status: number, body: unknown) => Response.json(body, { status })
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Run statements as "DocuSign" (for the audit trigger), in one transaction.
const asDocuSign = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', '{"role":"docusign"}', true)`
    return fn(tx)
  })

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' })

function agreementHtml(host: string, guest: string, slots: { starts_at: Date; ends_at: Date }[]) {
  const rows = slots.map((s) => `<li>${fmt.format(s.starts_at)} – ${fmt.format(s.ends_at).split(' at ')[1]} (UTC)</li>`).join('')
  return `<!doctype html><html><body style="font-family: sans-serif; font-size: 14px">
<h1>Booking agreement</h1>
<p><strong>Host:</strong> ${escapeHtml(host)}<br><strong>Guest:</strong> ${escapeHtml(guest)}</p>
<p>The guest books the following session${slots.length > 1 ? 's' : ''}:</p>
<ul>${rows}</ul>
<p>By signing, the guest agrees to attend at the time${slots.length > 1 ? 's' : ''} above and to cancel
via their cancellation link if they can't. The booking is confirmed once this agreement is signed.</p>
<p style="margin-top: 48px">Signature: <span style="color: white">/sig1/</span></p>
<p style="margin-top: 32px">Date: <span style="color: white">/date1/</span></p>
</body></html>`
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'POST only' })
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!bearer || !secretKeys.includes(bearer)) return reply(401, { error: 'Not allowed' })

  const { booking_id: bookingId } = await req.json().catch(() => ({}))
  if (typeof bookingId !== 'string' || !GUID.test(bookingId)) return reply(400, { error: 'Expected { booking_id }' })

  // 1. Claim: only bookings that really wait for a signature and haven't been sent yet.
  //    Committed right away, so a second call for the same booking finds nothing.
  const claimed = await asDocuSign((tx) => tx`
    update public.bookings b
       set signature_status = 'sending', signature_updated_at = now(), signature_error = null
     where b.status = 'pending_signature'
       and b.signature_status in ('pending', 'failed')
       and (b.id = ${bookingId}
            or b.series_id = (select series_id from public.bookings where id = ${bookingId}))
    returning b.id, b.guest_name, b.guest_email, b.slot_id`)
  if (claimed.length === 0) return reply(200, { sent: false, reason: 'nothing waiting to be sent' })

  const ids = claimed.map((b) => b.id)
  try {
    // 2. Build the agreement: host, guest and all slot times (one or a whole series).
    const slots = await sql`
      select s.starts_at, s.ends_at, p.display_name
        from public.slots s join public.profiles p on p.id = s.host_id
       where s.id in ${sql(claimed.map((b) => b.slot_id))}
       order by s.starts_at`
    const guest = { name: claimed[0].guest_name, email: claimed[0].guest_email }
    const host = slots[0]?.display_name || 'your host'

    // 3. Send it.
    const envelopeId = await createEnvelope({
      subject: `Please sign: your booking with ${host}`.slice(0, 100),
      documentName: 'Booking agreement',
      html: agreementHtml(host, guest.name, slots),
      signer: guest,
    })

    // 4. Record it.
    await asDocuSign((tx) => tx`
      update public.bookings
         set envelope_id = ${envelopeId}, signature_status = 'sent', signature_updated_at = now()
       where id in ${tx(ids)}`)
    return reply(200, { sent: true, envelope_id: envelopeId, bookings: ids.length })
  } catch (err) {
    // The bookings stay pending_signature; signature_status 'failed' lets a retry claim them.
    const message = err instanceof Error ? err.message : String(err)
    console.error('docusign-send failed:', message)
    await asDocuSign((tx) => tx`
      update public.bookings
         set signature_status = 'failed', signature_error = ${message.slice(0, 500)}, signature_updated_at = now()
       where id in ${tx(ids)}`)
    return reply(502, { sent: false, error: message })
  }
})
