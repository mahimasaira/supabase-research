<script setup>
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import { forgetGuestBooking } from '@/lib/guestBookings'

// Reached from the link shown after booking. Cancelling needs an explicit click,
// so link previews / prefetchers can't cancel a booking by just opening the URL.
const token = useRoute().params.token
const state = ref('idle') // idle | working | done | failed
const message = ref('')

async function cancel() {
  state.value = 'working'
  const { data: ok, error } = await supabase.rpc('cancel_booking', { p_cancel_token: token })
  if (error) {
    state.value = 'failed'
    // 22P02 = the token in the URL isn't a valid uuid.
    message.value = error.code === '22P02' ? 'This cancel link is invalid.' : friendlyError(error)
    return
  }
  forgetGuestBooking(token)
  state.value = ok ? 'done' : 'failed'
  message.value = ok
    ? 'Your booking was cancelled.'
    : 'This booking could not be cancelled. It may already be cancelled, or the slot has started.'
}
</script>

<template>
  <div class="max-w-sm space-y-3">
    <h1 class="text-2xl font-semibold">Cancel booking</h1>
    <button v-if="state === 'idle' || state === 'working'" class="btn" :disabled="state === 'working'" @click="cancel">
      {{ state === 'working' ? 'Cancelling…' : 'Cancel my booking' }}
    </button>
    <p v-else :class="state === 'done' ? 'text-green-700' : 'text-red-700'">{{ message }}</p>
  </div>
</template>
