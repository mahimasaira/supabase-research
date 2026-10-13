// Shared by the Edge Functions that act for a browser caller over a direct database connection
// (book-recurring, book-slot): who is calling, from which IP, did they pass the CAPTCHA, and
// how to apply all that to a transaction so RLS, rate limits and the CAPTCHA rule see it.
import { createClient } from '@supabase/supabase-js'
import type postgres from 'postgres'

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
export const reply = (status: number, body: unknown) => Response.json(body, { status, headers: cors })

const auth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } }).auth
const publishableKeys = Object.values(JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}'))

export type Identity = { role: 'anon' | 'authenticated'; claims: Record<string, unknown> }

// Who is calling? Returns an identity, or an error Response.
export async function identify(req: Request): Promise<Identity | Response> {
  const apikey = req.headers.get('apikey') ?? ''
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''

  // Every request must come from this project's own frontend (publishable key).
  if (!publishableKeys.includes(apikey)) return reply(401, { error: 'Missing or unknown apikey' })

  // No login: supabase-js sends the publishable key itself as the bearer token.
  // That's not a JWT, it's an anonymous guest.
  if (!bearer || bearer === apikey) return { role: 'anon', claims: { role: 'anon' } }

  // Otherwise it must be a JWT that Supabase Auth signed.
  const { data, error } = await auth.getClaims(bearer)
  if (error || !data) return reply(401, { error: 'Invalid or expired token' })
  const role = data.claims.role
  // Never accept service_role (or anything else) here: it would bypass RLS.
  if (role !== 'anon' && role !== 'authenticated') return reply(403, { error: `Role "${role}" not allowed` })
  return { role, claims: data.claims as Record<string, unknown> }
}

// The caller's IP: the LAST X-Forwarded-For entry (added by the proxy in front of us; the client
// can prepend fake ones). Same rule as public.request_client_ip() in the database.
export const clientIp = (req: Request) =>
  req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || null

// Cloudflare Turnstile: is this token from a human who just solved the check?
export async function verifyCaptcha(token: unknown, ip: string | null): Promise<{ ok: boolean; codes: string[] }> {
  if (typeof token !== 'string' || !token) return { ok: false, codes: ['missing-input-response'] }
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')
  if (!secret) return { ok: false, codes: ['not-configured'] }
  const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) })
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
    .then((r) => r.json())
    .catch(() => ({ success: false, 'error-codes': ['siteverify-unreachable'] }))
  return { ok: res.success === true, codes: res['error-codes'] ?? [] }
}

// Apply the caller to THIS transaction (is_local = true), like PostgREST does for each request:
// role + JWT claims (RLS, auth.uid()), the request headers with the client IP (rate limits),
// and, if verified, the CAPTCHA mark (bookings_check_captcha).
export async function applyCaller(tx: postgres.Sql | postgres.TransactionSql, who: Identity, ip: string | null, captchaVerified: boolean) {
  await tx`select set_config('role', ${who.role}, true),
                  set_config('request.jwt.claims', ${JSON.stringify(who.claims)}, true),
                  set_config('request.headers', ${JSON.stringify(ip ? { 'x-forwarded-for': ip } : {})}, true),
                  set_config('app.captcha_verified', ${captchaVerified ? 'true' : 'false'}, true)`
}

// Database errors → HTTP status, the way PostgREST would answer.
export function statusFor(code: string | undefined) {
  if (code === 'PT429') return 429         // rate limit (spam protection stage 2)
  if (code === 'PT403') return 403         // CAPTCHA required (stage 3)
  if (code === '42501' || code === '23505') return 409 // slot no longer free
  return 400
}
