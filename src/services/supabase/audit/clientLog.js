// Audit log, stage 1: the browser writes its own log entries (table audit_log_client).
// Every action below is TWO requests: the action itself, and the log entry. They can't be
// grouped (see feature 1, stage 1), so either one can succeed while the other fails.

// "guest@example.com" → "g***@example.com". Decided: no full emails in the log.
export function maskEmail(email) {
  const [name, domain] = String(email).split('@')
  return domain ? `${name.slice(0, 1)}***@${domain}` : '***'
}

// One log entry. actor_id / actor_role are filled in by the database from the JWT.
// fail: simulates a lost log request by sending a value the table's check constraint rejects.
export async function logEvent(db, { action, table, recordId = null, hostId = null, changes = {} }, { fail = false } = {}) {
  const { error } = await db.from('audit_log_client').insert({
    action,
    table_name: fail ? 'simulated_failure' : table,
    record_id: recordId,
    host_id: hostId,
    changes,
  })
  return { error }
}

// Run an action and log it, in the chosen order:
//   'act-first': do it, then log it (if it worked). Risk: action saved, log lost.
//   'log-first': log it, then do it. Risk: log says it happened, but the action failed.
async function withLog(db, act, describe, { order = 'act-first', failLog = false } = {}) {
  if (order === 'log-first') {
    const log = await logEvent(db, describe({}), { fail: failLog })
    // The point of logging first: no action without a record. If the log failed, stop.
    if (log.error) return { order, actError: null, logError: log.error, logged: false, acted: false }
    const result = await act()
    return { order, actError: result.error ?? null, logError: log.error, logged: !log.error, acted: !result.error }
  }
  const result = await act()
  if (result.error) return { order, actError: result.error, logError: null, logged: false, acted: false }
  const log = await logEvent(db, describe(result), { fail: failLog })
  return { order, actError: null, logError: log.error, logged: !log.error, acted: true }
}

// ---- guest actions ----

// Guests can't read bookings back (RLS), so the browser never learns the new booking's id:
// the log entry can only point at the slot.
export function bookSlotLogged(db, { hostId, slotId, guestName, guestEmail }, opts) {
  const cancelToken = crypto.randomUUID()
  return withLog(
    db,
    async () => {
      const { error } = await db.from('bookings').insert({ slot_id: slotId, guest_name: guestName, guest_email: guestEmail, cancel_token: cancelToken })
      return { error, cancelToken }
    },
    () => ({
      action: 'booking.created',
      table: 'bookings',
      hostId,
      changes: { slot_id: slotId, guest_name: guestName, guest_email: maskEmail(guestEmail) },
    }),
    opts,
  ).then((r) => ({ ...r, cancelToken: r.acted ? cancelToken : null }))
}

// Guest cancel goes through the cancel_booking rpc (by token). Again no booking id;
// the cancel token itself is a secret and must not be copied into the log.
export function cancelAsGuestLogged(db, { hostId, slotId, cancelToken }, opts) {
  return withLog(
    db,
    async () => {
      const { data: ok, error } = await db.rpc('cancel_booking', { p_cancel_token: cancelToken })
      return { error: error ?? (ok ? null : { code: 'not_cancelled', message: 'Booking not found, already cancelled, or started' }) }
    },
    () => ({
      action: 'booking.cancelled',
      table: 'bookings',
      hostId,
      changes: { slot_id: slotId, status: { from: 'confirmed', to: 'cancelled' } },
    }),
    opts,
  )
}

// ---- host actions (logged in) ----

export function cancelAsHostLogged(db, { hostId, bookingId }, opts) {
  return withLog(
    db,
    async () => {
      // .select() so an RLS-filtered update (0 rows, no error) is noticed.
      const { data, error } = await db.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId).eq('status', 'confirmed').select('id')
      return { error: error ?? (data.length ? null : { code: 'no_rows', message: 'Nothing cancelled (not yours, or already cancelled)' }) }
    },
    () => ({
      action: 'booking.cancelled',
      table: 'bookings',
      recordId: bookingId,
      hostId,
      changes: { status: { from: 'confirmed', to: 'cancelled' } },
    }),
    opts,
  )
}

export function deleteSlotLogged(db, { hostId, slot }, opts) {
  return withLog(
    db,
    async () => {
      const { data, error } = await db.from('slots').delete().eq('id', slot.id).select('id')
      return { error: error ?? (data.length ? null : { code: 'no_rows', message: 'Nothing deleted (booked, or not yours)' }) }
    },
    () => ({
      action: 'slot.deleted',
      table: 'slots',
      recordId: slot.id,
      hostId,
      changes: { starts_at: slot.starts_at, ends_at: slot.ends_at },
    }),
    opts,
  )
}
