# Blog evidence checklist

What to capture for the blog post, stage by stage. The plan is to do it in **one pass at the end**; this list makes that pass mechanical. Tick items as you go. Updated after every stage (see CLAUDE.md).

**Text evidence is saved automatically:** `npm run evidence -- <proof script | all> [--no-email]` runs proof scripts and saves their output to `evidence/` (git-ignored) with date and commit. Run `npm run evidence -- all` once at the end (or `--no-email` to avoid real DocuSign mails).

## How to capture

- **Reset before each screenshot** so the data is clean: `npm run probe:audit:seed` (test host, 6 Mondays, week 4 taken, empty logs).
- **Test host:** `recurring-host@test.dev` / `password123`. **Guest:** logged out.
- **Names:** realistic made-up guests ("Anna", "Ben"); your own email only where an email must arrive. **Blur** real emails, envelope ids, keys.
- **File names:** `f<feature>-s<stage>-<what>.png`, e.g. `f1-s2-rpc-rollback-studio.png`.
- **Studio:** http://127.0.0.1:54323 → SQL Editor. Queries are in `src/probes/<feature>/sql/`.
- Per stage, aim for: **proof output** (from `evidence/`), **the app**, **Studio**, **10–20 lines of the key code**, the **friction-log entry**.

## Recreating a state that later stages changed

Only two stages need an old commit. Commit first, then:

```bash
git checkout <commit>
npm run db:reset                         # wipes local data, re-runs that commit's migrations
npm run probe:audit:seed                 # (+ npm run probe:docusign:setup for DocuSign stages)
# … screenshots …
git checkout feature/msa-supabase-advanced && npm run db:reset && npm run probe:docusign:setup
```

| Evidence | Commit |
|---|---|
| Audit stage 3: supa_audit installed (sign-up error unpatched, comparison printout, pgaudit lines) | `603a771` |
| DocuSign stage 4 "before": 11 failing checks | `e05501a` + run `proof-failures.mjs` from the current branch (text already saved in `evidence/…before-fixes…`) |

⚠️ **External dependency:** DocuSign screenshots need the **demo account** still active. Demo accounts can expire; don't leave these to the very end.

---

## Feature 1: Recurring bookings & transactions

Probe page: `/probes/recurring` (logged out). Studio: `src/probes/recurring/sql/check.sql`.

### Stage 1: separate browser calls (shows the problem) · commit `0930860`
- [ ] Page: Stage 1, first Monday × 6 → 🔴 "Week 4 … not available" **and** 🟠 "still saved: series …, weeks 1, 2, 3"
- [ ] Studio `check.sql` query 1: `6 | 3 | 1, 2, 3`
- [ ] Page: 5th Monday × 6 → "Only 2 weeks available …, nothing booked"
- [ ] Code: the loop in `src/services/supabase/recurring/split.js`
- **Takeaway:** each supabase-js call is its own transaction; nothing groups them.

### Stage 2: Postgres function via rpc · commit `8a0f06a`
- [ ] Page: Stage 2, same booking → 🔴 week 4 + 🟢 "Rolled back as one transaction"
- [ ] Studio `check.sql` query 1: **no rows**
- [ ] Terminal: `psql … -f src/probes/recurring/sql/rpc-rls-proof.sql` (part 1 RLS error as anon, part 2 success as owner)
- [ ] Code: `book_recurring` loop + `raise exception … using errcode = 'RB001'`
- **Takeaway:** atomic without a server, but the logic moved into SQL; INVOKER vs DEFINER trade-off.

### Stage 3: Edge Function with direct transaction · commit `acc4b4d`
- [ ] Page: Stage 3 → "ran as role `anon`, auth.uid() = null"; logged in → `authenticated` + your id
- [ ] Proof: `evidence/*_probe-recurring-edge-proof.txt` (forged tokens 401, RLS-only rule, race)
- [ ] Code: the `set_config('role', …)` + `request.jwt.claims` lines in `supabase/functions/book-recurring/index.ts`
- **Takeaway:** a direct connection is the owner and skips RLS unless you re-apply the identity yourself.

- [ ] **Summary table** "Recurring bookings: the three stages compared" (FRICTION_LOG.md)

---

## Feature 2: Audit log

