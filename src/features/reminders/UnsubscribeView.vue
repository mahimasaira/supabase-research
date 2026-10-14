<script setup>
// Feature 5 (bulk reminders), stage 3: stop reminder emails, without an account.
// Reached from the link in every reminder (/reminders/unsubscribe/<cancel token>), or redirected
// here by the one-click endpoint when someone opens it in a browser. Needs an explicit click, so
// link previews / prefetchers can't unsubscribe anyone. Data access only through '@/services'.
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { unsubscribeReminders } from '@/services'
import { friendlyError } from '@/lib/errors'

const token = useRoute().params.token
const state = ref('ask') // ask | working | done | failed
const message = ref('')

async function unsubscribe() {
  state.value = 'working'
  try {
    const ok = await unsubscribeReminders(token)
    state.value = ok ? 'done' : 'failed'
    message.value = ok
      ? 'Done. You will no longer receive booking reminder emails. Your bookings are not affected.'
      : 'This link is not valid. Please use the link from your most recent reminder email.'
  } catch (err) {
    state.value = 'failed'
    // 22P02 = the token in the URL isn't a valid uuid.
    message.value = err.code === '22P02' ? 'This link is not valid.' : friendlyError(err)
  }
}
</script>

<template>
  <div class="max-w-md space-y-4">
    <h1 class="text-2xl font-semibold">Booking reminders</h1>
    <template v-if="state === 'ask' || state === 'working'">
      <p>Stop receiving reminder emails the day before your bookings?</p>
      <button class="btn" :disabled="state === 'working'" @click="unsubscribe">
        {{ state === 'working' ? 'Saving…' : 'Stop reminders' }}
      </button>
    </template>
    <p v-else :class="state === 'done' ? 'text-green-800' : 'text-red-700'">{{ message }}</p>
  </div>
</template>
