// Core promises under parallel requests (added in N2; the original test-rls.mjs has no such checks).
// Double booking and overlapping slots must be impossible even when requests arrive at once.
export const name = 'core-concurrency'

const at = (h) => new Date(Date.now() + h * 3600_000).toISOString()

export async function run(t, api) {
  const host = await api.signUpHost('race-host')
  const guest = await api.guest()

  t.section('Parallel requests')
  const slot = (await api.createSlot(host.s, { hostId: host.id, startsAt: at(10), endsAt: at(11) })).data
  const bookings = await Promise.all(Array.from({ length: 20 }, (_, n) =>
    api.book(guest, { slotId: slot.id, guestName: `Racer ${n}`, guestEmail: `racer${n}@example.com`, cancelToken: crypto.randomUUID() })))
  const accepted = bookings.filter((r) => r.ok).length
  t.check(`20 parallel bookings of one slot: exactly 1 accepted (${accepted})`, accepted === 1,
    JSON.stringify(bookings.filter((r) => !r.ok).map((r) => r.error.code)))

  const slots = await Promise.all(Array.from({ length: 10 }, (_, n) =>
    api.createSlot(host.s, { hostId: host.id, startsAt: at(20 + n * 0.1), endsAt: at(21 + n * 0.1) })))
  const created = slots.filter((r) => r.ok).length
  const errors = [...new Set(slots.filter((r) => !r.ok).map((r) => r.error.code))]
  t.check(`10 parallel overlapping slots of one host: exactly 1 created (${created})`, created === 1, JSON.stringify(errors))
  t.check(`…and the other 9 were refused as a conflict, not a server error (${errors.join(', ')})`, !errors.some((c) => /^5\d\d$/.test(c)), JSON.stringify(errors))
}
