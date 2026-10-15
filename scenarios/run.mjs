// Shared scenario runner: the same tests against either backend.
//   npm run scenarios -- --backend supabase                  all features
//   npm run scenarios -- --backend supabase core-permissions one feature
// Each feature (scenarios/features/*.mjs) talks only to the adapter (scenarios/adapters/<backend>.mjs).
// Output: PASS / FAIL / SKIP per check, like the proof scripts. SKIP = the backend doesn't have
// that part (yet), printed with the reason, never counted as passed.
import { readdirSync } from 'node:fs'

const args = process.argv.slice(2)
const backend = args[args.indexOf('--backend') + 1]
if (!args.includes('--backend') || !backend) {
  console.error('Usage: npm run scenarios -- --backend supabase|nestjs [feature …]')
  process.exit(2)
}
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--backend')
const all = readdirSync(new URL('./features', import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, '')).sort()
const features = wanted.length ? wanted : all
const unknown = features.filter((f) => !all.includes(f))
if (unknown.length) {
  console.error(`Unknown feature(s): ${unknown.join(', ')}. Available: ${all.join(', ')}`)
  process.exit(2)
}

const api = await import(`./adapters/${backend}.mjs`).catch((e) => {
  console.error(`Backend "${backend}" not available: ${e.message}`)
  process.exit(2)
})

const totals = { pass: 0, fail: 0, skip: 0 }
const failed = []
const t = {
  section: (title) => console.log(`\n# ${title}`),
  check(label, ok, detail = '') {
    totals[ok ? 'pass' : 'fail']++
    if (!ok) failed.push(label)
    const show = detail && (!ok || process.env.VERBOSE)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${show ? `\n      → ${detail}` : ''}`)
  },
  skip(label, reason) {
    totals.skip++
    console.log(`SKIP  ${label}  (${reason})`)
  },
  sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
}

console.log(`Backend: ${api.name}`)
try {
  for (const f of features) {
    const feature = await import(`./features/${f}.mjs`)
    console.log(`\n=== ${feature.name} ===`)
    await feature.run(t, api)
  }
} finally {
  await api.cleanup?.()
}

const total = totals.pass + totals.fail
console.log(`\n${totals.pass}/${total} passed${totals.skip ? `, ${totals.skip} skipped` : ''} (backend: ${api.name})`)
if (failed.length) console.log(`Failed:\n  - ${failed.join('\n  - ')}`)
process.exit(totals.fail ? 1 : 0)
