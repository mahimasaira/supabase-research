# Testing cheatsheet

Quick reference for testing the probes on `feature/msa-supabase-advanced`. Update it with each new stage.

## Setup

| What | Command / URL |
|---|---|
| Start local Supabase (Docker must be running) | `npm run db:start` |
| Serve Edge Functions (own terminal, keep running) | `npm run functions:serve` |
| App | `npm run dev` → http://127.0.0.1:5173 |
| Studio (SQL Editor, Table Editor) | http://127.0.0.1:54323 |
| Test host login | `recurring-host@test.dev` / `password123` |
| Guest = anonymous | **log out** first (logged-in requests run as that user) |

## Reset test data

| Command | Gives you |
|---|---|
| `npm run probe:recurring:seed` | test host, 6 Mondays 10:00 UTC, **week 4 booked** by "Someone Else", 0 series. Prints `OK: test host reset` |
| `npm run probe:audit:seed` | the above **+** both audit logs emptied. Prints 3 `OK` lines |

Reset before every manual test: leftovers from earlier runs change the results.

## Automated checks (run these first)

| Command | Expected last line | Needs `functions:serve` |
|---|---|---|
| `npm run test:rls` | `60/60 passed` (then `npm run test:clean`) | no |
| `npm run probe:recurring:edge-proof` | `All checks passed` (17) | **yes** |
| `npm run probe:audit:proof` | `All demos reproduced` (19) | no |
| `npm run probe:audit:proof:triggers` | `All checks passed` (21, no SKIP) | for section 4 |
| `npm run probe:audit:compare` | `SKIP` since stage 4 (supa_audit removed); see commit `603a771` | no |
| `npm run probe:audit:proof:history` | `All checks passed` (12) | no |
| `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f src/probes/recurring/sql/rpc-rls-proof.sql` | part 1: RLS **error**, part 2: success | no |
| `npm run build` | `✓ built` | no |

All probe scripts reset the test data before and after.

## Feature 1: recurring bookings (`/probes/recurring`)

Seed, log out, pick a stage, book **first Monday × 6 weeks**:

| Stage | Page shows | `recurring/sql/check.sql` query 1 |
|---|---|---|
| 1 Split calls | 🔴 week 4 not available + 🟠 "still saved: series, weeks 1, 2, 3" | `6 \| 3 \| 1, 2, 3` (half-finished) |
| 2 rpc | 🔴 week 4 + 🟢 "rolled back" | **no rows** |
| 3 Edge Function | same as 2 + "ran as role `anon`" | **no rows** |

Other cases (any stage):

| Do | Expect |
|---|---|
| 5th Monday × 6 weeks | "Only 2 weeks available", nothing saved |
| 5th Monday × 2 weeks | 🟢 booked; query 1 shows `2 \| 2` |
| Stage 3 while logged in | "ran as role `authenticated`, auth.uid() = your id" |

## Feature 2: audit log (`/probes/audit`)

### Stage 1: browser log (`audit/sql/check.sql`)

Seed, log out:

| Order | "Make log fail" | Slot | Verdict |
|---|---|---|---|
| Act first | off | free | 🟢 saved and logged |
| Act first | **on** | free | 🟠 saved, **no entry** |
| Log first | **on** | free | ⚪ nothing happens |
| Log first | off | **"Book again"** (taken) | 🔴 entry, **no booking** |
| Act first | off | **"Book again"** (taken) | ⚪ nothing happens |
| "Write a fake … entry" | | | 🔴 fake entry accepted |

`check.sql` query 3 lists the 🔴 entries ("no such booking", "slot still exists").

### Stage 2: trigger log (`audit/sql/check-triggers.sql`)

After the stage 1 table above, in Studio:

| Query | Expect |
|---|---|
| 1 (trigger log) | only **real** changes: role `anon`, no `actor_id`, real `record_id`, masked email, no `cancel_token`. Nothing for ⚪/🔴 rows |
| 2 (side by side) | 🟠 booking: `in_browser_log = false`, `in_trigger_log = true` |
| 3 (ghost entries) | **empty** |

Paths stage 1 never logged (look at query 1 after each, reseed in between):

