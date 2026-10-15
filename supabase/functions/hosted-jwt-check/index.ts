// Edge Function: answers one question for HOSTED_CHECKS.md. Not used by the app.
// It keeps Supabase's built-in JWT check ON (verify_jwt = true, the default) and returns only
// { reached: true }. Whatever reaches it got through the built-in check, so a script can see
// which credentials that check accepts (no key, the publishable key, a user's token…).
import '@supabase/functions-js/edge-runtime.d.ts'

Deno.serve(() => Response.json({ reached: true }))
