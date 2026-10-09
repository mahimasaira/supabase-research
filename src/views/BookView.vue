<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import { formatDate, formatRange, formatSlot } from '@/lib/format'
import { forgetGuestBooking, loadGuestBookings, rememberGuestBooking } from '@/lib/guestBookings'
import { useSlotChannel } from '@/composables/useSlotChannel'
import { avatarUrl } from '@/lib/avatars'

const route = useRoute()
const hostId = route.params.hostId

const host = ref(null)
const slots = ref([])
const loading = ref(true)
const notFound = ref(false)
const error = ref('')

async function loadHost() {
  const { data, error: err } = await supabase.from('profiles').select('display_name, avatar_path').eq('id', hostId).maybeSingle()
  // A malformed id gives a 22P02 (invalid uuid) error; treat it the same as "no such host".
  if (err || !data) notFound.value = true
  else host.value = data
}

// RLS already limits guests to free, future slots. The explicit filters matter when the
// host views their own page: their "read own slots" policy would also return booked ones.
async function loadSlots() {
  const { data, error: err } = await supabase
    .from('slots')
    .select('id, starts_at, ends_at')
    .eq('host_id', hostId)
    .eq('is_booked', false)
    .gt('starts_at', new Date().toISOString())
    .order('starts_at')
  if (err) error.value = friendlyError(err)
  else slots.value = data
}

onMounted(async () => {
  await loadHost()
  if (!notFound.value) await Promise.all([loadSlots(), refreshStatuses()])
  loading.value = false
})

// ---- realtime ----
const takenNotice = ref('')

function applySlotChange(change) {
  const rest = slots.value.filter((s) => s.id !== change.id)
  if (change.available) {
    // A slot became free again: possibly because the host cancelled *our* booking.
    refreshStatuses()
    slots.value = [...rest, { id: change.id, starts_at: change.starts_at, ends_at: change.ends_at }]
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    return
  }
  slots.value = rest
  // Someone else booked (or the host removed) the slot this guest was about to book.
  if (selected.value?.id === change.id && !booking.value) {
    selected.value = null
    takenNotice.value = 'The slot you picked was just taken. Please choose another one.'
  }
}

useSlotChannel(hostId, {
  onChange: applySlotChange,
  onSync: () => {
    if (!host.value) return
    loadSlots()
    refreshStatuses()
  },
})

const slotsByDay = computed(() => {
  const groups = new Map()
  for (const s of slots.value) {
    const day = formatDate(s.starts_at)
    if (!groups.has(day)) groups.set(day, [])
    groups.get(day).push(s)
  }
  return [...groups]
})

// ---- book ----
const selected = ref(null)
const guestName = ref('')
const guestEmail = ref('')
const booking = ref(false)
const bookError = ref('')
const confirmation = ref(null)

async function book() {
  bookError.value = ''
  booking.value = true
  // Guests can't read bookings back (no SELECT policy), so the browser makes the
  // cancel token itself and sends it along. No .select() after insert, on purpose.
  const cancelToken = crypto.randomUUID()
  const slot = selected.value
  const { error: err } = await supabase.from('bookings').insert({
    slot_id: slot.id,
    guest_name: guestName.value,
    guest_email: guestEmail.value,
    cancel_token: cancelToken,
  })
  booking.value = false
  if (err) {
    // 42501: insert policy failed, the slot is no longer free (or no longer in the future).
    // 23505: two guests submitted at the same moment and the unique index picked the other one.
    const taken = 'Sorry, this slot was just taken. Please pick another one.'
    bookError.value = friendlyError(err, {
      42501: taken,
      23505: taken,
      23514: 'Please check your name and email.',
    })
    if (err.code === '42501' || err.code === '23505') {
      selected.value = null
      loadSlots()
    }
    return
  }
  const entry = { cancelToken, hostId, hostName: host.value.display_name, startsAt: slot.starts_at, endsAt: slot.ends_at }
  rememberGuestBooking(entry)
  myBookings.value = loadGuestBookings()
  confirmation.value = { ...entry, cancelUrl: `${window.location.origin}/cancel/${cancelToken}` }
  selected.value = null
  guestName.value = ''
  guestEmail.value = ''
  loadSlots()
}

// ---- my bookings (this browser) ----
const myBookings = ref(loadGuestBookings())
const myBookingsHere = computed(() =>
  myBookings.value.filter((b) => b.hostId === hostId && b.endsAt > new Date().toISOString()),
)
const cancelMessage = ref('')

// Guests can't read bookings, so ask the get_booking_statuses RPC about the
// cancel tokens this browser holds. Token → 'confirmed' | 'cancelled' | 'missing'.
const statuses = ref({})
const isActive = (b) => (statuses.value[b.cancelToken] ?? 'confirmed') === 'confirmed'