| Do | Expect in `audit_log` |
|---|---|
| Recurring rpc, first Monday × 6 (clash) | **nothing** (rolled back) |
| Recurring rpc, 5th Monday × 2 | `series.created` + 2 × `booking.created`, **same `tx_id`** |
| Recurring Edge Function (logged in) | 3 entries with **your** `actor_id` |
| Host logged in: cancel a booking / delete a free slot | `booking.cancelled` / `slot.deleted`, `actor_id` = host |
| Studio Table Editor: rename the host in `profiles` | `profile.updated`, display_name from → to, actor = database user, **no `actor_id`** |

Cheating must fail (browser console on the probe page, logged out):

```js
const key = '<VITE_SUPABASE_ANON_KEY from .env.local>'
await fetch('http://127.0.0.1:54321/rest/v1/audit_log', {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ actor_role: 'anon', action: 'slot.deleted', table_name: 'slots', record_id: crypto.randomUUID() }),
}).then((r) => r.json())
// → { code: '42501', message: 'permission denied for table audit_log' }
```

### Stage 3: supa_audit and pgaudit vs. our triggers

> supa_audit was removed again in stage 4. To re-run this section: `git checkout 603a771`, `npm run db:reset` (wipes local data).

| Do | Expect |
|---|---|
| `npm run probe:audit:compare` (~30 s, restarts the local API container twice) | `All checks passed` (11) and a per-action table of what each tool recorded |
| Studio: `select op, table_name, auth_role, auth_uid, record from audit.record_version order by id` after using the app | supa_audit's entries: full rows incl. email and `cancel_token`, extra `slots UPDATE` per booking |
| Sign up a new account | works (the supa_audit migration includes the fix that keeps sign-up from failing) |

pgaudit is only on while the compare script runs. To look at it yourself: `docker logs supabase_db_supabase-booking 2>&1 | grep AUDIT` during the run.

### Stage 4: host history page (`/history`)

| Do | Expect |
|---|---|
| `npm run probe:audit:proof:history` | `All checks passed` (12), and a printout of what the page shows |
| Seed, log in as the test host, open **History** in the top bar | "Nothing yet." |
| Log out, book a slot (`/book/11111111-1111-4111-8111-111111111111`), log in, Refresh | "Guest booked Mon … for <name> (x\*\*\*@…)" |
| `/probes/recurring`, Stage 2, 5th Monday × 2 weeks, then History | **one** line: "Guest booked 2 weeks from … for …" |
| As host on Dashboard: cancel that booking, delete a free slot | "You cancelled …", "You deleted the slot …" |
| Studio: rename the host in `profiles` | "Database admin renamed the page …" |
| Filter "Slots" / "Bookings" / "Profile" | only those entries |
| Log in as another account, open History | "Nothing yet." (only their own sign-up at most) |

## Feature 4: DocuSign e-signature

| Do | Expect |
|---|---|
| `node --env-file=.env.local scripts/docusign-check.mjs` | 4 PASS lines + account name (DocuSign setup works) |
| `npm run probe:docusign:proof:pending` | `All checks passed` (15); switches sending off while it runs |
| `npm run probe:docusign:proof:send` | `All checks passed` (13); section B sends real emails to `DOCUSIGN_TEST_SIGNER_EMAIL` |
| `npm run probe:docusign:proof:receive` | `All checks passed` (24); section B sends + voids one real envelope |
| `npm run probe:docusign:proof:failures` | `All checks passed` (17); ~2 min; section 5 sends + voids one real envelope |
| `npm run probe:spam:flood` | `SKIP` since stage 2 (limits stop it); stage 1 output in `evidence/` |
| `npm run probe:spam:proof:limits` | `All checks passed` (15) |
| `npm run probe:spam:proof:captcha` | `All checks passed` (15); needs `functions:serve` |
| `npm run probe:spam:compare` | comparison table + `All checks passed` (8); ~2 min |
| `npm run probe:reminders:naive` | `All problems reproduced` (feature 5, stage 1: shows the problem); ~1.5 min |
| `npm run probe:reminders:proof:queue` | `All checks passed` (11); ~2 min |
| `npm run probe:reminders:proof:optout` | `All checks passed` (15); ~3 min |
| `npm run probe:reminders:compare` | comparison table + `All checks passed` (6); ~4 min |

### Stage 1: bookings that wait for a signature (no DocuSign calls yet)

Seed (`npm run probe:recurring:seed`), log in as the test host:

