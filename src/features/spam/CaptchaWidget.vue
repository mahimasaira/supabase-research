<script setup>
// Feature 3 (spam protection), stage 3: the Cloudflare Turnstile check on the booking page.
// Emits the token once solved ('' when it expires or fails). A token is single-use: call
// reset() after each booking attempt to get a new one.
// Site key: VITE_TURNSTILE_SITE_KEY, default Cloudflare's always-passing TEST key.
import { onBeforeUnmount, onMounted, ref } from 'vue'

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '1x00000000000000000000AA'
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

const emit = defineEmits(['token'])
const el = ref(null)
const failed = ref('')
let widgetId = null

// Load Cloudflare's script once per page, however many widgets there are.
function loadScript() {
  if (window.turnstile) return Promise.resolve()
  window.__turnstileLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    script.onload = resolve
    script.onerror = () => reject(new Error('Could not load the CAPTCHA (Cloudflare Turnstile).'))
    document.head.appendChild(script)
  })
  return window.__turnstileLoading
}

onMounted(async () => {
  try {
    await loadScript()
    widgetId = window.turnstile.render(el.value, {
      sitekey: SITE_KEY,
      callback: (token) => emit('token', token),
      'expired-callback': () => emit('token', ''),
      'error-callback': () => { failed.value = 'The CAPTCHA could not be completed. Please reload the page.'; emit('token', '') },
    })
  } catch (err) {
    failed.value = err.message
  }
})

onBeforeUnmount(() => {
  if (widgetId !== null) window.turnstile?.remove(widgetId)
})

function reset() {
  emit('token', '')
  if (widgetId !== null) window.turnstile?.reset(widgetId)
}
defineExpose({ reset })
</script>

<template>
  <div>
    <div ref="el" />
    <p v-if="failed" class="text-sm text-red-700">{{ failed }}</p>
  </div>
</template>
