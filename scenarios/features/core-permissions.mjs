// Core permissions: who may read and change slots, bookings, profiles and avatars.
// Ported from scripts/test-rls.mjs (same 60 checks, same order), written against the adapter
// instead of supabase-js, so the same file can test the NestJS backend.
//
// "blocked" = an error, or a write that changed nothing (empty result), the way a backend may
// report a refused update/delete.
export const name = 'core-permissions'

const hour = 3600_000
const at = (h) => new Date(Date.now() + h * hour).toISOString()
const blocked = (r) => !r.ok || (Array.isArray(r.data) && r.data.length === 0)
const guestKeys = (obj) => Object.keys(obj ?? {}).filter((k) => /guest|name|email/i.test(k))
const fmt = (r) => JSON.stringify(r.ok ? r.data : r.error)

export async function run(t, api) {
  const anon = await api.guest()
  const A = await api.signUpHost('host-a')
  const B = await api.signUpHost('host-b')

  t.section('Hosts and slots')
  let r = await api.createSlot(A.s, { hostId: A.id, startsAt: at(24), endsAt: at(25) })
  t.check('host creates own future slot', r.ok, fmt(r))
  const s1 = r.data
  const s2 = (await api.createSlot(A.s, { hostId: A.id, startsAt: at(26), endsAt: at(27) })).data
  const s3 = (await api.createSlot(A.s, { hostId: A.id, startsAt: at(48), endsAt: at(49) })).data

  r = await api.createSlot(A.s, { hostId: A.id, startsAt: at(-2), endsAt: at(-1) })
  t.check('host cannot create a slot in the past', blocked(r), fmt(r))
  r = await api.createSlot(A.s, { hostId: B.id, startsAt: at(30), endsAt: at(31) })
  t.check('host cannot create a slot for another host', blocked(r), fmt(r))
  r = await api.createSlot(A.s, { hostId: A.id, startsAt: at(60), endsAt: at(61), isBooked: true })
  t.check('host cannot set is_booked', blocked(r), fmt(r))
  r = await api.createSlot(anon, { hostId: A.id, startsAt: at(70), endsAt: at(71) })
  t.check('guest cannot create slots', blocked(r), fmt(r))

  t.section('Guest reads')
  r = await api.listFreeSlots(anon, A.id)
  t.check("guest sees host A's 3 free slots", r.data?.length === 3, fmt(r))
  r = await api.getHostProfile(anon, A.id)
  t.check('guest can read host profile (name)', r.data?.displayName === 'host-a', fmt(r))

  t.section('Guest books')
  const token1 = crypto.randomUUID()
  r = await api.book(anon, { slotId: s1.id, guestName: 'Guest One', guestEmail: 'g1@test.dev', cancelToken: token1 })
  t.check('guest books a free slot', r.ok, fmt(r))
  r = await api.book(anon, { slotId: s1.id, guestName: 'Guest Two', guestEmail: 'g2@test.dev', cancelToken: crypto.randomUUID() })
  t.check('second guest cannot book the same slot', blocked(r), fmt(r))
  r = await api.listFreeSlots(anon, A.id)
  t.check('booked slot disappears from guest view (2 left)', r.data?.length === 2, fmt(r))
  r = await api.book(anon, { slotId: s2.id, guestName: 'X', guestEmail: 'x@test.dev', cancelToken: crypto.randomUUID(), status: 'cancelled' })
  t.check('guest cannot set status on insert', blocked(r), fmt(r))
  r = await api.book(anon, { slotId: s2.id, guestName: 'X', guestEmail: 'not-an-email', cancelToken: crypto.randomUUID() })
  t.check('invalid guest email rejected', blocked(r), fmt(r))
  // Supabase mechanics: one request that inserts AND reads the row back. Guests may not read
  // bookings, so the whole request fails and the insert is rolled back.
  if (api.has('insertReadBack')) {
    r = await api.book(anon, { slotId: s3.id, guestName: 'X', guestEmail: 'x@test.dev', cancelToken: crypto.randomUUID(), readBack: true })
    t.check('guest cannot read back a booking (insert…select)', blocked(r), fmt(r))
    r = await api.getSlot(anon, s3.id)
    t.check('…and that failed insert…select left the slot free', !!r.data, fmt(r))
  } else {
    t.skip('guest cannot read back a booking (insert…select)', 'Supabase mechanics (insert + select in one request)')
    t.skip('…and that failed insert…select left the slot free', 'Supabase mechanics')
  }

  t.section('Guest cannot read or change bookings / slots / profiles')
  r = await api.listBookings(anon)
  t.check('guest cannot read bookings', blocked(r), fmt(r))
  r = await api.updateBooking(anon, s1.id, { status: 'cancelled' })
  t.check('guest cannot update bookings directly', blocked(r), fmt(r))
  r = await api.deleteBooking(anon, s1.id)
  t.check('guest cannot delete bookings', blocked(r), fmt(r))
  r = await api.updateSlot(anon, s1.id, { isBooked: false })
  t.check('guest cannot change is_booked', blocked(r), fmt(r))
  r = await api.deleteSlot(anon, s2.id)
  t.check('guest cannot delete slots', blocked(r), fmt(r))
  r = await api.updateProfile(anon, A.id, { displayName: 'hacked' })
  t.check('guest cannot edit profiles', blocked(r), fmt(r))
  r = await api.callInternal(anon)
  t.check('guest cannot call internal trigger functions', blocked(r), fmt(r))

  t.section("Other host (B) cannot touch host A's data")
  r = await api.listBookings(B.s)
  t.check('host B sees no bookings of host A', r.ok && r.data.length === 0, fmt(r))
  r = await api.getSlot(B.s, s1.id)
  t.check("host B cannot see A's booked slot", r.ok && !r.data, fmt(r))
  r = await api.updateSlot(B.s, s2.id, { startsAt: at(100), endsAt: at(101) })
  t.check("host B cannot move A's slot", blocked(r), fmt(r))
  r = await api.deleteSlot(B.s, s2.id)
  t.check("host B cannot delete A's slot", blocked(r), fmt(r))
  r = await api.updateBooking(B.s, s1.id, { status: 'cancelled' })
  t.check("host B cannot cancel A's booking", blocked(r), fmt(r))
  r = await api.updateProfile(B.s, A.id, { displayName: 'hacked' })
  t.check("host B cannot edit A's profile", blocked(r), fmt(r))

  t.section('Host A manages own data')
  r = await api.listBookings(A.s)
  t.check('host A sees the booking incl. guest name', r.data?.length === 1 && r.data[0].guestName === 'Guest One', fmt(r))
  r = await api.getSlot(A.s, s1.id)
  t.check('host A still sees own booked slot', r.data?.isBooked === true, fmt(r))
  r = await api.updateSlot(A.s, s1.id, { isBooked: false })
  t.check('host A cannot change is_booked', blocked(r), fmt(r))
  r = await api.deleteSlot(A.s, s1.id)
  t.check('host A cannot delete a booked slot', blocked(r), fmt(r))
  r = await api.updateSlot(A.s, s1.id, { startsAt: at(24.5), endsAt: at(25.5) })
  t.check('host A cannot move a booked slot', blocked(r), fmt(r))
  r = await api.updateSlot(A.s, s3.id, { startsAt: at(50), endsAt: at(51) })
  t.check('host A can move an unbooked slot', r.data?.length === 1, fmt(r))
  r = await api.updateBooking(A.s, s1.id, { guestEmail: 'changed@test.dev' })
  t.check('host A cannot edit guest details', blocked(r), fmt(r))
  r = await api.updateBooking(A.s, s1.id, { status: 'confirmed' })
  t.check('host A cannot set status to anything but cancelled', blocked(r), fmt(r))
  r = await api.updateProfile(A.s, A.id, { displayName: 'Host A renamed' })
  t.check('host A can edit own profile', r.data?.length === 1, fmt(r))
  r = await api.updateProfile(A.s, A.id, { id: B.id })
  t.check('host A cannot change profile id', blocked(r), fmt(r))

  t.section('Guest cancels with token')
  r = await api.cancelByToken(anon, crypto.randomUUID())
  t.check('wrong token → false', r.data === false, fmt(r))
  r = await api.cancelByToken(anon, token1)
  t.check('right token → true', r.data === true, fmt(r))
  r = await api.cancelByToken(anon, token1)
  t.check('same token again → false', r.data === false, fmt(r))
  r = await api.getSlot(anon, s1.id)
  t.check('cancelled slot is free again for guests', !!r.data, fmt(r))

  t.section('Host cancels a booking')
  const token3 = crypto.randomUUID()
  await api.book(anon, { slotId: s2.id, guestName: 'Guest Three', guestEmail: 'g3@test.dev', cancelToken: token3 })
  r = await api.bookingStatuses(anon, [token3])
  t.check('guest sees own booking status by token (confirmed)', r.data?.[0]?.status === 'confirmed', fmt(r))
  r = await api.updateBooking(A.s, s2.id, { status: 'cancelled' }, { onlyIfStatus: 'confirmed' })
  t.check('host A cancels booking; cancelled_at stamped by DB', r.data?.[0]?.status === 'cancelled' && !!r.data[0].cancelledAt, fmt(r))
  r = await api.bookingStatuses(anon, [token3, crypto.randomUUID()])
  t.check('guest learns the host cancelled; unknown token returns nothing', r.data?.length === 1 && r.data[0].status === 'cancelled', fmt(r))
  t.check('status lookup returns no guest data', !!r.data?.[0] && guestKeys(r.data[0]).length === 0, fmt(r))

  t.section('Live updates (slots of one host)')
  if (api.has('realtime')) {
    const guestEvents = []
    const guestCh = await api.subscribeSlots(A.id, (e) => guestEvents.push(e))
    const spyCh = await api.subscribeSlots(A.id, () => {})
    await t.sleep(300)
    const token4 = crypto.randomUUID()
    await api.book(anon, { slotId: s1.id, guestName: 'Guest Four', guestEmail: 'g4@test.dev', cancelToken: token4 })
    await t.sleep(1000)
    const ev = guestEvents.find((e) => e.id === s1.id)
    t.check('guest receives "slot no longer available" when it is booked', ev?.available === false, JSON.stringify(guestEvents))
    t.check('broadcast payload contains no guest data', !!ev && guestKeys(ev).length === 0 && Object.keys(ev).length === 4, JSON.stringify(ev))
    guestEvents.length = 0
    await spyCh.sendFake({ id: s2.id, available: false })
    await t.sleep(1000)
    t.check('clients cannot send fake broadcasts to other viewers', guestEvents.length === 0, JSON.stringify(guestEvents))
    await api.cancelByToken(anon, token4)
    await t.sleep(1000)
    t.check('guest receives "available again" after cancel', guestEvents.some((e) => e.id === s1.id && e.available), JSON.stringify(guestEvents))
    await guestCh.close()
    await spyCh.close()
  } else {
    for (const n of ['guest receives "slot no longer available" when it is booked', 'broadcast payload contains no guest data',
      'clients cannot send fake broadcasts to other viewers', 'guest receives "available again" after cancel']) t.skip(n, 'live updates not built in this backend yet')
  }

  t.section('Avatars')
  if (api.has('avatars')) {
    const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' })
    const aPath = `${A.id}/${crypto.randomUUID()}.png`
    const bPath = `${B.id}/${crypto.randomUUID()}.png`
    r = await api.avatarUpload(A.s, aPath, png)
    t.check('host uploads into own folder', r.ok, fmt(r))
    await api.avatarUpload(B.s, bPath, png)
    r = await api.avatarUpload(A.s, `${B.id}/${crypto.randomUUID()}.png`, png)
    t.check("host cannot upload into another host's folder", blocked(r), fmt(r))
    r = await api.avatarUpload(anon, `${A.id}/${crypto.randomUUID()}.png`, png)
    t.check('guest cannot upload', blocked(r), fmt(r))
    r = await api.avatarUpload(B.s, aPath, png, { upsert: true })
    t.check("host B cannot overwrite A's file", blocked(r), fmt(r))
    r = await api.avatarRemove(B.s, aPath)
    t.check("host B cannot delete A's file", blocked(r), fmt(r))
    r = await api.avatarUpload(A.s, `${A.id}/${crypto.randomUUID()}.html`, new Blob(['<script>alert(1)</script>'], { type: 'text/html' }))
    t.check('non-image MIME type rejected', blocked(r), fmt(r))
    r = await api.avatarUpload(A.s, `${A.id}/${crypto.randomUUID()}.png`, new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' }))
    t.check('file over 2 MB rejected', blocked(r), fmt(r))
    r = await api.updateProfile(A.s, A.id, { avatarPath: bPath })
    t.check("host cannot point avatar_path at another host's file", blocked(r), fmt(r))
    r = await api.updateProfile(A.s, A.id, { avatarPath: aPath })
    t.check('host sets avatar_path to own file', r.data?.length === 1, fmt(r))
    const pub = await fetch(api.avatarUrl(aPath))
    t.check('anyone can download via public URL', pub.status === 200 && pub.headers.get('content-type') === 'image/png', `${pub.status} ${pub.headers.get('content-type')}`)
    r = await api.avatarRemove(A.s, aPath)
    t.check('host deletes own file', r.data?.length === 1, fmt(r))
    await api.avatarRemove(B.s, bPath)
  } else {
    for (const n of ['host uploads into own folder', "host cannot upload into another host's folder", 'guest cannot upload',
      "host B cannot overwrite A's file", "host B cannot delete A's file", 'non-image MIME type rejected', 'file over 2 MB rejected',
      "host cannot point avatar_path at another host's file", 'host sets avatar_path to own file', 'anyone can download via public URL',
      'host deletes own file']) t.skip(n, 'avatars not built in this backend yet')
  }
}
