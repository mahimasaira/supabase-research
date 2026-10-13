// Local setup for feature 4 (DocuSign). Run once, and again after `supabase db reset`
// or when the DocuSign values change:   npm run probe:docusign:setup
//
// 1. supabase/functions/.env (git-ignored, mode 600): the DOCUSIGN_* values from .env.local,
//    plus DOCUSIGN_PRIVATE_KEY_BASE64 (the key file's content), because Edge Functions read
//    their own env file and a deployed function has no key file.
// 2. Vault (local database): docusign_send_url + docusign_send_key, used by the trigger that
//    asks the docusign-send function to send an agreement (pg_net).
// Never prints a secret. Restart `npm run functions:serve` afterwards (it reads .env on start).
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const ENV_FILE = 'supabase/functions/.env'
const NAMES = ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_USER_ID', 'DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_BASE_URI', 'DOCUSIGN_AUTH_SERVER']
const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1) }
const value = (name) => (process.env[name] ?? '').trim().replace(/^["']|["']$/g, '')

// ---- 1. Edge Function env file ----
for (const name of NAMES) if (!value(name)) fail(`${name} is missing in .env.local`)
const keyPath = value('DOCUSIGN_PRIVATE_KEY_PATH')
let pem
try {
  pem = readFileSync(keyPath, 'utf8')
} catch (err) {
  fail(`can't read DOCUSIGN_PRIVATE_KEY_PATH (${keyPath || 'empty'}): ${err.code}`)
}
if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) fail('DOCUSIGN_PRIVATE_KEY_PATH is not a PEM private key')

const wanted = Object.fromEntries([...NAMES.map((n) => [n, value(n)]), ['DOCUSIGN_PRIVATE_KEY_BASE64', Buffer.from(pem).toString('base64')]])

// Stage 3, webhook: the HMAC key DocuSign Connect signs its messages with. Real key from
// DocuSign (admin → Connect → Connect Keys) if set in .env.local; otherwise a random local key,
// generated once and kept, for the simulated messages of the proof script.
const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
const keptHmac = existing.match(/^DOCUSIGN_CONNECT_HMAC_KEY=(.+)$/m)?.[1]
wanted.DOCUSIGN_CONNECT_HMAC_KEY = value('DOCUSIGN_CONNECT_HMAC_KEY') || keptHmac || randomBytes(32).toString('base64')
const hmacSource = value('DOCUSIGN_CONNECT_HMAC_KEY') ? 'from .env.local' : keptHmac ? 'local key kept' : 'new local key generated'
// Optional: public URL of docusign-webhook (hosted project or tunnel); then envelopes ask DocuSign to call it.
if (value('DOCUSIGN_WEBHOOK_URL')) wanted.DOCUSIGN_WEBHOOK_URL = value('DOCUSIGN_WEBHOOK_URL')
// Keep any other lines already in the file; replace only the DOCUSIGN_* ones.
const kept = existsSync(ENV_FILE)
  ? readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.trim() && !Object.keys(wanted).some((k) => l.startsWith(`${k}=`)))
  : []
writeFileSync(ENV_FILE, [...kept, ...Object.entries(wanted).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n')
chmodSync(ENV_FILE, 0o600)
const ignored = (() => { try { execSync(`git check-ignore -q ${ENV_FILE}`); return true } catch { return false } })()
if (!ignored) fail(`${ENV_FILE} is NOT git-ignored. Fix .gitignore before continuing.`)
console.log(`PASS  ${ENV_FILE} written (${Object.keys(wanted).length} DOCUSIGN_* values, mode 600, git-ignored; webhook HMAC key: ${hmacSource})`)

// ---- 2. Vault secrets for the database trigger ----
const status = JSON.parse(execSync('npx supabase status -o json < /dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
const secretKey = status.SECRET_KEY
if (!secretKey) fail('could not read SECRET_KEY from `supabase status`')
// Inside Docker, the database reaches the Edge Functions through the API gateway "kong".
const secrets = { docusign_send_url: 'http://kong:8000/functions/v1/docusign-send', docusign_send_key: secretKey }
const literal = (s) => `'${s.replace(/'/g, "''")}'`
const upserts = Object.entries(secrets).map(([name, secret]) => `
  select vault.update_secret(id, ${literal(secret)}) from vault.secrets where name = ${literal(name)};
  select vault.create_secret(${literal(secret)}, ${literal(name)}) where not exists (select 1 from vault.secrets where name = ${literal(name)});`).join('')
// Sent on stdin, so the secret never appears in a process list.
execSync(`psql ${DB} -q -v ON_ERROR_STOP=1 -At`, { input: `begin;${upserts}\ncommit;`, stdio: ['pipe', 'ignore', 'inherit'] })
const stored = execSync(`psql ${DB} -At -c "select count(*) from vault.decrypted_secrets where name in ('docusign_send_url', 'docusign_send_key')"`).toString().trim()
if (stored !== '2') fail('Vault secrets not stored')
console.log('PASS  Vault: docusign_send_url + docusign_send_key stored')
console.log('\nNow restart `npm run functions:serve` so the functions read the new env file.')
