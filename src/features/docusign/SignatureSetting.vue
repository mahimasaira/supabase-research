<script setup>
// Feature 4 (DocuSign), stage 1: the host switches "require a signed agreement" on or off.
// With it on, new bookings wait for the guest's signature before they're confirmed.
import { onMounted, ref } from 'vue'
import { getSignatureRequirement, setSignatureRequirement } from '@/services'
import { friendlyError } from '@/lib/errors'

const props = defineProps({ userId: { type: String, required: true } })
const required = ref(false)
const saving = ref(false)
const error = ref('')

onMounted(async () => {
  try {
    required.value = await getSignatureRequirement(props.userId)
  } catch (err) {
    error.value = friendlyError(err)
  }
})

async function toggle() {
  saving.value = true
  error.value = ''
  try {
    required.value = await setSignatureRequirement(props.userId, !required.value)
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
        <span class="font-medium">Require a signed agreement</span>
        <span class="block text-sm text-gray-600">
          Guests get an agreement by email (DocuSign). The slot is held for them, but the booking is only
          confirmed once they've signed. Existing bookings aren't affected.
        </span>
      </span>
    </label>
    <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
  </section>
</template>
