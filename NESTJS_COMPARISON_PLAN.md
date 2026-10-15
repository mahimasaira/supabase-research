# Plan: a fair NestJS comparison

**Status: in progress (N0 scaffold done; see CLAUDE.md).** The NestJS version (branch `feature/msa-nestjs`, stacked on `feature/msa-supabase-advanced`) gets its own backend in `backend/`, its own Postgres database and its own login. This plan makes sure both versions are **tested by the same scenarios** and **measured the same way**, so the blog compares like with like.

## 1. A backend-agnostic scenario runner

Today every proof script talks to Supabase directly (supabase-js, psql, Edge Function URLs). Most of them really test **behaviour** ("a week-4 clash leaves nothing behind", "40 bookings via fake series are refused"), not Supabase. The plan separates the two:

```
scenarios/
  run.mjs                      npm run scenarios -- --backend supabase|nestjs [feature…]
  lib/                         check(), timing, evidence output (same format as today's proofs)
  features/                    one file per feature, backend-agnostic
    core-permissions.mjs       (from scripts/test-rls.mjs)
    recurring.mjs              all-or-nothing, clash week, race, not enough weeks
    audit.mjs                  every path logged, rolled-back writes not logged, no forging, history page
    signatures.mjs             pending state, send, webhook (signed / unsigned / out of order), retry, expiry, void on cancel
    spam.mjs                   takeover, same email, email variants, fake IP headers, series bypass, CAPTCHA
    reminders.mjs              quiet day, crash after 120, overlap, provider limit 20/s, opt-out
    security.mjs               endpoint exposure map, injection strings in every input
  adapters/
    supabase.mjs               wraps today's code (supabase-js + psql)
    nestjs.mjs                 HTTP client for the NestJS API + its database (later)
  doubles/
    mail-provider.mjs          the test email provider (rate limit, 429), a plain Node server both backends call
    docusign-webhook.mjs       signs simulated DocuSign Connect messages (HMAC), shared
```

### The adapter: one small interface per backend

Two halves. **The "front door"** is what a browser can do: it uses the **same function names as `src/services/`**, which already hides the backend from the pages. **The "back door"** is what a test needs to set up and inspect: seeding, reading the real database state, fault injection. Each scenario only uses these:

| Front door (as a user) | Back door (test hooks, privileged) |
|---|---|
| `signUpHost(name)` → session · `guest()` → anonymous session | `seed(fixture)`: the fixed hosts/slots used today (recurring, spam, reminder hosts) |
| `createSlot`, `listFreeSlots`, `listHostSlots`, `deleteSlot` | `count(table, where)`, `row(table, id)`: **the database truth**, never the API's answer |
| `bookSlot`, `bookRecurring`, `cancelAsGuest`, `cancelAsHost` | `setLimits({ perEmail, perHost, perIp })` |
| `listAuditHistory`, `setSignatureRequirement`, `checkSignatureStatus`, `setCaptchaRequirement` | `runReminders({ crashAfter, parallel })`, `drainQueue()` |
| `unsubscribeReminders(token)` | `deliverWebhook(message)`, `failNextSends(n)`, `advanceTime(…)` or `expireNow()` |
| raw request for attack tests: `request(method, path, body, headers)` | `adminWrite(sql)`: the "Studio/admin" path for the audit scenario |

**Results are normalised** so a scenario never checks a Supabase-specific detail: `{ ok, error: 'clash' | 'not_enough_weeks' | 'rate_limited' | 'captcha_required' | 'forbidden' | 'invalid', week?, limit? }`. Today's PT429 → `rate_limited`, NestJS's HTTP 429 → `rate_limited`, and so on.

### Steps (in order)

1. **Make `src/services/` usable from Node**: today it reads `import.meta.env` and a global client. Pass the client and config in (the recurring implementations already take `db` as a parameter). No behaviour change.
2. **Write `adapters/supabase.mjs`** and port the scenarios one feature at a time, **running them against Supabase first**. A scenario counts as ported only when it produces the same PASS/FAIL as today's proof script on the same commit. This proves the runner is faithful before NestJS exists.
3. **Move the test doubles out of Supabase**: the test mail provider is an Edge Function today; as a plain Node server both backends can use it under identical conditions (same limit, same latency).
4. Build NestJS feature by feature, writing `adapters/nestjs.mjs` as it grows; each NestJS stage ends when the shared scenario for it passes.
5. One command produces the comparison table: `npm run scenarios -- --backend supabase` and `--backend nestjs`, outputs saved with `npm run evidence` as today.

## 2. Which scripts can be shared

