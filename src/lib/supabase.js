import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill in the values from `npx supabase status`.',
  )
}

// Only the anon/publishable key ever lives in the browser.
// The service_role/secret key must never get a VITE_ prefix.
export const supabase = createClient(url, anonKey)
