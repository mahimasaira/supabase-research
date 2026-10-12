<script setup>
// Advanced feature 2, stage 4: the host's history page.
// Shows audit_log entries about the logged-in host (RLS), written by the stage 2 triggers.
// Data access only through '@/services'.
import { computed, onMounted, ref, watch } from 'vue'
import { listAuditHistory } from '@/services'
import { friendlyError } from '@/lib/errors'
import { useAuth } from '@/composables/useAuth'
import { groupHistory } from './history'

const { user } = useAuth()
const kind = ref('all')
const entries = ref([])
const nextCursor = ref(null)
const loading = ref(false)
const error = ref('')

async function load({ more = false } = {}) {
  loading.value = true
  error.value = ''
  try {
    const page = await listAuditHistory({ hostId: user.value.id, kind: kind.value, cursor: more ? nextCursor.value : null })
    entries.value = more ? [...entries.value, ...page.entries] : page.entries
    nextCursor.value = page.nextCursor
  } catch (err) {
    error.value = friendlyError(err)
  }
  loading.value = false
}
onMounted(load)
watch(kind, () => load())

const groups = computed(() => groupHistory(entries.value, user.value?.id))
const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const whoClass = {
  You: 'bg-gray-900 text-white',
  Guest: 'bg-blue-100 text-blue-800',
  'Database admin': 'bg-amber-100 text-amber-800',
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">History</h1>
        <p class="text-sm text-gray-600">Everything that happened on your booking page, newest first.</p>
      </div>
      <div class="flex items-center gap-2">
        <select v-model="kind" class="rounded border border-gray-300 px-2 py-1 text-sm">
          <option value="all">All</option>
          <option value="bookings">Bookings</option>
          <option value="slots">Slots</option>
          <option value="profile">Profile</option>
        </select>
        <button class="rounded border px-3 py-1 text-sm hover:bg-gray-100" :disabled="loading" @click="load()">Refresh</button>
      </div>
    </div>

    <p v-if="error" class="text-red-700">{{ error }}</p>
    <p v-else-if="!loading && groups.length === 0" class="text-gray-500">Nothing yet.</p>

    <ul v-if="groups.length" class="divide-y rounded border">
      <li v-for="g in groups" :key="g.txId + g.at" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 text-sm">
        <span class="w-40 shrink-0 text-gray-500">{{ timeFmt.format(new Date(g.at)) }}</span>
        <span class="rounded px-2 py-0.5 text-xs font-medium" :class="whoClass[g.who] ?? 'bg-gray-100 text-gray-700'">{{ g.who }}</span>
        <span class="min-w-0 flex-1">{{ g.text }}</span>
      </li>
    </ul>

    <button v-if="nextCursor" class="btn" :disabled="loading" @click="load({ more: true })">
      {{ loading ? 'Loading…' : 'Load more' }}
    </button>
  </div>
</template>
