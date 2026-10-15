// npm run hosted:scan: the exposure scan (src/probes/security/exposure-scan.mjs) against the
// hosted project, with the probe-only objects expected closed (PROBES_LOCKED=1).
import { spawnSync } from 'node:child_process'
import { URL, KEY, requireLockdown } from './hosted-env.mjs'

requireLockdown()
const r = spawnSync('node', ['src/probes/security/exposure-scan.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: URL, VITE_SUPABASE_ANON_KEY: KEY, SCAN_DB_URL: process.env.HOSTED_DB_URL, PROBES_LOCKED: '1' },
})
process.exit(r.status ?? 1)
