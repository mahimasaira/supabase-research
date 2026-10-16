import { ref, computed } from 'vue'
import { auth } from '@/services'

// Module-level state: one shared session for the whole app.
const session = ref(null)

// The backend's client restores a stored session on load. `ready` resolves once that has
// happened, so the router guard doesn't redirect a logged-in host to /login on a page refresh.
const ready = auth.getSession().then((restored) => {
  session.value = restored
})

// Fires on sign-in, sign-out, token refresh, and changes from other tabs.
auth.onChange((newSession) => {
  session.value = newSession
})

export function useAuth() {
  const user = computed(() => session.value?.user ?? null)

  // The backend's client handles the details (Supabase: auth.users + the handle_new_user trigger).
  const signUp = (fields) => auth.signUp(fields)
  const signIn = (fields) => auth.signIn(fields)
  const signOut = () => auth.signOut()

  return { session, user, ready, signUp, signIn, signOut }
}
