// Stage 1: recurring booking as SEPARATE supabase-js calls from the browser.
// Deliberately naive, to show the problem: every call is its own HTTP request and its
// own database transaction, committed the moment it returns. supabase-js has no way to
// group them. If week 4 fails, the series row and weeks 1-3 are already saved.
//
//   call 1:        insert booking_series
//   call 2..2N+1:  per week: look up that week's free slot, insert the booking
//                  (the slot is marked taken by the database trigger in the same statement)

const WEEK_MS = 7 * 24 * 3600_000

// How many weeks the host offers from `first` on: the last visible slot at the same weekday
// and time (same UTC instant + whole weeks). Read-only, so it can run before any write.
// Guests only see FREE slots, so if the host's last week is booked, this counts one week less.
async function weeksOffered(db, hostId, first) {
  const { data, error } = await db
    .from('slots')
    .select('starts_at')
    .eq('host_id', hostId)
    .gte('starts_at', first.toISOString())
  if (error) return { error }
  const sameTime = data
    .map((s) => new Date(s.starts_at).getTime() - first.getTime())
    .filter((diff) => diff % WEEK_MS === 0)
  return { count: Math.max(0, ...sameTime) / WEEK_MS + 1 }
}

export async function bookRecurringSplit(db, { hostId, firstSlot, weeks, guestName, guestEmail }) {
  // Week N = week 1 + (N-1) × 7 days, computed on the UTC instant, so the guest's time zone
  // doesn't matter. (Slots are stored in UTC; local-time/DST handling is feature 6.)
  const first = new Date(firstSlot.starts_at)
  // Guests can't read rows back (no SELECT policy), so the browser makes the ids itself.
  const seriesId = crypto.randomUUID()
  const saved = { seriesId: null, weeks: [] }

  // Not a clash: the host simply doesn't offer that many weeks from this date.
  const offered = await weeksOffered(db, hostId, first)
  if (offered.error) return { ok: false, clash: null, error: offered.error, saved }
  if (offered.count < weeks) {
    return { ok: false, clash: null, notEnoughWeeks: { requested: weeks, available: offered.count }, saved }
  }

  const { error: seriesErr } = await db.from('booking_series').insert({
    id: seriesId,
    host_id: hostId,
    guest_name: guestName,
    guest_email: guestEmail,
    weekday: first.getUTCDay(),
    start_time: first.toISOString().slice(11, 16), // "HH:MM" in UTC
    weeks,
  })
  if (seriesErr) return { ok: false, clash: null, error: seriesErr, saved }
  saved.seriesId = seriesId

  for (let week = 1; week <= weeks; week++) {
    const startsAt = new Date(first.getTime() + (week - 1) * WEEK_MS).toISOString()

    // Guests only ever see free, future slots (RLS), so a booked week and a week the host
    // never offered look exactly the same from here: no row.
    const { data: slot, error: findErr } = await db
      .from('slots')
      .select('id')
      .eq('host_id', hostId)
      .eq('starts_at', startsAt)
      .eq('is_booked', false)
      .maybeSingle()
    if (findErr) return { ok: false, clash: null, error: findErr, saved }
    if (!slot) return { ok: false, clash: { week, startsAt, reason: 'not available' }, saved }

    const cancelToken = crypto.randomUUID()
    const { error: bookErr } = await db.from('bookings').insert({
      slot_id: slot.id,
      guest_name: guestName,
      guest_email: guestEmail,
      cancel_token: cancelToken,
      series_id: seriesId,
      week_no: week,
    })
    if (bookErr) {
      // 42501 (insert policy) / 23505 (unique index): someone booked it between our two calls.
      const taken = bookErr.code === '42501' || bookErr.code === '23505'
      return taken
        ? { ok: false, clash: { week, startsAt, reason: 'just taken' }, error: bookErr, saved }
        : { ok: false, clash: null, error: bookErr, saved }
    }
    saved.weeks.push({ week, startsAt, cancelToken })
  }

  return { ok: true, seriesId, weeks: saved.weeks, saved }
}