| Do | Expect |
|---|---|
| Dashboard: tick **Require a signed agreement** | stays ticked after reload |
| Log out, book a slot on `/book/11111111-1111-4111-8111-111111111111` | green box "**Held for you**: …" + "Check your email and sign it…"; in "Your bookings": "Awaiting your signature" |
| Same page, other browser/tab | that slot is no longer offered |
| Log in as host, Dashboard | slot shows "**Awaiting signature from** …" (amber); All bookings: "awaiting signature" |
| Host: Cancel booking (or guest: Cancel / cancel link) | booking cancelled, slot free again |
| Untick the setting, book another slot as a guest | "Booked: …" (confirmed straight away) |

Since stage 2 this **sends a real agreement** to the email you enter as the guest. Use your own address (or switch sending off: `npm run probe:docusign:setup` restores it).

### Stage 2: sending the agreement

One-time setup (again after `npm run db:reset` or when DocuSign values change):

```bash
npm run probe:docusign:setup     # writes supabase/functions/.env + Vault secrets, prints no values
# then restart: npm run functions:serve
```

| Do | Expect |
|---|---|
| `npm run probe:docusign:proof:send` | `All checks passed` (13). Section B needs `DOCUSIGN_TEST_SIGNER_EMAIL` in `.env.local` and sends **2 real agreements** there |
| Host opted in, guest books with **your** email | within seconds an email "Please sign: your booking with …" (check spam); the document lists host, guest, time(s) |
| Dashboard / History | History: "DocuSign sent the agreement to …"; booking still "awaiting signature" (signing confirms it: stage 3) |
| Recurring booking (`/probes/recurring`, Stage 2, 2 weeks) on an opt-in host | **one** email listing both weeks |
| Studio: `select guest_name, status, signature_status, envelope_id, signature_error from bookings order by created_at desc` | `sent` + an envelope id; on problems `failed` + the error |
| Studio: `select id, status_code, error_msg from net._http_response order by id desc` | did the database's call reach the function? (`200` = yes) |

### Stage 3: receiving the result

| Do | Expect |
|---|---|
| `npm run probe:docusign:proof:receive` | `All checks passed` (24). Section B sends + voids **1 real envelope** to `DOCUSIGN_TEST_SIGNER_EMAIL` (2 emails) |
| **Sign for real:** host opted in, guest books with **your** email, open the email, **Review Document → Sign → Finish** | DocuSign "completed" email |
| Then as host: Dashboard → **Check signature status** | "Checked 1: 1 signed …"; the slot shows "Booked by …" (green); guest page shows "Booked" instead of "Held for you" |
| History | "DocuSign · <guest> signed the agreement: booking on … confirmed" |
| **Decline instead:** in the email, **Other Actions → Decline to Sign**, then Check signature status | booking cancelled, slot free again; History "… declined the agreement …" |
| Check signature status with nothing out | "No agreements are waiting." |

The webhook (`docusign-webhook`) can't receive real DocuSign messages locally (needs a public URL); the proof script sends it simulated, correctly signed ones.

### Stage 4: when things go wrong

| Do | Expect |
|---|---|
| `npm run probe:docusign:proof:failures` (~2 min, waits for a pg_cron run) | `All checks passed` (17). Section 5 sends + voids **1 real envelope** |
| **Lost send:** stop `functions:serve`, book with your email (opt-in host), start it again | within ~2–3 min the agreement arrives anyway (retry job); Dashboard meanwhile may show "sending the agreement failed, retrying" |
| **Cancel withdraws:** book with your email, wait for the email, cancel (guest or host) | a "voided" email from DocuSign; the agreement can't be signed anymore; History "DocuSign · the agreement was voided …" |
| **Expiry:** Studio `update bookings set created_at = now() - interval '3 days' where …` on a waiting booking, then `select public.docusign_expire_unsigned()` | booking cancelled, slot free, agreement voided; History "Scheduler · the agreement wasn't signed in time …" |
| Studio: `select jobname, schedule from cron.job` / `select * from cron.job_run_details order by start_time desc limit 5` | the two `docusign-*` jobs, recent runs `succeeded` |

Since stage 4 the retry job sends any waiting booking every minute: **only book with real addresses you own** while a host requires signatures.

## Feature 3: spam protection

Separate test host `spam-host@test.dev` / `password123` with 50 slots: `npm run probe:spam:seed` (also resets).

### Stage 1: show the problem

