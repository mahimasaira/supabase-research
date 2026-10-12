<script setup>
// Probe page for advanced feature 1: recurring bookings, all-or-nothing.
// Acts as an anonymous guest booking the seeded test host's Mondays.
// Data access only through '@/services' (no supabase import here).
import { computed, onMounted, ref } from 'vue'
import { bookRecurring, getHostProfile, listFreeSlots, recurringStrategies } from '@/services'
import { friendlyError } from '@/lib/errors'
import { formatDate, formatSlot } from '@/lib/format'
import { useAuth } from '@/composables/useAuth'

// Fixed id from sql/seed.sql.
const TEST_HOST_ID = '11111111-1111-4111-8111-111111111111'

const { user } = useAuth()
const host = ref(null)
const slots = ref([])
const loadError = ref('')

async function load() {
  loadError.value = ''
  try {
    host.value = await getHostProfile(TEST_HOST_ID)
    slots.value = host.value ? await listFreeSlots(TEST_HOST_ID) : []
  } catch (err) {
    loadError.value = friendlyError(err)
  }
}
onMounted(load)

const strategy = ref('split')
const firstSlot = ref(null)
const weeks = ref(6)
const guestName = ref('Probe Guest')
const guestEmail = ref('guest@example.com')
const running = ref(false)
const result = ref(null)

const weekDate = (week) => formatDate(new Date(new Date(result.value.input.firstSlot.starts_at).getTime() + (week - 1) * 7 * 24 * 3600_000))
const leftBehind = computed(() => result.value && !result.value.ok && result.value.saved?.seriesId)

async function submit() {
  running.value = true
  const input = {
    hostId: TEST_HOST_ID,
    firstSlot: firstSlot.value,
    weeks: weeks.value,
    guestName: guestName.value,
    guestEmail: guestEmail.value,
  }
  try {
    result.value = { ...(await bookRecurring(input, { strategy: strategy.value })), input, strategy: strategy.value }
  } catch (err) {
    result.value = { ok: false, clash: null, error: err, saved: null, input, strategy: strategy.value }
  }
  running.value = false
  firstSlot.value = null
  load()
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Probe: recurring bookings</h1>
      <p class="text-sm text-gray-600">
        Book the same weekly slot for N weeks. Rule: all-or-nothing. Test data:
        <code>npm run probe:recurring:seed</code> (6 Mondays, week 4 already taken; run again to reset).
        Check the database with <code>src/probes/recurring/sql/check.sql</code> in Studio.
      </p>
    </div>

    <p v-if="user" class="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      You're logged in as {{ user.email }}, so requests are sent as that user, not as an anonymous guest.
      Log out to test as a real guest.
    </p>

    <section class="space-y-2">
      <h2 class="text-lg font-semibold">Implementation</h2>
      <label v-for="s in recurringStrategies" :key="s.id" class="flex items-center gap-2" :class="{ 'text-gray-400': !s.ready }">
        <input v-model="strategy" type="radio" :value="s.id" :disabled="!s.ready" />
        {{ s.label }}<span v-if="!s.ready" class="text-xs">(not built yet)</span>
      </label>
    </section>

    <section class="space-y-2">
      <h2 class="text-lg font-semibold">Week 1 slot of {{ host?.display_name || 'the test host' }}</h2>
      <p v-if="loadError" class="text-red-700">{{ loadError }}</p>
      <p v-else-if="!host" class="text-gray-500">Test host not found. Run <code>npm run probe:recurring:seed</code>.</p>
      <p v-else-if="slots.length === 0" class="text-gray-500">No free slots. Run the seed again to reset.</p>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="s in slots"
          :key="s.id"
          class="rounded border px-3 py-1 text-sm"
          :class="firstSlot?.id === s.id ? 'border-gray-900 bg-gray-900 text-white' : 'hover:bg-gray-100'"
          @click="firstSlot = s"
        >
          {{ formatSlot(s) }}
        </button>
      </div>
      <p class="text-xs text-gray-500">Booked slots are hidden from guests by RLS (week 4 should be missing).</p>
    </section>

    <form v-if="firstSlot" class="max-w-sm space-y-3 rounded border p-4" @submit.prevent="submit">
      <label class="block text-sm">Number of weeks
        <input v-model.number="weeks" class="input" type="number" min="2" max="12" required />
      </label>
      <input v-model="guestName" class="input" placeholder="Your name" required maxlength="100" />
      <input v-model="guestEmail" class="input" type="email" placeholder="Your email" required />
      <button class="btn" :disabled="running">{{ running ? 'Booking…' : `Book ${weeks} weeks` }}</button>
    </form>

    <section v-if="result" class="space-y-2">
      <h2 class="text-lg font-semibold">Result ({{ result.strategy }})</h2>
      <p v-if="result.ranAs" class="text-xs text-gray-600">
        Edge Function ran the transaction as database role <code>{{ result.ranAs.role }}</code>,
        auth.uid() = <code>{{ result.ranAs.uid ?? 'null (anonymous)' }}</code>
      </p>
      <div v-if="result.ok" class="rounded border border-green-300 bg-green-50 p-3">
        <p class="font-semibold text-green-800">Booked all {{ result.weeks.length }} weeks.</p>
        <p class="text-sm">Series {{ result.seriesId }}</p>
      </div>
      <template v-else>
        <div class="rounded border border-red-300 bg-red-50 p-3">
          <p v-if="result.notEnoughWeeks" class="font-semibold text-red-800">
            Only {{ result.notEnoughWeeks.available }} week{{ result.notEnoughWeeks.available === 1 ? '' : 's' }}
            available from {{ weekDate(1) }} (you asked for {{ result.notEnoughWeeks.requested }}). Nothing was booked.
          </p>
          <p v-else-if="result.clash" class="font-semibold text-red-800">
            Week {{ result.clash.week }} ({{ weekDate(result.clash.week) }}) is {{ result.clash.reason }}. Nothing was booked.
          </p>
          <p v-else class="font-semibold text-red-800">Booking failed: {{ friendlyError(result.error) }}</p>
          <p v-if="result.error" class="text-xs text-gray-600">{{ result.error.code }}: {{ result.error.message }}</p>
        </div>
        <div v-if="leftBehind" class="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          <p class="font-semibold text-amber-800">
            …but the database disagrees: the all-or-nothing rule was broken.
          </p>
          <p>Still saved: series {{ result.saved.seriesId }}</p>
          <p v-if="result.saved.weeks.length">
            and weeks {{ result.saved.weeks.map((w) => w.week).join(', ') }} (their slots are now taken for everyone).
          </p>
          <p class="text-xs text-gray-600">The guest was told "nothing was booked". Run check.sql in Studio to see it.</p>
        </div>
        <div v-else-if="result.strategy !== 'split' && result.clash" class="rounded border border-green-300 bg-green-50 p-3 text-sm">
          <p class="font-semibold text-green-800">Rolled back as one transaction: weeks before {{ result.clash.week }} were undone too.</p>
          <p class="text-xs text-gray-600">The guest can't read bookings back, so confirm with check.sql in Studio: no new series should appear.</p>
        </div>
      </template>
    </section>
  </div>
</template>
