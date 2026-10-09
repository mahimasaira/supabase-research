<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

const { signUp } = useAuth()
const router = useRouter()

const displayName = ref('')
const email = ref('')
const password = ref('')
const error = ref('')
const info = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  info.value = ''
  loading.value = true
  try {
    const { needsConfirmation } = await signUp({
      email: email.value,
      password: password.value,
      displayName: displayName.value,
    })
    if (needsConfirmation) {
      info.value = 'Check your email for a confirmation link.'
    } else {
      router.push({ name: 'dashboard' })
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <form class="max-w-sm space-y-3" @submit.prevent="submit">
    <h1 class="text-2xl font-semibold">Host sign up</h1>
    <input v-model="displayName" class="input" placeholder="Display name" required maxlength="80" />
    <input v-model="email" class="input" type="email" placeholder="Email" required autocomplete="email" />
    <input v-model="password" class="input" type="password" placeholder="Password (min 6 chars)" required minlength="6" autocomplete="new-password" />
    <button class="btn" :disabled="loading">{{ loading ? 'Signing up…' : 'Sign up' }}</button>
    <p v-if="error" class="text-red-700">{{ error }}</p>
    <p v-if="info" class="text-green-700">{{ info }}</p>
    <p class="text-sm">Already have an account? <RouterLink class="underline" :to="{ name: 'login' }">Log in</RouterLink></p>
  </form>
</template>