| Do | Expect |
|---|---|
| `npm run probe:spam:flood` | `All problems reproduced`: 50 slots in ~250 ms, 50 bookings for one email, ~500 writes/s without a 429, 50 DocuSign send requests (sending switched off) |
| Open the spam host's booking page (`/book/22222222-2222-4222-8222-222222222222`), run the flood | all slots disappear within a second (Realtime) |
| Log in as `spam-host@test.dev` → Dashboard | 50 bookings by "Bot …" |

The script resets the spam host afterwards and switches DocuSign sending back on only after the fake bookings are gone.

Since stage 2 the flood script prints `SKIP` (the limits stop it); its stage 1 output is in `evidence/`.

### Stage 2: limits inside the database

| Do | Expect |
|---|---|
| `npm run probe:spam:proof:limits` | `All checks passed` (15): attacks stopped (10 of 50, 3 per email), fake IP headers don't help, WEAKNESS checks pass (= demonstrated) |
| As a guest, book the same host 4 times with the same email | 4th: "You already have 3 active bookings with this host." |
| Book 11 slots of the spam host quickly (any emails) | 11th: "This host is receiving too many bookings right now…" |
| Studio: `select * from rate_limit_settings` | current limits; change them to experiment (`npm run probe:spam:seed` restores defaults) |
| Studio: `select host_id, ip_hash, created_at from booking_rate_events order by created_at desc` | hashed IPs only; rows older than a day are removed hourly |

### Stage 3: CAPTCHA (Cloudflare Turnstile test keys)

One-time: `npm run probe:spam:setup` (puts the test secret into `supabase/functions/.env`), `npm run functions:serve` running.

| Do | Expect |
|---|---|
| `npm run probe:spam:proof:captcha` | `All checks passed` (15) |
| Log in as `spam-host@test.dev`, tick **Require a CAPTCHA** | stays ticked after reload |
| Log out, open the spam host's booking page, pick a slot | a Cloudflare "Success!" box (test key passes automatically); **Book this slot** enabled only after it |
| Book | "Booked: …" as usual |
| Browser console / curl: direct insert into `bookings` for that host | `403` "This host requires a CAPTCHA check" |
| Untick the setting | no widget; booking works as before |

With the test keys every check passes; real bot detection needs real keys from the Cloudflare dashboard (`VITE_TURNSTILE_SITE_KEY` in `.env.local`, `TURNSTILE_SECRET_KEY` via `probe:spam:setup`).

### Stage 4: all layers compared

| Do | Expect |
|---|---|
| `npm run probe:spam:compare` (~2 min, needs `functions:serve`) | a table (none / limits / limits + CAPTCHA) and `All checks passed` (8): takeover 50 → 10 → 0, real guest ❌ ❌ ✅, DocuSign emails 50 → 10 → 0 |

## Feature 5: bulk reminders

Separate test host `reminder-host@test.dev` / `password123` with 200 confirmed bookings starting in ~24 h: `npm run probe:reminders:seed` (also resets). One-time: `npm run probe:reminders:setup`. Emails go to **Mailpit** only: http://127.0.0.1:54324. The hourly job `send-reminders` exists but is **switched off** in stage 1.

### Stage 1: the naive version (shows the problem)

| Do | Expect |
|---|---|
| `npm run probe:reminders:naive` (~1.5 min, needs `functions:serve`) | `All problems reproduced`: A works on a quiet day; B 120 guests reminded twice after a crash + retry; C the scheduler's request times out while the function keeps sending; D overlapping runs remind everyone twice |
| `npm run probe:reminders:naive -- --with-time-limit` | also E: how long one call may run locally (takes several minutes) |
| Open Mailpit **while** the script runs | reminder emails arriving; in B/D the same guest twice |
| Seed, then in Studio: `select public.run_reminders('{"hostId": "33333333-3333-4333-8333-333333333333"}')` | 200 reminders in Mailpit; open one: host, time (UTC), cancel link |

The script deletes only its own test emails (`…@reminder-test.example`) from Mailpit afterwards.

### Stage 2: Supabase Queues (pgmq)

