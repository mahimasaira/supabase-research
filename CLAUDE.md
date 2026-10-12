# CLAUDE.md

## What this project is

A research project for a technical blog comparing **Supabase** with a **traditional backend**.
The question: where is Supabase enough on its own, and where does a dedicated backend become necessary?

The same booking app is built twice, sharing one Vue frontend:

1. **Supabase version**: all database access from the browser via supabase-js, plus Postgres functions and Edge Functions where needed. No custom server.
2. **NestJS version** (later, separate branch): a separate backend in `backend/` with its own Postgres database and its own authentication (NestJS handles login itself, no Supabase Auth).

## Branches

| Branch | Stacked on | Contents |
|---|---|---|
| `main` | — | Supabase core: auth, slots, booking, RLS, realtime, storage. Tagged `baseline`. **Don't modify core behaviour.** |
| `feature/msa-supabase-advanced` ("supabase-advanced") | `main` | Advanced features built with Supabase (current work). |
| `nestjs-backend` (later) | supabase-advanced | The NestJS version of everything. |

## Advanced features (this branch, in order)

1. Recurring bookings & transactions (in progress, see below)
2. Audit log
3. Spam protection (rate limiting for anonymous bookings)
4. Third-party integration with webhooks (payment or e-signature, provider still being decided)
5. Bulk reminders
6. Weekly availability & time zones

### Feature 1 status: recurring bookings (showcases transactions)

A guest books the same weekly slot (same weekday + time) for N weeks. Creates a `booking_series` row, one booking per week linked to it, and each week's slot marked taken. **All-or-nothing**: if any week clashes, nothing is created and the guest is told which week.
Three stages, each selectable on the probe page via `bookRecurring()`:

1. Split supabase-js calls from the browser (shows the partial-write problem)
2. Postgres function via `supabase.rpc()`, `SECURITY INVOKER` so RLS applies
3. Edge Function with a direct Postgres connection (BEGIN/COMMIT/ROLLBACK), verifying the user's JWT and applying their identity so RLS still applies

The earlier "3-step split booking" transactions probe (`src/probes/transactions/`, `probe_*` tables) was removed and replaced by this feature.

Where things are: migration `supabase/migrations/20261009212046_recurring_bookings.sql`, probe page `/probes/recurring` (`src/probes/recurring/`), seed/reset `npm run probe:recurring:seed` (test host `recurring-host@test.dev` / `password123`, fixed id `11111111-1111-4111-8111-111111111111`, 6 Mondays 10:00 UTC, week 4 pre-booked), Studio check query `src/probes/recurring/sql/check.sql`, implementations in `src/services/supabase/recurring/`.
Status: all 3 stages done. Stage 2 = `book_recurring` (migration `20261012071039_recurring_bookings_rpc.sql`, proof `src/probes/recurring/sql/rpc-rls-proof.sql`). Stage 3 = Edge Function `supabase/functions/book-recurring/` (direct connection as `postgres`, verifies apikey/JWT itself, `set_config('role')` + `request.jwt.claims` per transaction so RLS applies; `verify_jwt = false` in config.toml). Local: `npm run functions:serve` must run for stage 3; proof: `npm run probe:recurring:edge-proof`.

### Feature 2 status: audit log (stage 1 done: browser logging, `audit_log_client`, migration `20261012111921_audit_log_client.sql`, page `/probes/audit`, `npm run probe:audit:seed` / `probe:audit:proof`; stage 2 triggers next)

Decisions (agreed 2026-10-12):
- **Log:** bookings (create/cancel), slots (create/move/delete), booking series, profile changes. Login events are left to Supabase Auth's own logs (note in friction log).
- **Actor:** user id + role from the JWT; anonymous guests are recorded as role `anon` with no id. No IP addresses (personal data). Never copy secrets (`cancel_token`) into the log.
- **Content:** only changed fields, guest emails masked (e.g. `g***@example.com`).
- **Readers:** a host reads entries about their own slots/bookings only (RLS). Nobody can edit or delete entries.
- **Stages:** 1. log from the browser (show the problem), 2. database triggers, 3. compare with `supa_audit` (not in the local image; only `pgaudit`, which logs to server logs, is available), 4. host history page.
- Folder `src/probes/audit/`, own migration per stage.

## Rules for all work on this branch

- **Pages only call functions from `src/services/`** (e.g. `bookSlot()`, `bookRecurring()`), never `supabase` directly. Supabase calls live in `src/services/supabase/`. Later `src/services/nestjs/` provides the same function names, switched with `VITE_BACKEND=supabase|nestjs`.
  - Existing core pages that still call supabase directly (not yet refactored, leave as is unless asked): `src/views/BookView.vue`, `src/views/DashboardView.vue`, `src/views/CancelView.vue`, `src/components/ProfileCard.vue`, `src/composables/useAuth.js`, `src/composables/useSlotChannel.js`.
- **One folder and one migration file per feature** (e.g. `src/probes/<feature>/`, `supabase/migrations/<timestamp>_<feature>.sql`).
- **Don't hide or silently work around Supabase limitations.** Record them in `FRICTION_LOG.md`.
- **Never put the service_role / secret key in the frontend** (no `VITE_` variable, no browser code).
- The author is new to Supabase: **explain each step in simple terms.**
- **Stop after each stage** so the author can test and commit. After each stage, add a `FRICTION_LOG.md` entry (effort, files and lines changed, how easy to test/debug, surprises).

## Local dev

- `npm run db:start` / `db:stop` / `db:reset` / `db:status` (local Supabase via Docker, Postgres on `127.0.0.1:54322`)
- `npm run dev` (Vite on 127.0.0.1)
- `npm run test:rls` (RLS checks in `scripts/test-rls.mjs`)
- Only the publishable/anon key is in `.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
- Core design notes: `README.md`, `RLS_RULES.md`, and the comments in `supabase/migrations/`.
