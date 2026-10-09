import { ref, computed } from 'vue'
import { supabase } from '@/lib/supabase'

// Module-level state: one shared session for the whole app.
const session = ref(null)

// supabase-js stores the session in localStorage and restores it on load.
// `ready` resolves once that restore has happened, so the router guard
// doesn't redirect a logged-in host to /login on a page refresh.
const ready = supabase.auth.getSession().then(({ data }) => {
  session.value = data.session
})

// Fires on sign-in, sign-out, token refresh, and changes from other tabs.
supabase.auth.onAuthStateChange((_event, newSession) => {
  session.value = newSession
})

export function useAuth() {
  const user = computed(() => session.value?.user ?? null)

  async function signUp({ email, password, displayName }) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      // Lands in auth.users.raw_user_meta_data; the handle_new_user trigger copies it to profiles.
      options: { data: { display_name: displayName } },
    })
    if (error) throw error
    // With email confirmation ON (the hosted default) there is no session until the link is clicked.
    return { needsConfirmation: !data.session }
  }

  async function signIn({ email, password }) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }

  return { session, user, ready, signUp, signIn, signOut }
}
