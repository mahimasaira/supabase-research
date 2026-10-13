// Local setup for feature 5 (bulk reminders): npm run probe:reminders:setup
// Vault (local database): reminders_url (the send-reminders Edge Function, as seen from inside
// Docker) and edge_function_key (the project's secret key), used by public.invoke_edge_function.
// Never prints a secret.
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const status = JSON.parse(execSync('npx supabase status -o json < /dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
if (!status.SECRET_KEY) { console.error('FAIL  could not read SECRET_KEY from `supabase status`'); process.exit(1) }
const secrets = { reminders_url: 'http://kong:8000/functions/v1/send-reminders', edge_function_key: status.SECRET_KEY }
const literal = (s) => `'${s.replace(/'/g, "''")}'`
const sql = Object.entries(secrets).map(([name, secret]) => `
  select vault.update_secret(id, ${literal(secret)}) from vault.secrets where name = ${literal(name)};
  select vault.create_secret(${literal(secret)}, ${literal(name)}) where not exists (select 1 from vault.secrets where name = ${literal(name)});`).join('')
// On stdin, so the secret never shows up in a process list.
execSync(`psql ${DB} -q -v ON_ERROR_STOP=1 -At`, { input: `begin;${sql}\ncommit;`, stdio: ['pipe', 'ignore', 'inherit'] })
console.log('PASS  Vault: reminders_url + edge_function_key stored')
