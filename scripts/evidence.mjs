// Runs proof scripts and saves their output as evidence for the blog (see BLOG_EVIDENCE.md).
//
//   npm run evidence -- probe:docusign:proof:failures     one proof
//   npm run evidence -- all                               every proof, in order
//   npm run evidence -- all --no-email                    skip sections that send real DocuSign emails
//
// Output still shows in the terminal; a copy goes to evidence/<date>_<time>_<commit>_<script>.txt
// (git-ignored) with a header: when, which commit, uncommitted changes or not, exit code.
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const ALL = [
  'test:rls',
  'probe:recurring:edge-proof',
  'probe:audit:proof',
  'probe:audit:proof:triggers',
  'probe:audit:compare',
  'probe:audit:proof:history',
  'probe:docusign:proof:pending',
  'probe:docusign:proof:send',
  'probe:docusign:proof:receive',
  'probe:docusign:proof:failures',
  'probe:spam:flood',
  'probe:spam:proof:limits',
  'probe:spam:proof:captcha',
  'probe:spam:compare',
  'probe:reminders:naive',
  'probe:reminders:proof:queue',
]
const args = process.argv.slice(2)
const noEmail = args.includes('--no-email')
const names = args.filter((a) => !a.startsWith('--'))
const scripts = names[0] === 'all' ? ALL : names
if (scripts.length === 0) {
  console.error(`Usage: npm run evidence -- <script | all> [--no-email]\nScripts: ${ALL.join(', ')}`)
  process.exit(1)
}

const git = (cmd) => execSync(`git ${cmd}`).toString().trim()
const commit = git('rev-parse --short HEAD')
const dirty = git('status --porcelain') !== ''
const branch = git('rev-parse --abbrev-ref HEAD')
mkdirSync('evidence', { recursive: true })

// An environment variable set here wins over node --env-file, so the proofs see no test email.
const env = { ...process.env, ...(noEmail ? { DOCUSIGN_TEST_SIGNER_EMAIL: '' } : {}) }

const summary = []
for (const name of scripts) {
  const started = new Date()
  const output = await new Promise((resolve) => {
    let text = ''
    const child = spawn('npm', ['run', '-s', name], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { text += chunk; process.stdout.write(chunk) })
    }
    child.on('close', (code) => resolve({ text, code }))
  })
  const stamp = started.toISOString().replace(/:\d\d\.\d+Z$/, '').replace('T', '_').replace(':', '')
  const file = `evidence/${stamp}_${commit}${dirty ? '-dirty' : ''}_${name.replace(/:/g, '-')}.txt`
  writeFileSync(file, [
    `script:  npm run ${name}${noEmail ? '   (--no-email: real DocuSign sections skipped)' : ''}`,
    `when:    ${started.toISOString()}`,
    `commit:  ${commit} on ${branch}${dirty ? ' (with uncommitted changes)' : ''}`,
    `exit:    ${output.code}`,
    '',
    output.text,
  ].join('\n'))
  summary.push(`${output.code === 0 ? 'ok  ' : 'FAIL'}  ${name}  →  ${file}`)
}
console.log(`\nSaved:\n${summary.join('\n')}`)
