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

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Fewer Mondays than expected, odd clashes | leftovers from earlier runs (stage 1 leaves partial bookings). Reseed |
| Test host missing, "Test host not found" | `npm run test:clean` deletes all `@test.dev` users. Reseed |
| `functions:serve`: "No such container: supabase_edge_runtime…" | `npx supabase stop && npx supabase start`, then `npm run functions:serve` again (keeps data) |
| Edge Function returns 503 right after a file save | hot reload; retry after a second |
| Stage 3 / edge-proof fails to connect | `functions:serve` isn't running |
| Results show your host instead of `anon` | you're logged in. Log out to test as a guest |
| Changed a migration that was already applied | `npm run db:reset` re-runs all migrations but **wipes local data**; reseed afterwards |
