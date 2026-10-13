// Turns audit_log entries into what the host's history page shows: who, when, what.
// Pure functions (no data access), so they can be tested without the app.
import { formatDate, formatRange } from '../../lib/format.js'

// Who did it, in plain words. myId = the logged-in host.
export function describeActor(entry, myId) {
  if (entry.actor_id && entry.actor_id === myId) return 'You'
  switch (entry.actor_role) {
    case 'anon': return 'Guest'
    case 'docusign': return 'DocuSign' // the integration's Edge Functions (feature 4)
    case 'authenticated': return 'A logged-in user'
    case 'supabase_auth_admin': return 'System (account)'
    case 'postgres':
    case 'supabase_admin':
    case 'service_role': return 'Database admin'
    default: return entry.actor_role
  }
}

const when = (start, end) => (start ? `${formatDate(start)}, ${end ? formatRange(start, end) : ''}`.replace(/, $/, '') : 'a slot')

// The booked slot's time: from the context recorded at write time (stage 4),
// or, for older entries, from the row itself if it was a new booking.
const bookingSlot = (e) => when(e.context?.slot_starts_at, e.context?.slot_ends_at)
const guest = (e) => e.context?.guest_name ?? e.changes?.guest_name ?? 'a guest'
const slotTime = (e) => when(e.context?.starts_at ?? e.changes?.starts_at, e.context?.ends_at ?? e.changes?.ends_at)

function describeEntry(e) {
  const c = e.changes ?? {}
  switch (e.action) {
    case 'booking.created': return `booked ${bookingSlot(e)} for ${guest(e)}${c.guest_email ? ` (${c.guest_email})` : ''}`
    case 'booking.cancelled':
      if (c.signature_status) return describeSignature(e, c) // declined / voided agreement
      return `cancelled ${guest(e)}'s booking on ${bookingSlot(e)}`
    case 'booking.deleted': return `removed ${guest(e)}'s booking on ${bookingSlot(e)}`
    case 'booking.updated':
      if (c.signature_status) return describeSignature(e, c)
      return `changed ${guest(e)}'s booking on ${bookingSlot(e)} (${Object.keys(c).join(', ')})`
    case 'slot.created': return `added the slot ${slotTime(e)}`
    case 'slot.moved': return `moved a slot from ${when(c.starts_at?.from, c.ends_at?.from)} to ${when(c.starts_at?.to, c.ends_at?.to)}`
    case 'slot.deleted': return `deleted the slot ${slotTime(e)}`
    case 'slot.updated': return `changed the slot ${slotTime(e)} (${Object.keys(c).join(', ')})`
    case 'series.created': return `started a weekly series (${e.context?.weeks ?? c.weeks} weeks)`
    case 'profile.created': return 'created the account'
    case 'profile.deleted': return 'deleted the account'
    case 'profile.updated':
      if (c.display_name) return `renamed the page "${c.display_name.from}" → "${c.display_name.to}"`
      if (c.avatar_path) return 'changed the profile picture'
      return `changed the profile (${Object.keys(c).join(', ')})`
    default: return e.action
  }
}

// Feature 4 (DocuSign): the agreement's progress. 'sending' is an internal step: not shown.
function describeSignature(e, c) {
  switch (c.signature_status.to) {
    case 'sending': return null
    case 'sent': return `sent the agreement to ${guest(e)} for ${bookingSlot(e)}`
    case 'completed': return `${guest(e)} signed the agreement: booking on ${bookingSlot(e)} confirmed`
    case 'declined': return `${guest(e)} declined the agreement: booking on ${bookingSlot(e)} cancelled`
    case 'voided': return `the agreement was voided: ${guest(e)}'s booking on ${bookingSlot(e)} cancelled`
    case 'failed': return `could not send the agreement for ${guest(e)}'s booking on ${bookingSlot(e)}${c.signature_error?.to ? `: ${c.signature_error.to}` : ''}`
    default: return `agreement for ${guest(e)}'s booking on ${bookingSlot(e)}: ${c.signature_status.to}`
  }
}

// Entries arrive newest first; entries from one transaction (same tx_id) are adjacent.
// One transaction = one line, e.g. a whole recurring booking.
export function groupHistory(entries, myId) {
  const groups = []
  for (const e of entries) {
    const last = groups.at(-1)
    if (last && last.txId === e.tx_id) last.entries.push(e)
    else groups.push({ txId: e.tx_id, at: e.created_at, entries: [e] })
  }
  return groups
    .map((g) => ({ ...g, who: describeActor(g.entries[0], myId), text: describeGroup(g.entries) }))
    .filter((g) => g.text) // hidden steps (e.g. DocuSign 'sending')
}

function describeGroup(entries) {
  const series = entries.find((e) => e.action === 'series.created')
  if (series) {
    // A recurring booking: series + one booking per week, all in one transaction.
    const weeks = entries.filter((e) => e.action === 'booking.created')
      .sort((a, b) => (a.context?.slot_starts_at ?? '').localeCompare(b.context?.slot_starts_at ?? ''))
    const first = weeks[0]
    return `booked ${weeks.length} weeks from ${first ? bookingSlot(first) : 'the first slot'} for ${guest(first ?? series)}`
  }
  if (entries.length === 1) return describeEntry(entries[0])
  // e.g. DocuSign sent one agreement for all weeks of a series: show it once.
  if (entries.every((e) => (e.action === 'booking.updated' || e.action === 'booking.cancelled') && e.changes?.signature_status)) {
    const first = [...entries].sort((a, b) => (a.context?.slot_starts_at ?? '').localeCompare(b.context?.slot_starts_at ?? ''))[0]
    const text = describeEntry(first)
    return text && `${text} (+${entries.length - 1} more week${entries.length > 2 ? 's' : ''})`
  }
  return [...new Set(entries.map(describeEntry).filter(Boolean))].join('; ')
}