Probe page: `/probes/audit`. History: `/history` (as host). Studio: `src/probes/audit/sql/check.sql`, `check-triggers.sql`.

### Stage 1: log written by the browser (shows the problem) · commit `5f85242`
- [ ] Page: all four verdicts: 🟢 act first, 🟠 act first + log fails, ⚪ log first + log fails, 🔴 log first + "Book again"
- [ ] Page: "Write a fake … entry" → accepted
- [ ] Studio `check.sql` query 3: ghost booking + forged deletion
- [ ] Proof: `evidence/*_probe-audit-proof.txt`
- **Takeaway:** anyone who can log can log anything; two requests can't stay in sync.

### Stage 2: database triggers · commit `c495c95`
- [ ] Studio `check-triggers.sql` query 2: 🟠 booking `in_browser_log = false`, `in_trigger_log = true`
- [ ] Studio: rename the host in Table Editor → `profile.updated` by `postgres`, no actor id
- [ ] Browser console: forging into `audit_log` → `42501` (snippet in TESTING.md)
- [ ] Proof: `evidence/*_probe-audit-proof-triggers.txt`
- [ ] Code: `audit_row_change` steps 1–3 (diff, strip secrets, mask email)
- **Takeaway:** triggers see every path in the same transaction; better than typical backend code.

### Stage 3: supa_audit and pgaudit vs. our triggers · commit `603a771` ⚠️ old commit
- [ ] Sign-up error with **unpatched** supa_audit: `500 "Database error saving new user"` (temporarily remove the 2-line PATCH in the migration before `db:reset`)
- [ ] `npm run probe:audit:compare` printout (what each tool recorded per action)
- [ ] pgaudit lines with `authenticator` and `<not logged>` (`docker logs -f … | grep AUDIT` during the compare run)
- [ ] Comparison table from FRICTION_LOG.md
- **Takeaway:** the "official" tools didn't fit: one archived and broke sign-up, the other can't see who.

### Stage 4: host History page · commit `e46c326`
- [ ] `/history` with Guest / You / Database admin / DocuSign lines; one recurring booking as one line
- [ ] Proof: `evidence/*_probe-audit-proof-history.txt` (shows exactly what the page shows)
- **Takeaway:** RLS made the page need no new security code; context must be recorded at write time.

- [ ] **Summary table** "Audit log: the four stages compared"

---

## Feature 4: DocuSign e-signature

Host: log in, tick **Require a signed agreement** on the Dashboard. Guest: book with **your** email.

### Setup check · commit `e46c326`
- [ ] `node --env-file=.env.local scripts/docusign-check.mjs` → 4 PASS (blur account name if wanted)

### Stage 1: bookings that wait for a signature · commit `648b4d5`
- [ ] Guest page: "Held for you … sign it to confirm"; "Awaiting your signature"
- [ ] Dashboard: "Awaiting signature from …" (amber)
- [ ] Proof: `evidence/*_probe-docusign-proof-pending.txt`
- **Takeaway:** a new status touched 4 core database rules and 2 pages.

### Stage 2: sending the agreement · commit `8a2be0e`
- [ ] The DocuSign **email** and the **agreement document** (host, guest, times)
- [ ] History: "DocuSign · sent the agreement to …"; recurring: one agreement for all weeks
- [ ] Studio: `select id, status_code, error_msg from net._http_response order by id desc limit 5` → `200`
- [ ] Code: the trigger's `net.http_post` + the claim `update … set signature_status = 'sending'`
- **Takeaway:** pg_net as an outbox (only after commit); configuration was the hard part.

### Stage 3: receiving the result · commit `e05501a`
- [ ] Sign for real (email → Sign → Finish) → Dashboard **Check signature status** → "1 signed"; slot green
- [ ] History: "… signed the agreement: booking … confirmed"; decline → "… declined …"
- [ ] Proof: `evidence/*_probe-docusign-proof-receive.txt` (forged → 401, retry → no change, key rotation)
- [ ] Code: HMAC check in `supabase/functions/docusign-webhook/index.ts`
- **Takeaway:** webhooks are a public door; local dev can't receive them.

