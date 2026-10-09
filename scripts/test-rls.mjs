// RLS / permission checks, run through supabase-js with ONLY the publishable key,
// exactly like the browser. Run: npm run test:rls   (local Supabase must be running)
// Each run signs up two fresh hosts, so it never touches your own data.
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY
const client = () => createClient(url, key, { auth: { persistSession: false } })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  const show = detail && (!ok || process.env.VERBOSE)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${show ? `\n      → ${detail}` : ''}`)
}
const fmt = (r) => JSON.stringify(r.error ? { code: r.error.code, message: r.error.message } : r.data)
// "blocked" = an error, or a write that silently affected 0 rows (how RLS reports a filtered update/delete).
const blocked = (r) => !!r.error || (Array.isArray(r.data) && r.data.length === 0)

const hour = 3600_000
const at = (h) => new Date(Date.now() + h * hour).toISOString()
const run = Date.now()

async function host(name) {
  const c = client()
  const { data, error } = await c.auth.signUp({
    email: `${name}-${run}@test.dev`,
    password: 'secret123',
    options: { data: { display_name: name } },
  })
  if (error) throw error
  return { c, id: data.user.id }
}

const anon = client()
const A = await host('host-a')
const B = await host('host-b')

console.log('\n# Hosts and slots')
let r = await A.c.from('slots').insert({ host_id: A.id, starts_at: at(24), ends_at: at(25) }).select().single()
check('host creates own future slot', !r.error, fmt(r))
const s1 = r.data
r = await A.c.from('slots').insert({ host_id: A.id, starts_at: at(26), ends_at: at(27) }).select().single()
const s2 = r.data
r = await A.c.from('slots').insert({ host_id: A.id, starts_at: at(48), ends_at: at(49) }).select().single()
const s3 = r.data

r = await A.c.from('slots').insert({ host_id: A.id, starts_at: at(-2), ends_at: at(-1) })
check('host cannot create a slot in the past', blocked(r), fmt(r))
r = await A.c.from('slots').insert({ host_id: B.id, starts_at: at(30), ends_at: at(31) })
check('host cannot create a slot for another host', blocked(r), fmt(r))
r = await A.c.from('slots').insert({ host_id: A.id, starts_at: at(60), ends_at: at(61), is_booked: true })
check('host cannot set is_booked', blocked(r), fmt(r))
r = await anon.from('slots').insert({ host_id: A.id, starts_at: at(70), ends_at: at(71) })
check('guest cannot create slots', blocked(r), fmt(r))

console.log('\n# Guest reads')
r = await anon.from('slots').select('id').eq('host_id', A.id)
check('guest sees host A\'s 3 free slots', r.data?.length === 3, fmt(r))
r = await anon.from('profiles').select('display_name').eq('id', A.id).single()
check('guest can read host profile (name)', r.data?.display_name === 'host-a', fmt(r))

console.log('\n# Guest books')
const token1 = crypto.randomUUID()
r = await anon.from('bookings').insert({ slot_id: s1.id, guest_name: 'Guest One', guest_email: 'g1@test.dev', cancel_token: token1 })
check('guest books a free slot', !r.error, fmt(r))
r = await anon.from('bookings').insert({ slot_id: s1.id, guest_name: 'Guest Two', guest_email: 'g2@test.dev', cancel_token: crypto.randomUUID() })
check('second guest cannot book the same slot', blocked(r), fmt(r))
r = await anon.from('slots').select('id').eq('host_id', A.id)
check('booked slot disappears from guest view (2 left)', r.data?.length === 2, fmt(r))
r = await anon.from('bookings').insert({ slot_id: s2.id, guest_name: 'X', guest_email: 'x@test.dev', cancel_token: crypto.randomUUID(), status: 'cancelled' })
check('guest cannot set status on insert', blocked(r), fmt(r))
r = await anon.from('bookings').insert({ slot_id: s2.id, guest_name: 'X', guest_email: 'not-an-email', cancel_token: crypto.randomUUID() })
check('invalid guest email rejected', blocked(r), fmt(r))
r = await anon.from('bookings').insert({ slot_id: s3.id, guest_name: 'X', guest_email: 'x@test.dev', cancel_token: crypto.randomUUID() }).select()
check('guest cannot read back a booking (insert…select)', blocked(r), fmt(r))
r = await anon.from('slots').select('id').eq('id', s3.id)
check('…and that failed insert…select left the slot free', r.data?.length === 1, fmt(r))

console.log('\n# Guest cannot read or change bookings / slots / profiles')
r = await anon.from('bookings').select('*')
check('guest cannot read bookings', blocked(r), fmt(r))
r = await anon.from('bookings').update({ status: 'cancelled' }).eq('slot_id', s1.id).select()
check('guest cannot update bookings directly', blocked(r), fmt(r))
r = await anon.from('bookings').delete().eq('slot_id', s1.id).select()
check('guest cannot delete bookings', blocked(r), fmt(r))
r = await anon.from('slots').update({ is_booked: false }).eq('id', s1.id).select()
check('guest cannot change is_booked', blocked(r), fmt(r))
r = await anon.from('slots').delete().eq('id', s2.id).select()
check('guest cannot delete slots', blocked(r), fmt(r))
r = await anon.from('profiles').update({ display_name: 'hacked' }).eq('id', A.id).select()
check('guest cannot edit profiles', blocked(r), fmt(r))
r = await anon.rpc('sync_slot_is_booked')
check('guest cannot call internal trigger functions', blocked(r), fmt(r))

console.log('\n# Other host (B) cannot touch host A\'s data')
r = await B.c.from('bookings').select('*')
check('host B sees no bookings of host A', r.data?.length === 0, fmt(r))
r = await B.c.from('slots').select('id').eq('id', s1.id)
check('host B cannot see A\'s booked slot', r.data?.length === 0, fmt(r))
r = await B.c.from('slots').update({ starts_at: at(100), ends_at: at(101) }).eq('id', s2.id).select()
check('host B cannot move A\'s slot', blocked(r), fmt(r))
r = await B.c.from('slots').delete().eq('id', s2.id).select()
check('host B cannot delete A\'s slot', blocked(r), fmt(r))
r = await B.c.from('bookings').update({ status: 'cancelled' }).eq('slot_id', s1.id).select()
check('host B cannot cancel A\'s booking', blocked(r), fmt(r))
r = await B.c.from('profiles').update({ display_name: 'hacked' }).eq('id', A.id).select()
check('host B cannot edit A\'s profile', blocked(r), fmt(r))

console.log('\n# Host A manages own data')
r = await A.c.from('bookings').select('guest_name, slot_id')
check('host A sees the booking incl. guest name', r.data?.length === 1 && r.data[0].guest_name === 'Guest One', fmt(r))
r = await A.c.from('slots').select('id, is_booked').eq('id', s1.id)
check('host A still sees own booked slot', r.data?.[0]?.is_booked === true, fmt(r))
r = await A.c.from('slots').update({ is_booked: false }).eq('id', s1.id).select()
check('host A cannot change is_booked', blocked(r), fmt(r))
r = await A.c.from('slots').delete().eq('id', s1.id).select()
check('host A cannot delete a booked slot', blocked(r), fmt(r))
r = await A.c.from('slots').update({ starts_at: at(24.5), ends_at: at(25.5) }).eq('id', s1.id).select()
check('host A cannot move a booked slot', blocked(r), fmt(r))
r = await A.c.from('slots').update({ starts_at: at(50), ends_at: at(51) }).eq('id', s3.id).select()
check('host A can move an unbooked slot', r.data?.length === 1, fmt(r))
r = await A.c.from('bookings').update({ guest_email: 'changed@test.dev' }).eq('slot_id', s1.id).select()
check('host A cannot edit guest details', blocked(r), fmt(r))
r = await A.c.from('bookings').update({ status: 'confirmed' }).eq('slot_id', s1.id).select()
check('host A cannot set status to anything but cancelled', blocked(r), fmt(r))
r = await A.c.from('profiles').update({ display_name: 'Host A renamed' }).eq('id', A.id).select()
check('host A can edit own profile', r.data?.length === 1, fmt(r))
r = await A.c.from('profiles').update({ id: B.id }).eq('id', A.id).select()
check('host A cannot change profile id', blocked(r), fmt(r))

console.log('\n# Guest cancels with token')
r = await anon.rpc('cancel_booking', { p_cancel_token: crypto.randomUUID() })
check('wrong token → false', r.data === false, fmt(r))
r = await anon.rpc('cancel_booking', { p_cancel_token: token1 })
check('right token → true', r.data === true, fmt(r))
r = await anon.rpc('cancel_booking', { p_cancel_token: token1 })
check('same token again → false', r.data === false, fmt(r))
r = await anon.from('slots').select('id').eq('id', s1.id)
check('cancelled slot is free again for guests', r.data?.length === 1, fmt(r))

console.log('\n# Host cancels a booking')
const token3 = crypto.randomUUID()
await anon.from('bookings').insert({ slot_id: s2.id, guest_name: 'Guest Three', guest_email: 'g3@test.dev', cancel_token: token3 })
r = await anon.rpc('get_booking_statuses', { p_cancel_tokens: [token3] })
check('guest sees own booking status by token (confirmed)', r.data?.[0]?.status === 'confirmed', fmt(r))
r = await A.c.from('bookings').update({ status: 'cancelled' }).eq('slot_id', s2.id).eq('status', 'confirmed').select('status, cancelled_at')
check('host A cancels booking; cancelled_at stamped by DB', r.data?.[0]?.status === 'cancelled' && !!r.data[0].cancelled_at, fmt(r))
r = await anon.rpc('get_booking_statuses', { p_cancel_tokens: [token3, crypto.randomUUID()] })
check('guest learns the host cancelled; unknown token returns nothing', r.data?.length === 1 && r.data[0].status === 'cancelled', fmt(r))
check('status lookup returns no guest data', r.data && Object.keys(r.data[0]).sort().join() === 'cancel_token,status', fmt(r))

console.log('\n# Realtime broadcast (slots:<host_id>)')
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
async function listen(c, topic, into) {
  const ch = c.channel(topic, { config: { private: true } })
    .on('broadcast', { event: 'slot_changed' }, ({ payload }) => into.push(payload))
  await new Promise((res, rej) => ch.subscribe((s, err) => (s === 'SUBSCRIBED' ? res() : err && rej(err))))
  return ch
}
const guestEvents = []
const guestCh = await listen(client(), `slots:${A.id}`, guestEvents)
const spyEvents = []
const spyCh = await listen(client(), `slots:${A.id}`, spyEvents)
await sleep(300)
const token4 = crypto.randomUUID()
await anon.from('bookings').insert({ slot_id: s1.id, guest_name: 'Guest Four', guest_email: 'g4@test.dev', cancel_token: token4 })
await sleep(1000)
const ev = guestEvents.find((e) => e.id === s1.id)
check('guest receives "slot no longer available" when it is booked', ev?.available === false, JSON.stringify(guestEvents))
check('broadcast payload contains no guest data', ev && Object.keys(ev).sort().join() === 'available,ends_at,id,starts_at', JSON.stringify(ev))
guestEvents.length = 0
await spyCh.send({ type: 'broadcast', event: 'slot_changed', payload: { id: s2.id, available: false } })
await sleep(1000)
check('clients cannot send fake broadcasts to other viewers', guestEvents.length === 0, JSON.stringify(guestEvents))
await anon.rpc('cancel_booking', { p_cancel_token: token4 })
await sleep(1000)
check('guest receives "available again" after cancel', guestEvents.some((e) => e.id === s1.id && e.available), JSON.stringify(guestEvents))
await guestCh.unsubscribe()
await spyCh.unsubscribe()

console.log('\n# Storage: avatars bucket')
// 1x1 transparent PNG
const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' })
const aPath = `${A.id}/${crypto.randomUUID()}.png`
const bPath = `${B.id}/${crypto.randomUUID()}.png`
const up = (c, path, body = png, opts = {}) => c.storage.from('avatars').upload(path, body, { contentType: body.type, ...opts })

r = await up(A.c, aPath)
check('host uploads into own folder', !r.error, fmt(r))
r = await up(B.c, bPath)
r = await up(A.c, `${B.id}/${crypto.randomUUID()}.png`)
check('host cannot upload into another host\'s folder', blocked(r), fmt(r))
r = await up(anon, `${A.id}/${crypto.randomUUID()}.png`)
check('guest cannot upload', blocked(r), fmt(r))
r = await up(B.c, aPath, png, { upsert: true })
check('host B cannot overwrite A\'s file', blocked(r), fmt(r))
r = await B.c.storage.from('avatars').remove([aPath])
check('host B cannot delete A\'s file', blocked(r), fmt(r))
r = await up(A.c, `${A.id}/${crypto.randomUUID()}.html`, new Blob(['<script>alert(1)</script>'], { type: 'text/html' }))
check('non-image MIME type rejected', blocked(r), fmt(r))
r = await up(A.c, `${A.id}/${crypto.randomUUID()}.png`, new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' }))
check('file over 2 MB rejected', blocked(r), fmt(r))
r = await A.c.from('profiles').update({ avatar_path: bPath }).eq('id', A.id).select()
check('host cannot point avatar_path at another host\'s file', blocked(r), fmt(r))
r = await A.c.from('profiles').update({ avatar_path: aPath }).eq('id', A.id).select()
check('host sets avatar_path to own file', r.data?.length === 1, fmt(r))
const pub = await fetch(anon.storage.from('avatars').getPublicUrl(aPath).data.publicUrl)
check('anyone can download via public URL', pub.status === 200 && pub.headers.get('content-type') === 'image/png', `${pub.status} ${pub.headers.get('content-type')}`)
r = await A.c.storage.from('avatars').remove([aPath])
check('host deletes own file', r.data?.length === 1, fmt(r))
// Clean up B's file through the Storage API. Deleting the user later (npm run test:clean)
// would NOT remove it: files outlive their owner, and SQL deletes on storage.objects are blocked.
await B.c.storage.from('avatars').remove([bPath])

const failed = results.filter((x) => !x.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
