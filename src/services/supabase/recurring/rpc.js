// Stage 2: recurring booking as ONE call to the Postgres function book_recurring
// (migration 20261012071039_recurring_bookings_rpc.sql). The whole loop runs inside the
// database in a single transaction, so a clash rolls back everything.

export async function bookRecurringRpc(db, { hostId, firstSlot, weeks, guestName, guestEmail }) {
  const { data, error } = await db.rpc('book_recurring', {
    p_host_id: hostId,
    p_first_starts_at: firstSlot.starts_at,
    p_weeks: weeks,
    p_guest_name: guestName,
    p_guest_email: guestEmail,
  })

  if (error) {
    // The function raised, so Postgres rolled back all its writes. The client can't read the
    // tables to double-check (guests have no SELECT); check.sql in Studio is the proof.
    const saved = { seriesId: null, weeks: [] }
    const detail = parseDetail(error.details)
    if (error.code === 'RB001') {
      return { ok: false, clash: { week: detail.week, startsAt: detail.starts_at, reason: detail.reason }, error, saved }
    }
    if (error.code === 'RB002') {
      return { ok: false, clash: null, notEnoughWeeks: { requested: detail.requested, available: detail.available }, saved }
    }
    return { ok: false, clash: null, error, saved }
  }

  return { ok: true, seriesId: data.seriesId, weeks: data.weeks, saved: data }
}

function parseDetail(details) {
  try {
    return JSON.parse(details) ?? {}
  } catch {
    return {}
  }
}