async function refreshStatuses() {
  const tokens = myBookingsHere.value.map((b) => b.cancelToken)
  if (tokens.length === 0) return
  const { data, error: err } = await supabase.rpc('get_booking_statuses', { p_cancel_tokens: tokens })
  if (err) return console.warn('Could not refresh booking statuses:', err.message)
  const found = Object.fromEntries(data.map((row) => [row.cancel_token, row.status]))
  statuses.value = Object.fromEntries(tokens.map((t) => [t, found[t] ?? 'missing']))
  if (confirmation.value && !isActive(confirmation.value)) confirmation.value = null
}

function dismiss(b) {
  forgetGuestBooking(b.cancelToken)
  myBookings.value = loadGuestBookings()
}

async function cancel(b) {
  if (!confirm(`Cancel your booking on ${formatSlot({ starts_at: b.startsAt, ends_at: b.endsAt })}?`)) return
  cancelMessage.value = ''
  const { data: ok, error: err } = await supabase.rpc('cancel_booking', { p_cancel_token: b.cancelToken })
  if (err) {
    cancelMessage.value = friendlyError(err)
    return
  }
  // false = token unknown, already cancelled (maybe by the host), or the slot already started.
  cancelMessage.value = ok
    ? 'Your booking was cancelled.'
    : 'This booking could not be cancelled. It may already be cancelled, or the slot has started.'
  forgetGuestBooking(b.cancelToken)
  myBookings.value = loadGuestBookings()
  if (confirmation.value?.cancelToken === b.cancelToken) confirmation.value = null
  loadSlots()
}
</script>

<template>
  <p v-if="loading" class="text-gray-500">Loading…</p>
  <p v-else-if="notFound" class="text-gray-700">This booking page doesn't exist.</p>
  <div v-else class="space-y-8">
    <div class="flex items-center gap-4">
      <img v-if="host.avatar_path" :src="avatarUrl(host.avatar_path)" alt="" class="h-16 w-16 rounded-full object-cover" />
      <h1 class="text-2xl font-semibold">Book a time with {{ host.display_name || 'this host' }}</h1>
    </div>

    <div v-if="confirmation" class="space-y-1 rounded border border-green-300 bg-green-50 p-3">
      <p class="font-semibold text-green-800">
        Booked: {{ formatSlot({ starts_at: confirmation.startsAt, ends_at: confirmation.endsAt }) }}
      </p>
      <p class="text-sm">
        Keep this link to cancel from any device:
        <a class="break-all underline" :href="confirmation.cancelUrl">{{ confirmation.cancelUrl }}</a>
      </p>
    </div>

    <section v-if="myBookingsHere.length" class="space-y-2">
      <h2 class="text-lg font-semibold">Your bookings (this browser)</h2>
      <ul class="divide-y rounded border">
        <li v-for="b in myBookingsHere" :key="b.cancelToken" class="flex items-center justify-between gap-3 p-3">
          <span :class="{ 'text-gray-400 line-through': !isActive(b) }">
            {{ formatSlot({ starts_at: b.startsAt, ends_at: b.endsAt }) }}
          </span>
          <button v-if="isActive(b)" class="text-sm text-red-700 underline" @click="cancel(b)">Cancel</button>
          <span v-else class="flex items-center gap-3 text-sm">
            <span class="text-amber-700">Cancelled</span>
            <button class="underline" @click="dismiss(b)">Dismiss</button>
          </span>
        </li>
      </ul>
    </section>
    <p v-if="cancelMessage" class="text-sm">{{ cancelMessage }}</p>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold">Free slots</h2>
      <p v-if="error" class="text-red-700">{{ error }}</p>
      <p v-if="takenNotice" class="text-amber-700">{{ takenNotice }}</p>
      <p v-if="slots.length === 0" class="text-gray-500">No free slots right now.</p>
      <div v-for="[day, daySlots] in slotsByDay" :key="day" class="space-y-1">
        <h3 class="text-sm font-medium text-gray-600">{{ day }}</h3>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="s in daySlots"
            :key="s.id"
            class="rounded border px-3 py-1 text-sm"
            :class="selected?.id === s.id ? 'border-gray-900 bg-gray-900 text-white' : 'hover:bg-gray-100'"
            @click="selected = s; bookError = ''; takenNotice = ''"
          >
            {{ formatRange(s.starts_at, s.ends_at) }}
          </button>
        </div>
      </div>
    </section>

    <form v-if="selected" class="max-w-sm space-y-3 rounded border p-4" @submit.prevent="book">
      <p class="font-medium">{{ formatSlot(selected) }}</p>
      <input v-model="guestName" class="input" placeholder="Your name" required maxlength="100" />
      <input v-model="guestEmail" class="input" type="email" placeholder="Your email" required />
      <button class="btn" :disabled="booking">{{ booking ? 'Booking…' : 'Book this slot' }}</button>
    </form>
    <p v-if="bookError" class="text-red-700">{{ bookError }}</p>
  </div>
</template>