### Stage 4: when things go wrong · commit: (stage 4, not committed yet)
- [ ] Proof **before** the fixes: `evidence/2026-10-13_docusign-stage4-before-fixes_…txt` (11 FAIL)
- [ ] Proof **after**: `evidence/*_probe-docusign-proof-failures.txt` (all PASS)
- [ ] DocuSign **"voided"** email after cancelling a booking
- [ ] Lost send: stop `functions:serve`, book, start again → agreement arrives within ~2–3 min
- [ ] Studio: `select jobname, schedule from cron.job` and `cron.job_run_details` with `succeeded`
- **Takeaway:** no job queue; retries, scheduling and monitoring were hand-built.

- [ ] **Summary table** "DocuSign: the four stages compared"

---

## Feature 3: Spam protection

Spam test host: `spam-host@test.dev` / `password123`, booking page `/book/22222222-2222-4222-8222-222222222222`. Reset: `npm run probe:spam:seed`.

### Stage 1: one script takes over a calendar (shows the problem) · commit: (not committed yet)
- [ ] Proof: `evidence/*_probe-spam-flood.txt` (A: 50 slots in ~250 ms, B: one email ×50, C: ~500 writes/s no 429, D: 50 DocuSign sends)
- [ ] Screen recording or before/after screenshots: the spam host's booking page with 50 slots → empty within a second while the flood runs (Realtime)
- [ ] Dashboard as the spam host: 50 bookings by "Bot …"
- [ ] Code: the 4 lines that do it (`Promise.all(slots.map(… insert …))`) to show how little an attacker needs
- **Takeaway:** RLS decides who may write, not how often; anonymous guests are indistinguishable.

### Stage 2: limits in the database · commit: (not committed yet)
- [ ] Proof: `evidence/*_probe-spam-proof-limits.txt` (attacks stopped + WEAKNESS checks)
- [ ] The race: `evidence/2026-10-13_spam-stage2-BEFORE-advisory-lock_…txt` (14 of max 10 got through) next to the fixed run (exactly 10)
- [ ] Booking page: the 429 message after the 4th booking with one email, and after the host limit
- [ ] Studio: `rate_limit_settings` and `booking_rate_events` (hashed IPs only)
- [ ] Terminal: `X-Forwarded-For: 6.6.6.6` showing up as the *first* entry (`request.headers`), i.e. why only the last entry is trusted (snippet in FRICTION_LOG stage 2)
- [ ] Code: the advisory lock + count + `raise … errcode = 'PT429'` in the trigger
- **Takeaway:** limits slow attackers down but can't tell humans from bots; shared IPs and host lock-out hurt real guests.

### Stage 3: CAPTCHA via an Edge Function · commit: (not committed yet)
- [ ] Proof: `evidence/*_probe-spam-proof-captcha.txt` (every bypass → 403, flood → 0 of 50, humans → 201)
- [ ] Dashboard: "Require a CAPTCHA" ticked
- [ ] Booking page with the Turnstile box ("Success!" with the test key) above "Book this slot"
- [ ] curl / console: direct insert → `403 "This host requires a CAPTCHA check"`
- [ ] Code: `bookings_check_captcha` (current_user + `app.captcha_verified`) and `applyCaller()` in `_shared/caller.ts`
- **Takeaway:** the CAPTCHA itself is a few lines; closing every other way in is the real work.

### Stage 4: all layers compared · commit: (not committed yet)
- [ ] The comparison table from `evidence/*_probe-spam-compare.txt` (screenshot of the terminal, or the rendered table from FRICTION_LOG.md)
- [ ] Highlight the "Real guest right after the takeover" row: ❌ ❌ ✅
- **Takeaway:** limits reduce damage but lock out real guests; only the CAPTCHA tells humans from bots.

(Stage 3b, Supabase's own CAPTCHA via anonymous sign-in, was skipped: reasoning in FRICTION_LOG.md, no evidence to capture.)

- [ ] **Summary table** "Spam protection: the stages compared"

---

## Final pass (after all features)

- [ ] Commit everything, then `npm run evidence -- all` (sends a few real DocuSign emails) for clean, commit-labelled outputs
- [ ] Work through the checkboxes above, feature by feature
- [ ] Your own testing/review time per feature (the friction log only has build time)
- [ ] Notes on what was confusing as a newcomer (blog material the friction log doesn't have)
- [ ] One-line takeaway per feature, and the overall answer: where is Supabase enough, where does a backend become necessary?
