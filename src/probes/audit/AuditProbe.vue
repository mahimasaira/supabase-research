<script setup>
// Probe page for advanced feature 2, stage 1: an audit log written by the browser.
// Each button does an action AND sends a log entry (two requests). Compare what happened
// with what the log says using src/probes/audit/sql/check.sql in Studio.
// Data access only through '@/services'.
import { computed, onMounted, ref, watch } from 'vue'
import {
  bookSlotLogged, cancelAsGuestLogged, cancelAsHostLogged, deleteSlotLogged,
  listFreeSlots, listHostSlots, logAuditEventFromClient,
} from '@/services'
import { friendlyError } from '@/lib/errors'
import { formatSlot } from '@/lib/format'
import { useAuth } from '@/composables/useAuth'

// The recurring probe's test host (fixed id in src/probes/recurring/sql/seed.sql).
const TEST_HOST_ID = '11111111-1111-4111-8111-111111111111'

const { user } = useAuth()
const freeSlots = ref([])
const hostSlots = ref([])
const loadError = ref('')

async function load() {
  loadError.value = ''
  try {
    freeSlots.value = await listFreeSlots(TEST_HOST_ID)
    hostSlots.value = user.value ? await listHostSlots(user.value.id) : []
  } catch (err) {
    loadError.value = friendlyError(err)
  }
}
onMounted(load)
watch(user, load)

// ---- options ----
const order = ref('act-first')
const failLog = ref(false)
const opts = () => ({ order: order.value, failLog: failLog.value })

// ---- results of this session ----
const results = ref([])
function record(label, r) {
  results.value.unshift({ label, ...r, at: new Date().toLocaleTimeString() })
  load()
}
function verdict(r) {
  if (r.acted && r.logged) return { text: 'Change saved and logged', cls: 'border-green-300 bg-green-50 text-green-800' }
  if (r.acted) return { text: 'Change saved, but NO log entry', cls: 'border-amber-400 bg-amber-50 text-amber-800' }
  if (r.logged) return { text: 'Log says it happened, but it did NOT', cls: 'border-red-300 bg-red-50 text-red-800' }
  return { text: 'Nothing happened, nothing logged', cls: 'border-gray-300 bg-gray-50 text-gray-700' }
}

// ---- guest ----
const guestName = ref('Audit Guest')
const guestEmail = ref('audit.guest@example.com')
const myBookings = ref([]) // { slot, cancelToken }, only for this page session

async function book(slot) {
  const r = await bookSlotLogged({ hostId: TEST_HOST_ID, slotId: slot.id, guestName: guestName.value, guestEmail: guestEmail.value }, opts())
  if (r.cancelToken) myBookings.value.push({ slot, cancelToken: r.cancelToken })
  record(`Guest books ${formatSlot(slot)}`, r)
}

async function guestCancel(b) {
  const r = await cancelAsGuestLogged({ hostId: TEST_HOST_ID, slotId: b.slot.id, cancelToken: b.cancelToken }, opts())
  if (r.acted) myBookings.value = myBookings.value.filter((x) => x !== b)
  record(`Guest cancels ${formatSlot(b.slot)}`, r)
}

// ---- host ----
const confirmedBooking = (slot) => slot.bookings.find((b) => b.status === 'confirmed')

async function hostCancel(slot) {
  const booking = confirmedBooking(slot)
  record(`Host cancels ${booking.guest_name} on ${formatSlot(slot)}`, await cancelAsHostLogged({ hostId: user.value.id, bookingId: booking.id }, opts()))
}

async function hostDelete(slot) {
  record(`Host deletes slot ${formatSlot(slot)}`, await deleteSlotLogged({ hostId: user.value.id, slot }, opts()))
}

