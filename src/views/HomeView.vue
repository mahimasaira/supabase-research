<script setup>
import { useAuth } from '@/composables/useAuth'

const { user } = useAuth()
</script>

<template>
  <div class="space-y-3">
    <h1 class="text-2xl font-semibold">Supabase booking</h1>
    <p>Hosts publish time slots; guests book them from the host's public page, no account needed.</p>
    <p v-if="user">
      <RouterLink class="underline" :to="{ name: 'dashboard' }">Go to your dashboard</RouterLink>
    </p>
    <p v-else>
      <RouterLink class="underline" :to="{ name: 'signup' }">Sign up as a host</RouterLink>
      or <RouterLink class="underline" :to="{ name: 'login' }">log in</RouterLink>.
    </p>
  </div>
</template>
