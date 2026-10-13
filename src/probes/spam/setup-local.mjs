// Local setup for feature 3 (spam protection), stage 3: npm run probe:spam:setup
// Writes TURNSTILE_SECRET_KEY into supabase/functions/.env (git-ignored, mode 600), keeping all
// other lines. Uses TURNSTILE_SECRET_KEY from .env.local if set (real key from the Cloudflare
// dashboard), otherwise Cloudflare's official TEST secret that accepts any non-empty token.
// The matching site key for the browser is VITE_TURNSTILE_SITE_KEY (default: test key, see
// src/features/spam/CaptchaWidget.vue). Never prints a secret.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ENV_FILE = 'supabase/functions/.env'
const TEST_SECRET_ALWAYS_PASSES = '1x0000000000000000000000000000000AA' // public, from Cloudflare's docs

const own = (process.env.TURNSTILE_SECRET_KEY ?? '').trim()
const kept = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('TURNSTILE_SECRET_KEY=')) : []
writeFileSync(ENV_FILE, [...kept, `TURNSTILE_SECRET_KEY=${own || TEST_SECRET_ALWAYS_PASSES}`].join('\n') + '\n')
chmodSync(ENV_FILE, 0o600)
try {
  execSync(`git check-ignore -q ${ENV_FILE}`)
} catch {
  console.error(`FAIL  ${ENV_FILE} is NOT git-ignored`)
  process.exit(1)
}
console.log(`PASS  ${ENV_FILE}: TURNSTILE_SECRET_KEY ${own ? 'from .env.local' : 'set to Cloudflare\'s always-pass TEST secret'}`)
console.log('      The Edge Functions pick it up on their next start (npm run functions:serve).')
