<script setup>
// Feature 3 (spam protection), stage 3: the host switches "require a CAPTCHA" on or off.
// With it on, guests solve a Cloudflare Turnstile check before booking, and the database refuses
// bookings that skip it (direct API calls by bots).
import { onMounted, ref } from 'vue'
import { getCaptchaRequirement, setCaptchaRequirement } from '@/services'
import { friendlyError } from '@/lib/errors'

const props = defineProps({ userId: { type: String, required: true } })
const required = ref(false)
const saving = ref(false)
const error = ref('')

onMounted(async () => {
  try {
    required.value = await getCaptchaRequirement(props.userId)
  } catch (err) {
    error.value = friendlyError(err)
  }
})

async function toggle() {
  saving.value = true
  error.value = ''
  try {
    required.value = await setCaptchaRequirement(props.userId, !required.value)
  } catch (err) {
    error.value = friendlyError(err)
  }
  saving.value = false
}
</script>

<template>
  <section class="space-y-2 rounded border p-4">
    <label class="flex items-start gap-3">
      <input type="checkbox" class="mt-1" :checked="required" :disabled="saving" @change="toggle" />
      <span>
        <span class="font-medium">Require a CAPTCHA (spam protection)</span>
        <span class="block text-sm text-gray-600">
          Guests confirm they're human before booking. Turn this on if bots are filling your calendar.
        </span>
      </span>
    </label>
    <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
  </section>
</template>
