# Supabase vs. a traditional backend: research report for the blog

This report summarises a hands-on research project: a booking app built on Supabase, then extended with five "advanced" features to find out **where Supabase alone is enough and where a dedicated backend becomes necessary**. Every claim below comes from code that was built and from automated test scripts that were run against a local Supabase stack; numbers are measured unless marked as an estimate. The friction log in the repository (`FRICTION_LOG.md`, ~640 lines) has the full detail.

**Status:** the Supabase version is complete (core + 5 advanced features; feature 6 deliberately skipped). The planned **NestJS version has not been built yet**, so statements about NestJS are expectations, not measurements.

---

## 1. Framing notes for the writer

- **Intended blog angle (author's words):** show Supabase's limitations and how a NestJS backend fixes them.
- **What the evidence actually supports:** Supabase falls short in clear, reproducible ways (abuse protection, reliable background work, external integrations, transactions from the browser), **but in some areas it is enough or even better** than typical backend code (data integrity via Postgres constraints, the audit log via database triggers, time zones). A credible post should say so; it makes the limitations more convincing.
- **Some limitations are not Supabase-specific** and a NestJS backend won't remove them (see section 8). Saying "NestJS fixes all of this" would be inaccurate.
- **Recurring pattern used throughout:** most Supabase "fixes" required a **small backend anyway**: Supabase Edge Functions (server-side TypeScript/Deno). The question is less "backend or not" than "how much backend, and how well do Supabase's building blocks support it".

---

## 2. The app and the setup

**The app:** hosts publish time slots; guests (no account) book them; hosts manage bookings on a dashboard. Core features: email/password auth for hosts, slots, guest bookings with a cancel link, double-booking prevention, row-level security, live slot updates (Realtime), avatar uploads (Storage).

**Stack:** Vue 3 frontend; Supabase (Postgres 17, PostgREST API, Auth, Realtime, Storage, Edge Functions on Deno) running locally via Docker (Supabase CLI 2.120). Extensions used: `pg_cron` (scheduled jobs), `pg_net` (HTTP calls from the database), `pgmq` (Supabase Queues), Vault (secrets), `pgcrypto`.

**External services:** DocuSign eSignature (demo account, JWT grant), Cloudflare Turnstile (CAPTCHA, official test keys), Mailpit (local test inbox; no real email provider).

**Rules followed:** the browser only ever holds the public ("publishable") key; secrets live in Edge Functions or Vault; limitations are documented, not hidden; pages call a services layer (`src/services/`) so a NestJS backend can later provide the same functions.

**Size of the advanced work** (on top of the core app): 21 commits, 108 files, ~8,500 added lines (incl. docs). Roughly: SQL migrations + Edge Functions ~2,800 lines (16 migrations, 10 Edge Functions), test/probe scripts ~3,400 lines, app code (pages, services) ~900 lines. 6 scheduled jobs (3 active by default).

---

## 3. Method

Each feature was built in **stages**, usually:

1. **Show the problem**: build the obvious/naive version and a script that reproduces how it fails. The failing output is saved as evidence *before* any fix.
2. **Supabase-native fix(es)**: fix it with Supabase's own tools (Postgres functions, triggers, RLS, Edge Functions, pg_cron, pgmq…).
3. **Compare**: a script runs the same scenarios against all versions and prints a table.

**Proof scripts** (Node.js, `src/probes/<feature>/`) act like a real browser or attacker (public key only, or a user token), then check the result **directly in the database**, in Mailpit or at DocuSign, printing PASS/FAIL per claim. 18 scripts in total; on the final code 16 pass and 2 print SKIP by design (the spam flood, now stopped by the limits, and the supa_audit comparison, removed after its stage); their earlier outputs are saved. `npm run evidence -- all` saves every output with date and commit. The core app has a separate 60-check RLS suite.

**Time** per stage was logged as an estimate in the friction log (build time only, not the author's testing/review time).

---

## 4. Baseline: the core app on Supabase

Result: the whole core app works with Supabase alone (no custom server, only the public key in the browser). 16 friction points, ~3.5 hours of extra time.

- **Enough:** Postgres constraints made double booking impossible even under concurrent requests (partial unique index) and prevented overlapping slots (exclusion constraint); auth needed almost no code; RLS + column grants expressed every rule (60 automated checks); Realtime and Storage worked with per-host policies.
- **Awkward:** logic moved into SQL (4 triggers, 2 RPC functions, 15 policies); **silent failures** (RLS-filtered updates return success with 0 rows; Realtime `postgres_changes` silently drops events the viewer can no longer see, the most time-consuming issue; unauthorized Realtime sends return "ok"); default grants give anonymous users write access to every column of a new table; guests without accounts don't fit RLS (needed a browser-generated token + RPC functions).
- **Backend necessary for:** abuse protection, notification emails, real upload validation, account deletion including files.

---

## 5. Advanced features: what was built, found and measured

### Feature 1: Recurring bookings (transactions)  ·  ~2 h 45 min

A guest books the same weekly slot for N weeks: all weeks or nothing.

| Stage | Built with | Result |
|---|---|---|
| 1. Separate calls from the browser | supabase-js, one request per write | **Week 4 clash left the series + weeks 1–3 saved.** Each API call is its own transaction; supabase-js has no way to group them. (A single multi-row insert *is* atomic; the problem appears across calls/tables.) |
| 2. Postgres function via `rpc()` | PL/pgSQL, `SECURITY INVOKER` | All-or-nothing ✅; a clashing booking held open by a concurrent test transaction made the function wait for it (the ~1.6 s is the test's own 2 s hold, not a performance figure) and then roll back cleanly. |
| 3. Edge Function with a direct DB connection | Deno, `BEGIN/COMMIT/ROLLBACK` | All-or-nothing ✅, 17 checks incl. forged tokens. |

**Findings:**
- **Failures must be raised, not returned:** a PL/pgSQL function that returns "failed" after inserting weeks 1–3 *commits* them.
- **INVOKER vs DEFINER trade-off:** `SECURITY INVOKER` keeps RLS but guests must keep direct table rights (they can bypass the function); `SECURITY DEFINER` closes that door but switches RLS off inside the function. Supabase gives one or the other.
- **A direct database connection uses a privileged role that bypasses RLS**, silently: locally `SUPABASE_DB_URL` connects as `postgres`, which is not a superuser but owns the tables and has `BYPASSRLS` (the hosted role is *to verify before publishing*). The function must re-apply the caller's role and JWT claims per transaction (what PostgREST does internally).
- Supabase's built-in JWT check for Edge Functions lets requests through with just the public key; it doesn't identify the caller (observed with local CLI 2.120; hosted *to verify*). The function had to verify keys and tokens itself.
- Logic ended up in three languages (browser JS, PL/pgSQL, Deno TypeScript).

### Feature 2: Audit log  ·  ~4 h

Who changed what and when, readable by hosts, impossible to fake.

| Stage | Result |
|---|---|
| 1. Log written by the browser | All 5 problems reproduced (19 checks): logging **skipped** by a direct API call; **other paths** (rpc, Studio) not logged; **forged** entries accepted (guests need insert rights to log); act-then-log-fails → change without record; log-then-act-fails → record of something that never happened. Also: guests can't even learn the id of the booking they just created (RLS hides it). |
| 2. Database triggers | **Every path logged** (browser, rpc, Edge Function, Studio, cascades), in the same transaction (rolled-back changes leave no entry), forging impossible (21 checks). |
| 3. Supabase's ready-made tools | **supa_audit**'s GitHub repository is archived (last commit 2 Jan 2024, checked 14 Oct 2026) and, installed as published, **broke every sign-up** ("Database error saving new user", a search_path bug; 2-line patch); it records who, but copies cancel tokens and full emails. **pgaudit** (preloaded in the local image) only sees the shared API database user (`authenticator`), never the real person; API writes are only logged if reads are logged too; values are not logged with the local settings (`log_parameter` on hosted: *to verify*); **rolled-back writes are logged as if they happened**. |
| 4. Host history page | Plain-language history (12 checks); context (slot time) must be stored when the entry is written; a time-only paging cursor would skip entries (transactions share a timestamp). |

**Takeaway: this is where Supabase/Postgres is *better* than typical backend code.** Triggers catch changes from every path, including admin edits and scripts that an API-layer logger (e.g. a NestJS interceptor) would miss. Limits: admin changes in Studio show only "postgres", no person; the database owner can still erase history; cascaded deletes flood the log.

### Feature 3: Spam protection  ·  ~3 h 15 min

Anonymous guests can book. How do you stop abuse?

| Stage | Result |
|---|---|
| 1. Show the problem | One script with only the public key: **all 50 slots booked in under 0.3 s** (0.24–0.29 s, 3 runs); 50 bookings with one email accepted; **~500 writes in ~0.5–0.7 s (3 runs), never a 429**; on a host requiring signatures, 50 fake bookings → **50 DocuSign emails** from the app's account. |
| 2. Limits in the database (trigger, HTTP 429) | Max 3 active bookings per email per host, 10 per host and 30 per IP per 10 min. First run: **a race let 14 of max 10 through** under parallel load (count-then-insert); fixed with advisory locks (cost: all bookings for one host are serialized; the timing effect varied 0.35–1.3 s across 5 runs, too noisy to quote as a number). Clients can **prepend fake IPs** to `X-Forwarded-For`; only the last (proxy-added) entry is trustworthy. 15 checks. |
| 3. CAPTCHA (Turnstile) via Edge Function | Host opt-in; the Edge Function verifies the token then books; a trigger refuses every other API booking for that host (403). Every bypass refused (direct insert, signed-up user, header tricks, rpc). 15 checks. |
| 4. Compare (table below) | |

| Bot attack | No protection | Database limits | Limits + CAPTCHA |
|---|---|---|---|
| Calendar takeover (50 parallel bookings) | 50/50 | 10/50 | **0/50** |
| Real guest right after the attack | nothing left ❌ | blocked 10 min ❌ | **can book ✅** |
| One email × 10 | 10 | 3 | 0 |
| Email variations (name+xyz@) × 10 | 10 | 10 | 0 |
| Fake IP headers × 40 (host limit lifted) | 40 | 30 | 0 |
| Bot signs up first, then 20 | 20 | 10 | 0 |
| DocuSign emails from 50 bot bookings | 50 | 10 | 0 |
| Normal booking, average time (4 local runs) | ~15–25 ms | ~15–35 ms (noise) | ~70–100 ms |

**Findings:** RLS answers *who* may write, not *how often*; anonymous guests are indistinguishable. Limits reduce damage but **lock out real guests** (shared IPs, host lock-out). Only the CAPTCHA step is a clear, repeatable cost (roughly 50–80 ms more per booking); the other differences are noise. Supabase's built-in CAPTCHA is an Auth setting (on/off, provider, secret) that applies to Auth requests, not to table writes through the API, so it doesn't directly protect anonymous bookings (which Auth requests it covers exactly is *to verify before publishing*; this "native" route was reasoned about, not built). The CAPTCHA itself is a few lines; **closing every other way into the table was the real work** (there is no single setting that says "only this function may write here"; it took grants, RLS and a trigger together).

### Feature 4: Third-party integration with webhooks (DocuSign)  ·  ~4 h 45 min

Hosts can require a signed agreement; the booking waits for the guest's e-signature.

| Stage | Result |
|---|---|
| Setup | JWT grant verified with a test script; real friction: placeholder values, the public key in place of the private one, a one-time browser consent. |
| 1. Bookings that wait | New state `pending_signature`, holding the slot. **A new status touched 4 core database rules and 2 pages** that silently did the wrong thing until updated. 15 checks. |
| 2. Sending | Booking → trigger → `pg_net` HTTP call (sent only after commit: an "outbox", so rolled-back bookings send nothing) → Edge Function → DocuSign. **Real envelopes sent and verified.** Config spread over Vault + function env + DocuSign admin; pg_net's 5 s default timeout lost requests to Edge Function cold starts. 13 checks. |
| 3. Receiving | HMAC-verified webhook (a public endpoint: no signature → 401) + "check status" fallback. Retries and out-of-order messages are harmless. **DocuSign can't reach localhost**, so webhooks were tested with simulated signed messages; signing itself can't be automated. 19 checks. |
| 4. When things go wrong | **Drawbacks proven first: 11 of 17 checks failed**: lost send requests never retried, unsigned bookings blocking slots forever, **a cancelled booking's agreement still signable**, nothing scheduled. Fixed with pg_cron (retry with backoff, expiry), a void-on-cancel trigger + Edge Function. Then 17/17, incl. a real envelope voided after the guest cancelled. |

**Findings:** Supabase alone can't do it (private key, outbound API, public signed endpoint): **4 Edge Functions** were needed. **Supabase has no job runner** (Supabase Queues/pgmq, used in feature 5, stores messages, but nothing *runs* jobs): retries, backoff, giving up, stuck detection and scheduling were hand-built from pg_cron + pg_net + triggers, with monitoring via SQL queries. A side effect: the retry job sends *any* waiting booking, so test data with fake emails became dangerous.

### Feature 5: Bulk reminders  ·  ~4 h 25 min

A reminder email to every guest 24 h before their session (200 test bookings, local Mailpit inbox).

| Stage | Result |
|---|---|
| 1. Naive scheduled loop | pg_cron → pg_net → one Edge Function loops and marks all at the end. Crash after 120 + next run → **120 guests reminded twice**; two runs at once → **all 200 twice**; slow provider → the caller **timed out after 30 s** while the function finished unseen (or the runtime **terminated it half-way**, HTTP 546); one long call → **504 after 150 s while the function kept sending for minutes in the background** (only a restart stopped it). |
| 2. Supabase Queues (pgmq) | One message per reminder; batches; visibility timeout keeps workers apart; mark + delete in one transaction; dead letters after 5 reads; time budget per run. Crash/overlap → 0 duplicates (worst case 1: the email in flight). 11 checks. |
| 3. Opt-out + provider limits | Unsubscribe via the guest's existing cancel token (no account), stored hashed; mail apps' one-click "Unsubscribe" (RFC 8058) needs **a public endpoint without an API key** → another Edge Function. A test provider with a 20/s limit: the stage 2 worker got ~200 refusals and **dead-lettered 22–30 healthy reminders**; fixed with pacing, a single-worker lease and "429 = try later". **pgmq counts reads, not failures**: a first fix still dead-lettered 16 healthy reminders. 15 checks. |
| 4. Compare (table below) | |

| Scenario | Naive loop | Queue | Queue + limits |
|---|---|---|---|
| Quiet day (200 emails) | ~1 s (0.3–1.3 s, 8 runs) ✅ | ~5 s (2 runs) ✅ | ~30 s (by design: paced at 10/s) ✅ |
| Crash after 120, then the next run | **120 twice** | 0 twice | 0 twice |
| Two runs at the same time | **200 twice** | 0 twice | 0 twice |
| Provider limit 20/s | **14/200** | **170/200**, 30 dead letters | **200/200** |
| Guest unsubscribed after queuing | reminded anyway | not reminded | not reminded |

**Findings:** Supabase can run a reliable bulk job without a separate server, but it's **assembled by hand**: the worker loop, time budget, lease, pacing, throttling and dead-letter rule are all custom. **Edge Function limits** (caller timeout, gateway 504, runtime CPU/wall-clock termination) shape the whole design and don't stop the function together. A queue gives at-least-once delivery; exactly-once needs the email provider's idempotency key.

### Feature 6: Weekly availability & time zones  ·  skipped (~30 min analysis)

Skipped because it would mostly show where Supabase is **enough**: Postgres ships the full time-zone database and handles daylight-saving changes correctly. The one real Supabase limitation found: **scheduled jobs run in UTC only** (verified locally: pg_cron 1.6.4, `cron.timezone = GMT`, set at server start, not changeable by the project's database user; hosted: *to verify before publishing*), so "every day at 06:00 Berlin" shifts by an hour twice a year. Two small bugs in the project's own code were noted, not fixed (recurring bookings drift by an hour across a clock change; emails show UTC times).

### Security review (after all features)  ·  ~3 h

Requested by reviewers: Supabase's own checks, a scan of everything reachable, SQL injection.

| Step | Result |
|---|---|
| 1. Security Advisor + linter (`supabase db advisors`, `db lint`) | No errors; 11 advisor items + 1 linter warning, each reviewed: 1 real (the open `booking_series` insert, see step 2), the rest intended (RLS on with no policy = closed to the API; a deliberately forgeable probe table) or cosmetic (pg_net's extension record in `public`, its objects all in `net`). |
| 2. Exposure scan (107 checks) | Every table × {public key, a stranger's login} × {read, insert, update, delete}, judged in the database; every function via `rpc()`; all 10 Edge Functions; Storage; GraphQL; compared with an expected-access map (unknown objects fail as "not reviewed"). **No cross-host reads/writes, internal functions and Edge Functions closed.** But **2 real issues**: unlimited empty series (each a line in the host's history), and **a bypass of the spam limits: 40 bookings on one host where the limit is 10**, by attaching bookings to made-up series (weeks of a series skipped the limits and nothing tied them to the series). Fixed with a trigger (series counted at creation; bookings must match their series); all earlier proofs re-run and pass. |
| 3. SQL injection (19 checks) | **supabase-js filters are parameterised** (SQL in a value is just text). Filter *strings* built from input (`.or(...)`) can be bent, but RLS still limits the rows. **The real risk is your own functions:** a `SECURITY DEFINER` function that builds SQL by concatenation, called via `rpc()` by a normal logged-in host, leaked **other hosts' bookings, every account's email (`auth.users`) and the Vault secrets**. The safe version (parameters + `format('%I')`) stopped every attack. The unsafe function is locked twice (no grant; a 2-minute switch) and the scan fails if it's callable. |

**Findings:** Supabase's protections held where they were configured; both real holes came from **what the database exposes by design**: every insertable column combination, and every function in `public`, is public API. **Supabase's Security Advisor missed both**: it checks configuration (RLS on, policies too wide), not behaviour. In a backend, only the endpoints you write are reachable, so a hand-built `series_id` or a stray helper function wouldn't be.

---

## 6. Cross-cutting themes (for the blog's argument)

1. **"No backend" quickly becomes "a small backend".** 10 Edge Functions by the end: transactions with RLS, CAPTCHA verification, DocuSign send/receive/sync/void, reminder worker, one-click unsubscribe, a test provider.
2. **Infrastructure you'd normally get from a library had to be built.** Job-runner behaviour (retries, backoff, dead letters, rate limiting, single-worker leases, stuck detection) was hand-built on pg_cron + pg_net + pgmq + triggers, twice (DocuSign and reminders).
3. **Logic is scattered across runtimes.** Browser JS, PL/pgSQL (functions, triggers, RLS), Deno Edge Functions, cron definitions and Vault entries. When something fails, the evidence is in different places (`net._http_response`, function logs, `docker logs`, a status column).
4. **Silent failures and surprising defaults.** RLS returns success for blocked updates; Realtime drops events; pg_net times out after 5 s by default; supa_audit broke sign-up; pgmq counts reads as attempts; a 504 didn't stop a function.
5. **The database is directly exposed to every browser.** Every table and function must be locked down individually (grants + RLS + revokes); forgetting one is a data leak or an abuse vector. The security review proved it: a column combination no screen uses bypassed the spam limits (40 bookings vs. a limit of 10), and one string-built function exposed `auth.users` and Vault through `rpc()`; Supabase's Security Advisor flagged neither. A traditional backend exposes only the endpoints you write.
6. **Anonymous users are second-class.** No identity for RLS, rate limits or time zones; worked around with tokens, IP hashes and browser-supplied values.
7. **Edge Function limits are real** (caller timeout, gateway timeout, CPU/wall-clock termination) and change how background work must be designed.
8. **Local development friction:** webhooks can't reach localhost; Edge Functions need a separate `functions serve` process (once lost its container); config spread over several files and Vault; a time-limit test left a function running in the background.
9. **Where Supabase shines:** Postgres constraints, triggers (audit log), transactions inside functions, time zones, RLS for simple ownership rules, pgmq as "just tables" (enqueue + state change in one transaction).

---

## 7. Time and effort summary (estimates, build time only)

These are **estimates of AI-assisted build time**: everything was built with **Claude Code** (an AI coding assistant), with the author directing, reviewing and testing. They are not hand-written developer time and exclude the author's own testing and review. Use them for **relative effort** between features and stages, not as absolute hours. The NestJS version will be built and measured the same way.

| Area | Time |
|---|---|
| Core app friction (baseline) | ~3 h 30 min |
| 1 Recurring bookings | ~2 h 45 min |
| 2 Audit log | ~4 h |
| 3 Spam protection | ~3 h 15 min |
| 4 DocuSign integration | ~4 h 45 min |
| 5 Bulk reminders | ~4 h 25 min |
| 6 Time zones (analysis only) | ~30 min |
| Security review (advisors, exposure scan + fix, SQL injection) | ~3 h |

---

## 8. What a NestJS backend is expected to change (not yet measured)

**Likely better with a dedicated backend:**
- Transactions spanning several steps in ordinary application code (no SQL functions or RLS re-application).
- One language and one place for business logic; easier debugging, logging and tests.
- A real job queue (e.g. BullMQ) with retries, backoff, concurrency limits, rate limiting and a dashboard as configuration.
- No Edge Function time/CPU limits for long-running work.
- Secrets, external APIs and webhooks handled in one long-running server.
- Only the endpoints you write are exposed; the database is not reachable from the browser.

**Not fixed by a backend (same in NestJS):**
- Anonymous guests can't be identified (a product decision).
- Telling humans from bots still needs a CAPTCHA; IP-based limits still hit shared IPs.
- Exactly-once emails still need the provider's idempotency key.
- Webhooks still need a public URL in local development (tunnel).
- Postgres features that made Supabase strong (constraints, triggers) are available to NestJS too; using them is a choice, not a Supabase privilege.

**Possibly worse with a backend:** the audit log (an API-layer logger misses Studio/admin/script changes unless triggers are used anyway), and the extra work of auth, hosting, scaling and operating a server.

---

## 9. Caveats and what was not tested

- Everything ran **locally**; hosted Supabase limits (Edge Function limits, IP headers, rate limits) may differ and were noted rather than measured.
- **CAPTCHA** was tested only with Cloudflare's test keys (any token passes); real bot detection wasn't tested. The widget hasn't yet been checked in a browser.
- **Webhooks** were tested with simulated, correctly signed DocuSign messages; real DocuSign Connect calls need a public URL.
- **Emails** went only to Mailpit (no real provider); DocuSign emails were real (demo account).
- **Security** testing: the core RLS checks (60), per-feature checks, Supabase's advisors, an exposure scan of every table, function, Edge Function and the avatars bucket as anon and as a stranger (107 checks), and SQL-injection tests (19). **Not covered:** Realtime subscriptions beyond the core design, Auth's own endpoints and rate limits, attacks needing a hosted project (header spoofing behind Supabase's real proxy, see the to-verify list), and dependency/supply-chain checks. The scan is only as good as its expected-access map, which was written by the same builder.
- **Time figures** are estimates of AI-assisted build time (Claude Code), not measured and not hand-coding time; only relative effort is meaningful.
- **Timings** come from a few local runs on one laptop (Docker). Only large, repeatable differences are quoted, as ranges with the number of runs; small differences (e.g. the advisory-lock cost) are labelled noise.
- **To verify before publishing** (checked locally only, or not checked):
  - the role behind `SUPABASE_DB_URL` on hosted Supabase (locally `postgres`: owner + `BYPASSRLS`, not superuser);
  - `cron.timezone` on hosted projects (locally GMT, server-level);
  - exactly which Auth requests Supabase's built-in CAPTCHA covers;
  - pgaudit availability and `log_parameter` on hosted;
  - Edge Function limits on hosted (caller timeout, gateway 504 after 150 s, CPU/wall-clock termination, 546);
  - which IP headers hosted Edge Functions/PostgREST receive, and whether a client can spoof `X-Forwarded-For`;
  - pg_net timeouts against hosted Edge Function cold starts;
  - the built-in Edge Function JWT check letting the public key through.
- Supabase's "native" CAPTCHA route (anonymous sign-in) and feature 6 were reasoned about, not built.

---

## 10. Evidence available

- `FRICTION_LOG.md`: every friction point with what happened, workaround, time and "backend needed?"; a stage-comparison table and a "for the blog" paragraph per feature.
- `evidence/`: saved outputs of all 21 proof scripts (PASS/FAIL lines, comparison tables), including the "before the fix" runs (DocuSign stage 4: 11 failures; spam stage 2: the race letting 14 of 10 through; security scan: the limit bypass, 40 of 10).
- `BLOG_EVIDENCE.md`: checklist of ~90 screenshots to take (not taken yet).
- Git history: one commit per stage (21 commits), so every state can be reproduced.

---

## 11. Suggested blog structure

1. The question and the setup (one app, built twice; the Supabase version first).
2. Baseline: what Supabase gives you for free (and its silent failures).
3. Five features, each as "naive version → what broke → Supabase fix → what it cost": transactions, audit log (the Supabase win), spam protection, DocuSign webhooks, bulk reminders.
4. Cross-cutting themes: the "small backend" you end up writing anyway; hand-built job infrastructure; scattered logic; exposed database; anonymous users; Edge Function limits.
5. What a NestJS backend would change, and what it wouldn't (to be confirmed by the NestJS build).
6. The answer: Supabase is enough for data, permissions, real-time and even auditing; a backend becomes necessary for abuse protection, external integrations and reliable background work, and Supabase's own answer to those is a set of building blocks you assemble yourself.
