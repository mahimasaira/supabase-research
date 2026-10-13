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

1. Recurring bookings & transactions (done)
2. Audit log (done)
3. Spam protection (rate limiting for anonymous bookings) (done): stage 1 done (flood script `npm run probe:spam:flood`, separate test host `spam-host@test.dev` id 22222222-…, seed `npm run probe:spam:seed`); stage 2 done (trigger `bookings_enforce_limits` with advisory locks, 429 via PT429, `rate_limit_settings` / `booking_rate_events`, hashed IPs from the LAST X-Forwarded-For entry; migration `20261013213015_spam_limits.sql`; `npm run probe:spam:proof:limits`). Stage 3 done: host opt-in `profiles.require_captcha`; Edge Function `book-slot` verifies Turnstile (test keys via `npm run probe:spam:setup`) and books with `app.captcha_verified`; trigger `bookings_check_captcha` refuses other API bookings (403); identity/IP/CAPTCHA shared in `supabase/functions/_shared/caller.ts` (book-recurring uses it too); BookView books via `bookSlot()` in services; `npm run probe:spam:proof:captcha`. Stage 3b (Supabase-native CAPTCHA via anonymous sign-in) skipped by decision, reasoning in FRICTION_LOG. Stage 4 done: `npm run probe:spam:compare` (none / limits / limits + CAPTCHA). **Feature 3 complete.** Decisions (2026-10-14): IP addresses may be used for rate limiting only, **hashed and deleted after a day** (privacy trade-off, log it); CAPTCHA provider **Cloudflare Turnstile** (official test keys, no account needed); default limits **max 3 active bookings per email per host**, **max 10 bookings per host per 10 minutes**. Stages: 1 show the problem (flood script), 2 database limits (trigger, then try to get around them), 3 CAPTCHA (anonymous sign-in with CAPTCHA vs. Edge Function), 4 compare. Folder `src/probes/spam/`.
4. Third-party integration with webhooks (done): e-signature with **DocuSign** (demo account; JWT grant verified with `scripts/docusign-check.mjs`, values in `.env.local`, private key `docusign_private.key` git-ignored). In progress: host opt-in (`profiles.require_signature`), signing by email, webhooks tested with simulated messages + status-check fallback. Stage 1 done: `pending_signature` booking state holds the slot (migration `20261012220021_docusign_pending_signature.sql`, `src/features/docusign/`, `npm run probe:docusign:proof:pending`). Stage 2 done: trigger + pg_net → Edge Function `docusign-send` (`supabase/functions/_shared/docusign.ts`) creates the envelope; config in Vault + `supabase/functions/.env` via `npm run probe:docusign:setup`; proof `npm run probe:docusign:proof:send` (sends real mail to `DOCUSIGN_TEST_SIGNER_EMAIL`). Proof scripts that book with fake emails must switch sending off (Vault URL). Stage 3 done: `docusign-webhook` (HMAC-verified Connect messages, simulated locally) + `docusign-sync` (host's "Check signature status" button) → `docusign_apply_envelope_status` (signed → confirmed, declined/voided → cancelled; only pending bookings change); proof `npm run probe:docusign:proof:receive`. Stage 4 done: drawbacks proven first (`npm run probe:docusign:proof:failures`, 11/17 failed before), then fixed with pg_cron (`docusign-retry-sends` every minute, `docusign-expire-unsigned` every 5 min), a void-on-cancel trigger + Edge Function `docusign-void` (migration `20261013095757_docusign_reliability.sql`). **Feature 4 complete.** Caution: the retry job sends any waiting booking; proofs that use fake emails must keep the Vault function URLs unreachable until their data is reset.
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

### Feature 2 status: audit log (stage 1 done: browser logging, `audit_log_client`, migration `20261012111921_audit_log_client.sql`, page `/probes/audit`, `npm run probe:audit:seed` / `probe:audit:proof`; stage 2 done: triggers write `audit_log`, migration `20261012160421_audit_log_triggers.sql`, `npm run probe:audit:proof:triggers`, Studio `src/probes/audit/sql/check-triggers.sql`; stage 3 done: supa_audit vendored + patched in `20261012182300_audit_supa_audit.sql` (tracks the same 4 tables), pgaudit only switched on by `npm run probe:audit:compare`; stage 4 done: `/history` page (`src/features/audit/`), `context` column + supa_audit removed in migrations `20261012214557` / `20261012214601`, `npm run probe:audit:proof:history`. Feature 2 complete.)

Decisions (agreed 2026-10-12):
- **Log:** bookings (create/cancel), slots (create/move/delete), booking series, profile changes. Login events are left to Supabase Auth's own logs (note in friction log).
- **Actor:** user id + role from the JWT; anonymous guests are recorded as role `anon` with no id. No IP addresses (personal data). Never copy secrets (`cancel_token`) into the log.
- **Content:** only changed fields, guest emails masked (e.g. `g***@example.com`).
- **Readers:** a host reads entries about their own slots/bookings only (RLS). Nobody can edit or delete entries.
- **Stages:** 1. log from the browser (show the problem), 2. database triggers, 3. compare with `supa_audit` (not in the local image; only `pgaudit`, which logs to server logs, is available), 4. host history page.
- Folder `src/probes/audit/`, own migration per stage.

## Rules for all work on this branch

- **Pages only call functions from `src/services/`** (e.g. `bookSlot()`, `bookRecurring()`), never `supabase` directly. Supabase calls live in `src/services/supabase/`. Later `src/services/nestjs/` provides the same function names, switched with `VITE_BACKEND=supabase|nestjs`.
  - Existing core pages that still call supabase directly (not yet refactored, leave as is unless asked): `src/views/BookView.vue` (except booking itself, which uses `bookSlot()` since spam stage 3), `src/views/DashboardView.vue`, `src/views/CancelView.vue`, `src/components/ProfileCard.vue`, `src/composables/useAuth.js`, `src/composables/useSlotChannel.js`.
- **One folder and one migration file per feature** (e.g. `src/probes/<feature>/`, `supabase/migrations/<timestamp>_<feature>.sql`).
- **Don't hide or silently work around Supabase limitations.** Record them in `FRICTION_LOG.md`.
- **Never put the service_role / secret key in the frontend** (no `VITE_` variable, no browser code).
- The author is new to Supabase: **explain each step in simple terms.**
- **Stop after each stage** so the author can test and commit. After each stage, add a `FRICTION_LOG.md` entry (effort, files and lines changed, how easy to test/debug, surprises).
- **Blog evidence:** the author documents in one pass at the end. After each stage, add that stage's section to `BLOG_EVIDENCE.md` (screenshots to take, commands, commit, one-line takeaway) and save proof outputs with `npm run evidence -- <proof>` (git-ignored `evidence/`). For "show the problem" stages, save the failing run **before** building the fix.

## Local dev

- `npm run db:start` / `db:stop` / `db:reset` / `db:status` (local Supabase via Docker, Postgres on `127.0.0.1:54322`)
- `npm run dev` (Vite on 127.0.0.1)
- `npm run test:rls` (RLS checks in `scripts/test-rls.mjs`)
- Only the publishable/anon key is in `.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
- Core design notes: `README.md`, `RLS_RULES.md`, and the comments in `supabase/migrations/`.
- Testing cheatsheet: `TESTING.md` (update it after each stage). Blog evidence checklist: `BLOG_EVIDENCE.md`; saved proof outputs: `npm run evidence -- <script | all> [--no-email]`.
