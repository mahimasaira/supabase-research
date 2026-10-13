<script setup>
// Feature 4 (DocuSign), stage 1: the host switches "require a signed agreement" on or off.
// With it on, new bookings wait for the guest's signature before they're confirmed.
import { onMounted, ref } from 'vue'
import { checkSignatureStatus, getSignatureRequirement, setSignatureRequirement } from '@/services'
import { friendlyError } from '@/lib/errors'

const props = defineProps({ userId: { type: String, required: true } })
const emit = defineEmits(['changed']) // results applied: the Dashboard reloads its bookings
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

// Stage 3: ask DocuSign about agreements that are still out (the webhook can't reach a local app).
const checking = ref(false)
const checkResult = ref('')
async function check() {
  checking.value = true
  checkResult.value = ''
  error.value = ''
  try {
    const r = await checkSignatureStatus()
    checkResult.value = r.checked === 0
      ? 'No agreements are waiting.'
      : `Checked ${r.checked}: ${r.signed} signed, ${r.cancelled} declined or voided, ${r.waiting} still waiting.`
    if (r.errors.length) error.value = `DocuSign errors: ${r.errors.join('; ')}`
    emit('changed')
  } catch (err) {
    error.value = friendlyError(err)
  }
  checking.value = false
}

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
    <div class="flex flex-wrap items-center gap-3 pl-7">
      <button class="rounded border px-3 py-1 text-sm hover:bg-gray-100" :disabled="checking" @click="check">
        {{ checking ? 'Checking…' : 'Check signature status' }}
      </button>
      <span v-if="checkResult" class="text-sm text-gray-700">{{ checkResult }}</span>
    </div>
    <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
  </section>
</template>
