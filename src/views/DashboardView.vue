<script setup>
import { computed, onMounted, ref } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/composables/useAuth'
import { friendlyError } from '@/lib/errors'
import { formatSlot } from '@/lib/format'
import { useSlotChannel } from '@/composables/useSlotChannel'
import ProfileCard from '@/components/ProfileCard.vue'
import SignatureSetting from '@/features/docusign/SignatureSetting.vue'

const { user } = useAuth()

const slots = ref([])
const loading = ref(true)
const error = ref('')

// user goes null for a moment on logout, before the router leaves this page.
const bookingPath = computed(() => (user.value ? `/book/${user.value.id}` : ''))
const bookingUrl = computed(() => window.location.origin + bookingPath.value)

// RLS returns only this host's slots plus other hosts' free ones, so filter on host_id.
// `bookings(...)` is a PostgREST embed: it follows the slot_id foreign key, and RLS
// on bookings still applies (a host only sees bookings on their own slots).
async function load() {
  error.value = ''
  const { data, error: err } = await supabase
    .from('slots')
    .select('id, starts_at, ends_at, is_booked, bookings(id, guest_name, guest_email, status, created_at, cancelled_at)')
    .eq('host_id', user.value.id)
    .order('starts_at')
  if (err) error.value = friendlyError(err)
  else slots.value = data
  loading.value = false
}
onMounted(load)

// Live updates: the broadcast only says "slot X changed" (no guest data),
// so refetch to get the booking details through the normal RLS-protected query.
useSlotChannel(user.value.id, { onChange: load })

const now = () => new Date().toISOString()
const upcomingSlots = computed(() => slots.value.filter((s) => s.ends_at > now()))
const allBookings = computed(() =>
  slots.value
    .flatMap((s) => s.bookings.map((b) => ({ ...b, slot: s })))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)),
)
// A booking waiting for the guest's signature (feature 4) holds the slot too.
const activeBooking = (slot) => slot.bookings.find((b) => b.status === 'confirmed' || b.status === 'pending_signature')

// ---- create slot ----
const start = ref('')
const duration = ref(30)
const creating = ref(false)
const createError = ref('')

// <input type="datetime-local"> gives local time without zone; new Date() interprets it
// as local time and toISOString() converts to UTC for the timestamptz column.
async function createSlot() {
  createError.value = ''
  creating.value = true
  const startsAt = new Date(start.value)
  const endsAt = new Date(startsAt.getTime() + duration.value * 60_000)
  const { error: err } = await supabase.from('slots').insert({
    host_id: user.value.id,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
  })
  creating.value = false
  if (err) {
    // 42501 here = the insert policy's with-check failed, i.e. the slot is in the past.
    createError.value = friendlyError(err, { 42501: 'Slots must start in the future.' })
    return
  }
  start.value = ''
  load()
}

// ---- delete slot / cancel booking ----
// RLS-blocked updates/deletes don't error, they just affect 0 rows,
// so ask for the affected rows back with .select() and check the count.
async function deleteSlot(slot) {
  if (!confirm(`Delete slot ${formatSlot(slot)}?`)) return
  const { data, error: err } = await supabase.from('slots').delete().eq('id', slot.id).select('id')
  if (err) error.value = friendlyError(err)
  else if (data.length === 0) error.value = 'Could not delete: the slot was booked in the meantime. Cancel the booking first.'
  load()
}

async function cancelBooking(booking) {
  if (!confirm(`Cancel ${booking.guest_name}'s booking?`)) return
  const { data, error: err } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', booking.id)
    .in('status', ['confirmed', 'pending_signature'])
    .select('id')
  if (err) error.value = friendlyError(err)
  else if (data.length === 0) error.value = 'That booking was already cancelled.'
  load()
}
</script>

<template>
  <div v-if="user" class="space-y-8">
    <section class="space-y-1">
      <h1 class="text-2xl font-semibold">Dashboard</h1>
      <p class="text-sm">
        Your public booking page:
        <RouterLink class="underline break-all" :to="bookingPath">{{ bookingUrl }}</RouterLink>
      </p>
    </section>

    <ProfileCard :user-id="user.id" />
    <SignatureSetting :user-id="user.id" />

    <p v-if="error" class="rounded bg-red-50 p-2 text-red-700">{{ error }}</p>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold">New slot</h2>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="createSlot">
        <label class="text-sm">
          Start
          <input v-model="start" class="input" type="datetime-local" required />
        </label>
        <label class="text-sm">
          Duration
          <select v-model.number="duration" class="input">
            <option :value="15">15 min</option>
            <option :value="30">30 min</option>
            <option :value="45">45 min</option>
            <option :value="60">60 min</option>
          </select>
        </label>
        <button class="btn" :disabled="creating">{{ creating ? 'Adding…' : 'Add slot' }}</button>
      </form>
      <p v-if="createError" class="text-red-700">{{ createError }}</p>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold">Upcoming slots</h2>
      <p v-if="loading" class="text-gray-500">Loading…</p>
      <p v-else-if="upcomingSlots.length === 0" class="text-gray-500">No upcoming slots.</p>
      <ul v-else class="divide-y rounded border">
        <li v-for="slot in upcomingSlots" :key="slot.id" class="flex items-center gap-3 p-3">
          <div class="flex-1">
            <div>{{ formatSlot(slot) }}</div>
            <div v-if="activeBooking(slot)?.status === 'pending_signature'" class="text-sm text-amber-700">
              Awaiting signature from {{ activeBooking(slot).guest_name }} ({{ activeBooking(slot).guest_email }})
            </div>
            <div v-else-if="activeBooking(slot)" class="text-sm text-green-700">
              Booked by {{ activeBooking(slot).guest_name }} ({{ activeBooking(slot).guest_email }})
            </div>
            <div v-else class="text-sm text-gray-500">Free</div>
          </div>
          <button v-if="activeBooking(slot)" class="text-sm underline" @click="cancelBooking(activeBooking(slot))">
            Cancel booking
          </button>
          <button v-else class="text-sm text-red-700 underline" @click="deleteSlot(slot)">Delete</button>
        </li>
      </ul>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold">All bookings</h2>
      <p v-if="!loading && allBookings.length === 0" class="text-gray-500">No bookings yet.</p>
      <ul v-else class="divide-y rounded border">
        <li v-for="b in allBookings" :key="b.id" class="p-3 text-sm">
          <div class="flex justify-between gap-3">
            <span><strong>{{ b.guest_name }}</strong> · {{ b.guest_email }}</span>
            <span :class="{ confirmed: 'text-green-700', pending_signature: 'text-amber-700' }[b.status] ?? 'text-gray-500'">{{ b.status === 'pending_signature' ? 'awaiting signature' : b.status }}</span>
          </div>
          <div class="text-gray-500">{{ formatSlot(b.slot) }}</div>
        </li>
      </ul>
    </section>
  </div>
</template>