| Do | Expect |
|---|---|
| `npm run probe:reminders:proof:queue` (~2 min, needs `functions:serve`) | `All checks passed` (11): crash → 0 twice (worst case 1), overlapping workers → 0 twice, long run returns on time, cancelled skipped, failing address → 1 dead letter |
| Seed, then in Studio: `select public.enqueue_reminders('33333333-3333-4333-8333-333333333333')` | `200`; again → `0` (queued once) |
| Studio: `select * from pgmq.metrics('reminders')` / `select * from pgmq.q_reminders limit 5` | the queue: length, messages with `read_ct` and `vt` |
| Studio: `select public.process_reminders()`, wait a few seconds | 200 reminders in Mailpit; `pgmq.metrics` → 0 |
| Studio: `select * from pgmq.a_reminders` | the archive (dead letters after a failing address) |

### Stage 3: opt-out + sending limits

| Do | Expect |
|---|---|
| `npm run probe:reminders:proof:optout` (~3 min, needs `functions:serve`) | `All checks passed` (15): opt-outs respected (before and after queuing), one-click works, B1 shows the problem (dead letters), B2–B4 the fix (200/200, 0 dead letters) |
| Open any reminder in Mailpit | text ends with "Don't want reminders? …/reminders/unsubscribe/<token>"; **Headers** tab: `List-Unsubscribe`, `List-Unsubscribe-Post` |
| Open that link in the browser → **Stop reminders** | "Done. You will no longer receive booking reminder emails…" |
| `select public.enqueue_reminders('33333333-3333-4333-8333-333333333333')` afterwards | that guest isn't queued (199) |
| Studio: `select limit_per_second from test_mail_provider_settings` / `select accepted, count(*) from test_mail_provider_log group by 1` | the test provider's limit, accepted vs. refused (429) |

### Stage 4: the three versions compared

| Do | Expect |
|---|---|
| `npm run probe:reminders:compare` (~4 min, needs `functions:serve`) | a table naive / queue / queue + limits and `All checks passed` (6): crash → 120 / 0 / 0 twice, overlap → 200 / 0 / 0 twice, provider limit → 14 / 170 / 200 reminded |

Both jobs (`enqueue-reminders` hourly, `process-reminders` every minute) exist but are **switched off**; to try the real schedule: `select cron.alter_job(jobid, active := true) from cron.job where jobname in ('enqueue-reminders', 'process-reminders')` (switch off again afterwards, or every booking 23–25 h ahead gets a reminder in Mailpit).

## Security review

| Do | Expect |
|---|---|
| `npm run probe:security:advisors` | advisor JSON (12 items: `rls_enabled_no_policy` ×7, 2× `rls_policy_always_true`, `extension_in_public`, 2 performance) + linter warnings; all reviewed in FRICTION_LOG |
| `npm run probe:security:scan` (needs `functions:serve` for section 3, otherwise SKIP) | `All checks passed` (115): every table × anon/stranger matches the expected access, internal functions blocked, internal Edge Functions 401, storage folders private, series abuse limited (≤ quota, 0 of 40) |
| `npm run probe:security:sqli` | `All checks passed` (24): supabase-js filters treat SQL as text; the unsafe DEFINER function leaks other hosts' bookings, account emails and Vault secrets; the same function as INVOKER stays within RLS (own 2 bookings; auth.users/Vault refused) but still sends an HTTP request via pg_net; the safe one stops everything; afterwards both unsafe ones are locked |
| Studio: `select has_function_privilege('authenticated', 'public.sqli_search_bookings_unsafe(text)', 'execute'), has_function_privilege('authenticated', 'public.sqli_search_bookings_unsafe_invoker(text)', 'execute'), unsafe_enabled_until from sqli_probe_switch` | `f`, `f` and null (locked) |

The scan fails with "not reviewed" when a new table, function or Edge Function appears: add it to the expectations in `src/probes/security/exposure-scan.mjs` after deciding who may use it.

## Hosted checks (needs a free hosted project; see HOSTED_CHECKS.md)

| Do | Expect |
|---|---|
| `npm run hosted:preflight` (after `db push`, `hosted:lockdown`, deploying the two `hosted-*` functions) | `All preflight checks passed`: unsafe SQL-injection functions 404, `audit_log_client` refused, app functions not deployed, `hosted-probe` 401 without its token |
| `npm run hosted:facts` · `hosted:scan` · `hosted:ip` · `hosted:timeout` · `hosted:pgnet` | NOTE lines to record (hosted values next to the local ones); the scan: `All checks passed` |
| Any `hosted:*` script without `.env.hosted`, or pointed at 127.0.0.1 | refuses to start (exit 2); with probe objects open again: refuses (exit 3) |

