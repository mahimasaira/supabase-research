<script setup>
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

const { user, signOut } = useAuth()
const router = useRouter()

async function logout() {
  await signOut()
  router.push({ name: 'login' })
}
</script>

<template>
  <header class="border-b">
    <nav class="mx-auto flex max-w-2xl items-center gap-4 p-4 text-sm">
      <RouterLink :to="{ name: 'home' }" class="font-semibold">Booking</RouterLink>
      <span class="flex-1" />
      <template v-if="user">
        <RouterLink :to="{ name: 'dashboard' }">Dashboard</RouterLink>
        <RouterLink :to="{ name: 'history' }">History</RouterLink>
        <span class="text-gray-500">{{ user.email }}</span>
        <button class="underline" @click="logout">Log out</button>
      </template>
      <template v-else>
        <RouterLink :to="{ name: 'login' }">Log in</RouterLink>
        <RouterLink :to="{ name: 'signup' }">Sign up</RouterLink>
      </template>
    </nav>
  </header>
  <main class="mx-auto max-w-2xl p-6">
    <RouterView />
  </main>
</template>