| Today's script | Shared scenario? | Notes |
|---|---|---|
| `test:rls` (60) | **Yes**, as `core-permissions` | Same rules (hosts can't touch each other's slots, guests can't read bookings…). In NestJS they're enforced in guards/services instead of RLS. |
| `probe:recurring:edge-proof` | **Mostly** | Shared: all-or-nothing, clash week, race, forged/expired tokens refused. Supabase-only: "the Edge Function re-applies RLS" (`auth.uid()` inside the transaction). |
| `probe:audit:proof` (stage 1, browser logging) | **No** (Supabase demonstration) | Shows why browser logging fails; NestJS logs on the server from the start. |
| `probe:audit:proof:triggers`, `:history` | **Yes** | "Every path is logged" must include the admin path (`adminWrite`): this is where an API-layer logger in NestJS is expected to miss changes unless it also uses triggers. Good blog point. |
| `probe:audit:compare` (supa_audit, pgaudit) | **No** | Supabase-specific tools. |
| `probe:docusign:proof:pending`, `:receive`, `:failures` | **Yes** | Webhook signing, out-of-order messages, retries, expiry, void on cancel are product behaviour. |
| `probe:docusign:proof:send` | **Yes, optional** | Sends real envelopes; keep behind a flag (`--real-email`), as `--no-email` does today. |
| `probe:spam:flood`, `:proof:limits`, `:proof:captcha`, `:compare` | **Yes** | All attacks are HTTP requests. Fake IP headers depend on each deployment's proxy (locally Kong vs. NestJS behind whatever it runs behind): record the setup. |
| `probe:reminders:naive`, `:proof:queue`, `:proof:optout`, `:compare` | **Yes** | Crash/overlap/throttling via back-door hooks; the "naive" stage is optional for NestJS (BullMQ is the obvious first build, but building the naive loop too makes the comparison fairer). |
| `probe:security:scan` | **Partly** | The idea is shared (try every way in, compare with an expected map). The map differs: Supabase = every table × role + every function; NestJS = every route × role. Abuse checks (series bypass) shared. |
| `probe:security:sqli` | **Partly** | Shared: injection strings sent to every input (search, filters, sort). Supabase-only: DEFINER vs. INVOKER via `rpc()`. NestJS counterpart: a deliberately raw query in a repository, same locking idea. |
| `probe:security:advisors` | **No** | Supabase CLI. NestJS equivalents (e.g. `npm audit`, a linter, an ORM's raw-query warnings) are recorded separately, not compared 1:1. |
| `hosted:*` | **No** | Supabase platform limits. NestJS gets its own deployment notes (timeouts of whatever hosts it). |

## 3. Measuring effort the same way

The Supabase numbers are **AI-assisted build time with Claude Code** (see "About the time figures" in FRICTION_LOG.md). The NestJS build must use the identical method or the comparison is meaningless:

- **Same assistant setup:** Claude Code, same model and effort settings (record them in the friction log header), same author directing and reviewing.
- **Same briefs:** reuse each feature's original request and stage list (from CLAUDE.md / this conversation history) verbatim, changing only "Supabase" to "NestJS". Same rule: show the problem first, then fix it, stop after each stage.
- **Same stage boundaries and one commit per stage**, so `git diff --stat` per stage is comparable.
- **Same friction-log entry per stage:** time spent, files and lines changed, how easy to test and debug, surprises, "backend needed?" becomes "what did NestJS make easier or harder?".
- **Objective numbers per feature** (both versions, collected the same way):

  | Metric | How |
  |---|---|
  | Lines added/changed, by kind (app code, SQL, tests, config, docs) | `git diff --numstat` per stage commit, grouped by path |
  | Languages / runtimes touched | count (Supabase so far: browser JS, PL/pgSQL, Deno TS, cron/Vault config) |
  | Deployable units | migrations, Edge Functions, cron jobs vs. NestJS modules, workers, queues |
  | Shared scenarios passing on the first run after a stage | from the runner output |
  | Time to green | build time until the shared scenario passes |
  | Surprises / silent failures | counted from the friction log |

- **Platform work kept separate.** Auth, hosting, database setup, migrations tooling and deployment come free with Supabase and cost real time in NestJS. Record them as a separate "platform" line, so the per-feature numbers stay comparable and the platform cost is still visible.
- **Known bias, stated in the blog:** NestJS is built second, after every feature was designed, debugged and explained once. That favours NestJS. Mitigations: reuse the briefs, not the Supabase solutions; note in each entry what was reused knowledge; compare relative effort, not absolute hours.

## 4. Open decisions (for when this starts)

- ORM or plain SQL in NestJS (Prisma / TypeORM / Drizzle / `pg`)? Affects the injection and audit comparisons.
- Where NestJS runs for the hosted comparison (to repeat the timeout and IP-header checks).
- Whether the NestJS version also uses database triggers for the audit log (the fair comparison may be "both use triggers"; then the difference is everything around them).