## NestJS version

### N0: scaffold

| Do | Expect |
|---|---|
| `npm run backend:install` (once) | installs, ends with "Generated Prisma Client" |
| `npm run backend:db:start` | container `booking_nestjs_db` Healthy (port 5433; the Supabase stack can run at the same time) |
| `npm run backend:dev`, then `curl http://127.0.0.1:3000/health` | `{"status":"ok","database":"ok","postgres":"17.…"}` |
| `npm run backend:db:stop`, then `curl` again | the API keeps running but `/health` fails (500): the check really reaches the database |

### N1: shared scenario runner

| Do | Expect |
|---|---|
| `npm run scenarios:supabase` | `60/60 passed (backend: supabase)`: the same checks as `npm run test:rls`, same names and order |
| `npm run scenarios -- --backend nestjs` | "Backend "nestjs" not available: … built in stage N2" (exit 2) |
| Optional mutation test: in Studio `grant select on public.bookings to anon; create policy t on public.bookings for select to anon using (true);`, run both tests, then `drop policy t on public.bookings; revoke select on public.bookings from anon;` | both: 55/60, the same 5 FAILs; afterwards 60/60 again |

### N2: NestJS core

| Do | Expect |
|---|---|
| `npm run backend:db:start`, `npm run backend:migrate`, `npm run backend:dev` | API on 127.0.0.1:3000 |
| `npm run scenarios:nestjs` | `46/46 passed, 17 skipped (backend: nestjs)`; the SKIP lines name the reason (Supabase mechanics, live updates / avatars not built yet) |
| `npm run scenarios:supabase` | `63/63 passed` (core permissions 60 + core concurrency 3) |
| `VERBOSE=1 npm run scenarios:nestjs` | for every refused attack, the HTTP status and reason (401 / 403 / 404 / 400 / 409) |
| `curl -X POST 127.0.0.1:3000/slots -H 'Content-Type: application/json' -d '{}'` | 401 "Log in first" (every route is closed unless marked public) |
| Reset the NestJS database | `npm run backend:db:reset` (drops all data, re-applies migrations) |

### N3: the Vue app on NestJS

| Do | Expect |
|---|---|
| `npm run backend:dev` (API) and `VITE_BACKEND=nestjs npm run dev` (app) | a grey "backend: nestjs" badge in the header |
| Sign up, log in, log out | works; no email confirmation step; the session is in localStorage under `nestjs.session` |
| Dashboard | no CAPTCHA / signature settings, no History link; profile card: "Profile pictures aren't available on this backend yet."; changing the display name works |
| Add a slot, delete a free slot | listed as Free / removed |
| Logged out (or a private window): `/book/<host id>` → book a slot | confirmation with cancel link; the slot disappears |
| Host dashboard (reload: no live updates on NestJS until N4) | "Booked by …"; Cancel booking frees the slot |
| Guest: the cancel link → Cancel my booking | "Your booking was cancelled." |
| Token refresh: DevTools → Application → Local Storage → `nestjs.session`, change `accessToken` to anything, reload the dashboard | still loads; `refreshToken` has changed |
| Two tabs logged in, repeat the refresh test in both at the same time | both stay logged in (refreshes are serialised across tabs) |
| `npm run dev` without `VITE_BACKEND` | the Supabase app, unchanged |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Fewer Mondays than expected, odd clashes | leftovers from earlier runs (stage 1 leaves partial bookings). Reseed |
| Test host missing, "Test host not found" | `npm run test:clean` deletes all `@test.dev` users. Reseed |
| `functions:serve`: "No such container: supabase_edge_runtime…" | `npx supabase stop && npx supabase start`, then `npm run functions:serve` again (keeps data) |
| Edge Function returns 503 right after a file save | hot reload; retry after a second |
| Stage 3 / edge-proof fails to connect | `functions:serve` isn't running |
| Results show your host instead of `anon` | you're logged in. Log out to test as a guest |
| Agreement never arrives | Studio: `bookings.signature_status` / `signature_error`, then `net._http_response`; run `npm run probe:docusign:setup` and restart `functions:serve` |
| `supabase migration new` hangs | it's waiting for SQL on stdin; run it in a normal terminal, or add `< /dev/null` |
| Changed a migration that was already applied | `npm run db:reset` re-runs all migrations but **wipes local data**; reseed afterwards |