// ---- forging ----
// Anyone (even logged out) can write an entry claiming the host deleted a slot.
const forgeTarget = computed(() => freeSlots.value[0])
async function forge() {
  const slot = forgeTarget.value
  const { error } = await logAuditEventFromClient({
    action: 'slot.deleted',
    table: 'slots',
    recordId: slot.id,
    hostId: TEST_HOST_ID,
    changes: { starts_at: slot.starts_at, ends_at: slot.ends_at },
  })
  record(`FAKE entry: "host deleted ${formatSlot(slot)}" (slot not touched)`, { acted: false, logged: !error, actError: null, logError: error, order: 'forged' })
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Probe: audit log, stage 1 (written by the browser)</h1>
      <p class="text-sm text-gray-600">
        Every action is two requests: the action, then a log entry. Reset: <code>npm run probe:audit:seed</code>.
        Compare reality with the log: <code>src/probes/audit/sql/check.sql</code> in Studio.
      </p>
    </div>

    <section class="space-y-2 rounded border p-4">
      <h2 class="font-semibold">Options</h2>
      <label class="flex items-center gap-2"><input v-model="order" type="radio" value="act-first" /> Act first, then log</label>
      <label class="flex items-center gap-2"><input v-model="order" type="radio" value="log-first" /> Log first, then act</label>
      <label class="flex items-center gap-2"><input v-model="failLog" type="checkbox" /> Make the log request fail (simulates a lost request)</label>
    </section>

    <p v-if="loadError" class="text-red-700">{{ loadError }}</p>

    <!-- Guest: logged out -->
    <section v-if="!user" class="space-y-3">
      <h2 class="text-lg font-semibold">As an anonymous guest</h2>
      <div class="flex max-w-md gap-2">
        <input v-model="guestName" class="input" placeholder="Name" />
        <input v-model="guestEmail" class="input" placeholder="Email" />
      </div>
      <p v-if="freeSlots.length === 0" class="text-gray-500">No free slots. Run the seed.</p>
      <div class="flex flex-wrap gap-2">
        <button v-for="s in freeSlots" :key="s.id" class="rounded border px-3 py-1 text-sm hover:bg-gray-100" @click="book(s)">
          Book {{ formatSlot(s) }}
        </button>
      </div>
      <ul v-if="myBookings.length" class="divide-y rounded border">
        <li v-for="b in myBookings" :key="b.cancelToken" class="flex items-center justify-between gap-3 p-2 text-sm">
          <span class="flex-1">{{ formatSlot(b.slot) }}</span>
          <button class="underline" @click="book(b.slot)">Book again (slot is taken)</button>
          <button class="text-red-700 underline" @click="guestCancel(b)">Cancel (guest)</button>
        </li>
      </ul>
      <p v-if="myBookings.length" class="text-xs text-gray-500">
        "Book again" tries a slot that is already taken, so the booking must fail.
        With "Log first" the log still gets an entry for it.
      </p>
    </section>

    <!-- Host: logged in -->
    <section v-else class="space-y-3">
      <h2 class="text-lg font-semibold">As host {{ user.email }}</h2>
      <p class="text-xs text-gray-500">
        Guest actions need you logged out. The test host is <code>recurring-host@test.dev</code> / <code>password123</code>.
      </p>
      <p v-if="hostSlots.length === 0" class="text-gray-500">You have no slots.</p>
      <ul class="divide-y rounded border">
        <li v-for="s in hostSlots" :key="s.id" class="flex items-center justify-between gap-3 p-2 text-sm">
          <span>{{ formatSlot(s) }} <span class="text-gray-500">{{ confirmedBooking(s)?.guest_name ?? 'free' }}</span></span>
          <button v-if="confirmedBooking(s)" class="text-red-700 underline" @click="hostCancel(s)">Cancel booking</button>
          <button v-else class="text-red-700 underline" @click="hostDelete(s)">Delete slot</button>
        </li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="text-lg font-semibold">Forge an entry</h2>
      <button class="btn" :disabled="!forgeTarget" @click="forge">Write a fake "host deleted a slot" entry</button>
      <p class="text-xs text-gray-500">Works logged out too: anyone who can log, can log anything.</p>
    </section>

    <section v-if="results.length" class="space-y-2">
      <h2 class="text-lg font-semibold">What happened vs. what was logged</h2>
      <div v-for="(r, i) in results" :key="i" class="rounded border p-3 text-sm" :class="verdict(r).cls">
        <p class="font-semibold">{{ verdict(r).text }}</p>
        <p>{{ r.at }} · {{ r.label }} <span class="text-xs">({{ r.order }})</span></p>
        <p v-if="r.actError" class="text-xs">Action failed: {{ r.actError.code }} {{ r.actError.message }}</p>
        <p v-if="r.logError" class="text-xs">Log failed: {{ r.logError.code }} {{ r.logError.message }}</p>
      </div>
    </section>
  </div>
</template>
