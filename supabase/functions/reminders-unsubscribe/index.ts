// Feature 5, stage 3: the "Unsubscribe" button that mail apps show (RFC 8058 one-click).
// Every reminder carries:
//   List-Unsubscribe: <…/functions/v1/reminders-unsubscribe?token=<cancel token>>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
// Gmail / Apple Mail then POST to that URL directly, without opening any page and without a
// Supabase key, which is why this is a small public Edge Function (verify_jwt = false).
//   POST → unsubscribe (the token is the booking's cancel token, the guest's existing secret)
//   GET  → a person opened the URL in a browser: send them to the app's page, which asks first
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
const APP_URL = Deno.env.get('APP_URL') ?? 'http://127.0.0.1:5173'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  if (!GUID.test(token)) return new Response('Invalid unsubscribe link.', { status: 400 })

  if (req.method === 'GET') {
    // Don't unsubscribe on GET: link scanners and previews open URLs without anyone clicking.
    return Response.redirect(`${APP_URL}/reminders/unsubscribe/${token}`, 303)
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  await sql`select public.unsubscribe_reminders(${token}::uuid)`
  // The same answer whether or not the token exists: don't reveal which tokens are valid.
  return new Response('You will no longer receive booking reminders.', { status: 200 })
})
