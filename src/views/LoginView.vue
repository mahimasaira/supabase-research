<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

const { signIn } = useAuth()
const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await signIn({ email: email.value, password: password.value })
    router.push(route.query.redirect || { name: 'dashboard' })
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <form class="max-w-sm space-y-3" @submit.prevent="submit">
    <h1 class="text-2xl font-semibold">Host log in</h1>
    <input v-model="email" class="input" type="email" placeholder="Email" required autocomplete="email" />
    <input v-model="password" class="input" type="password" placeholder="Password" required autocomplete="current-password" />
    <button class="btn" :disabled="loading">{{ loading ? 'Logging in…' : 'Log in' }}</button>
    <p v-if="error" class="text-red-700">{{ error }}</p>
    <p class="text-sm">No account? <RouterLink class="underline" :to="{ name: 'signup' }">Sign up</RouterLink></p>
  </form>
</template>
