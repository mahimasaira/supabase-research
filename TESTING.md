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
| `npm run probe:docusign:proof:receive` | `All checks passed` (19); section B sends + voids one real envelope |
| `npm run probe:docusign:proof:failures` | `All checks passed` (17); ~2 min; section 5 sends + voids one real envelope |
| `npm run probe:spam:flood` | `SKIP` since stage 2 (limits stop it); stage 1 output in `evidence/` |
| `npm run probe:spam:proof:limits` | `All checks passed` (15) |

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
| `npm run probe:docusign:proof:receive` | `All checks passed` (19). Section B sends + voids **1 real envelope** to `DOCUSIGN_TEST_SIGNER_EMAIL` (2 emails) |
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
