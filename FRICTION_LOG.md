# Friction log

Things about Supabase that were harder than expected, needed a workaround, or would push toward a dedicated backend.

## About the time figures

All "Time spent" figures in this log are **estimates of AI-assisted build time**: the app and every feature were built with **Claude Code** (an AI coding assistant), with the author directing, reviewing and testing. They are **not** hand-written developer time and don't include the author's own testing and review. A developer writing the same code by hand would need considerably longer. Use them for **relative effort between features and stages** (e.g. "the DocuSign reliability stage took about as long as the whole recurring-bookings feature"), not as absolute hours. The NestJS version should be built and measured the same way so the comparison stays like for like.

## Summary

**Result:** the whole booking app works with Supabase alone, with no custom server and only the publishable key in the browser. That covers auth, host/guest permissions, double-booking prevention, live updates and avatar uploads. 16 friction points, roughly **3.5 hours** of extra time in total, about 40 minutes of it waiting for the first Docker download or analysing rather than building.

### Where Supabase was enough

- **Data integrity:** Postgres constraints did the hard part. A partial unique index makes double booking impossible even under concurrent requests, and an exclusion constraint prevents overlapping slots. No UI or server check could match that.
- **Auth:** email + password sign-up, login and session handling needed almost no code.
- **Permissions:** RLS + column grants expressed every host/guest rule from the spec, verified by 60 automated checks.
- **Realtime and Storage:** both worked, with per-host channels and per-user folders protected by policies.

### Where it got awkward (no backend needed, but it costs something)

- **Logic moves into SQL.** The app ended up with 4 triggers, 2 RPC functions, 10 table policies, 5 storage/realtime policies and column grants. It works, but it's harder to find, review and debug than application code, and needs real Postgres knowledge (security definer, search_path, grants vs. RLS).
- **Silent failures.** Three Supabase behaviours return success while doing nothing: RLS-filtered updates/deletes (0 rows, no error), Realtime `postgres_changes` dropping events the viewer can no longer see (cost the most time, ~40 min), and unauthorized Realtime sends returning `"ok"`. Each needed a test to discover.
- **Default grants are wide open.** New tables give `anon` write access to every column; RLS can't restrict columns. Easy to miss.
- **Users without an account are second-class.** Guests have no `auth.uid()`, so "read my booking" and "cancel my booking" don't fit RLS. Worked around with a browser-generated token and two RPC functions (cancel, check status).

### Where a backend becomes necessary

All four need code that runs on a server and/or holds a secret. A Supabase Edge Function would be enough for each, but that *is* a (small) backend:

| Need | Why Supabase alone can't do it |
|---|---|
| **Abuse protection** for guest bookings | RLS controls *who* may write, not *how often*. No rate limit on data writes; Supabase's CAPTCHA is an Auth setting, not for table writes (exact coverage: to verify). |
| **Email notifications** (booking confirmed / cancelled) | Supabase only sends auth emails; an email provider's API key can't live in the browser. |
| **Real upload validation** | Storage trusts the declared content type; checking or re-encoding the bytes needs code. |
| **Account deletion** incl. files | Files can only be deleted through the Storage API, not in the same SQL transaction; needs the secret key. |

**One-line answer for the blog:** Supabase alone is enough for the data, permissions and real-time parts of a small app, provided you're comfortable writing serious SQL. A backend becomes necessary the moment you need to *trust nothing from the client* (abuse, file contents) or *talk to the outside world with a secret* (emails, admin cleanup).

---

Format per entry:

## <short title>
- **Step:** which build step
- **What happened:**
- **Workaround:**
- **Time spent:** roughly
- **Backend needed?** no / maybe / yes, and why

---

## First `supabase start` is slow
- **Step:** 1 (setup)
- **What happened:** The first `npx supabase start` downloads ~10 Docker images (Postgres, GoTrue, PostgREST, Realtime, Storage, Studio, Kong, Mailpit, Vector, …). It took roughly 20 minutes on this connection; the terminal just shows layer download lines with no overall progress.
- **Workaround:** None, just wait. Later starts take seconds because the images are cached. Docker must be running first.
- **Time spent:** ~20 min (waiting)
- **Backend needed?** No. Local-dev cost only.

## "anon key" vs "publishable key" naming
- **Step:** 1 (setup)
- **What happened:** Most docs and tutorials say "anon key" (a JWT starting with `eyJ…`). CLI 2.120 prints both `ANON_KEY` and `PUBLISHABLE_KEY` (`sb_publishable_…`), and likewise `SERVICE_ROLE_KEY` and `SECRET_KEY`. It isn't obvious that they're two generations of the same thing.
- **Workaround:** Used the publishable key in `VITE_SUPABASE_ANON_KEY`; supabase-js accepts either. The `secret`/`service_role` keys are never copied into any `VITE_` variable.
- **Time spent:** ~5 min
- **Backend needed?** No.

## Guests can't read bookings, so "is this slot free?" needs a denormalized flag
- **Step:** 2 (schema), driven by the step-4 RLS rules
- **What happened:** The clean model is "a slot is free if it has no confirmed booking". But anon must not read `bookings` (guest names/emails), so the public page can't compute that with a join. Realtime (step 6) also only broadcasts changes on tables the viewer can read.
- **Workaround:** Added `slots.is_booked`, kept in sync by a `security definer` trigger on `bookings`. The unique partial index on `bookings` remains the real guarantee; `is_booked` is a derived copy. Alternatives: a view or RPC that exposes only free slots (doesn't help Realtime), or a `security definer` function.
- **Time spent:** ~15 min (design + testing)
- **Backend needed?** No, but logic now lives in triggers rather than visible app code, which is harder to discover and debug. Worth mentioning in the blog.

## Default grants give anon full write access to every column; RLS can't restrict columns
- **Step:** 4 (RLS)
- **What happened:** New tables in `public` are granted ALL privileges (incl. UPDATE on every column, TRUNCATE) to `anon` and `authenticated`. RLS filters *rows* only. So "host may edit their own slot, but not `is_booked`" or "guest may insert a booking, but not set `status`" can't be expressed with policies alone. A policy-only setup would let a host flip `is_booked` on their own slot.
- **Workaround:** `revoke all` on each table, then column-level `grant insert (col, …)` / `grant update (col, …)`. Error message for a forbidden column is just "permission denied for table X", which doesn't say which column.
- **Time spent:** ~20 min
- **Backend needed?** No, but this is easy to miss: the Supabase docs focus on RLS, and column grants are plain Postgres knowledge.

## Guests have no identity → can't read back their booking, can't cancel via RLS
- **Step:** 4 (RLS)
- **What happened:** (1) `insert(...).select()` needs a SELECT policy on the new row. Guests must not read bookings, so they can't get the generated id/cancel token back; the whole insert fails with 42501. (2) "Whoever holds the cancel token may cancel" can't be written as an RLS policy; a policy can only compare against `auth.uid()`/JWT claims, not a value the client passes.
- **Workaround:** The browser generates the cancel token (`crypto.randomUUID()`) and inserts it (no `.select()`); a `unique` constraint guards it. Cancelling goes through a `security definer` Postgres function `cancel_booking(token)`, called with `supabase.rpc()`. Alternative: Supabase anonymous sign-ins would give guests an `auth.uid()`, at the cost of creating an auth user per guest.
- **Time spent:** ~30 min
- **Backend needed?** No. RPC functions cover it, but logic is moving into SQL functions.

## RLS-blocked update/delete returns success with 0 rows, not an error
- **Step:** 4 (RLS)
- **What happened:** Host B updating host A's slot returns `{ data: [], error: null }`. Not an error, because RLS just makes the row invisible. Forbidden *columns* or a failed `with check`, by contrast, return 42501 errors. Three different "no" shapes.
- **Workaround:** The UI must chain `.select()` on updates/deletes and treat 0 returned rows as "not allowed / not found". The test script does the same.
- **Time spent:** ~10 min
- **Backend needed?** No.

## No abuse protection for anonymous writes
- **Step:** 4 (RLS)
- **What happened:** The publishable key is public by design. Anyone can script it to book every free slot of a host with fake names/emails. RLS decides *who may* write, not *how often*. There's no email verification for guests, no rate limit on PostgREST inserts, and Supabase CAPTCHA only covers auth endpoints.
- **Workaround:** None in this app. Options: a DB trigger that limits bookings per email/IP (IP isn't reliably available in Postgres), anonymous sign-in + CAPTCHA, or an Edge Function that verifies a CAPTCHA/sends a confirmation email before inserting.
- **Time spent:** ~10 min (analysis only)
- **Backend needed?** **Likely yes** for a real product. This is the clearest "Supabase alone isn't enough" point so far (an Edge Function would count as a small backend).

## No notification emails
- **Step:** 5 (pages)
- **What happened:** Nobody gets a confirmation or cancellation email, neither guest nor host. Supabase only sends auth emails (sign-up, reset, magic link); there's no built-in "send an email when a row is inserted".
- **Workaround:** None in this app. Emails would need a Database Webhook or `pg_net` call → Edge Function → an email provider (Resend, Postmark…).
- **Time spent:** ~5 min (analysis only)
- **Backend needed?** **Yes for notifications.** It's a small one (Edge Function + email API), but it is server code and needs a provider secret that must not live in the browser.

## Slot times: browser time zone only
- **Step:** 5 (pages)
- **What happened:** `datetime-local` inputs have no zone; the app treats them as the host's browser time and stores UTC in `timestamptz`. Guests see slots in *their* browser time zone. Fine for this demo, but there's no host time zone stored, so "Mondays 9–5 in Berlin" style rules or showing the host's zone would need schema work.
- **Workaround:** None needed for one-off slots.
- **Time spent:** ~5 min
- **Backend needed?** No.

## Realtime `postgres_changes` silently drops the exact event we needed
- **Step:** 6 (Realtime)
- **What happened:** The obvious approach (add `slots` to the `supabase_realtime` publication, subscribe with `postgres_changes`) delivers INSERTs and "freed again" UPDATEs to guests, but **not** the "slot got booked" UPDATE. Realtime checks each change against the subscriber's RLS on the *new* row; after booking, `is_booked = true` no longer matches the guest SELECT policy, so the event is dropped. No error, no warning. DELETEs didn't arrive either. Verified with a test script before writing UI code.
- **Workaround:** Switched to **Broadcast from Database**. A trigger on `slots` calls `realtime.send()` with a hand-built, PII-free payload to topic `slots:<host_id>`; a private channel + an RLS SELECT policy on `realtime.messages` lets anyone receive, and having no INSERT policy means no client can send. Other options: loosen slots RLS so guests can read booked slots (leaks host's busy times, and changes the step-4 rule), or poll.
- **Time spent:** ~40 min (diagnosis + rework)
- **Backend needed?** No. But knowing *why* it failed requires understanding how Realtime evaluates RLS, which the happy-path docs don't stress. The final setup is a trigger plus a policy on an internal `realtime` schema table: more SQL, less visible.

## Unauthorized Realtime sends report "ok"
- **Step:** 6 (Realtime)
- **What happened:** A client without an INSERT policy on `realtime.messages` calls `channel.send(...)` and gets `"ok"` back, but the message is dropped server-side. Correct for security, confusing when debugging a legitimate sender.
- **Workaround:** Test with a second subscriber to see whether messages actually arrive.
- **Time spent:** ~5 min
- **Backend needed?** No.

## Realtime doesn't replay missed events
- **Step:** 6 (Realtime)
- **What happened:** Broadcast is fire-and-forget. If a viewer's connection drops (laptop sleep, flaky wifi), changes during the gap are lost.
- **Workaround:** Refetch slots every time the channel reports `SUBSCRIBED` (first connect and every reconnect). The database stays the source of truth: a stale page can't double-book anyway (step 2 index + step 4 policy).
- **Time spent:** ~5 min
- **Backend needed?** No.

## Storage MIME check trusts the client's Content-Type
- **Step:** 7 (Storage)
- **What happened:** The bucket's `allowed_mime_types` rejected `text/html` uploads, but an HTML file uploaded *labelled* `image/png` was accepted and served back as `image/png` from the public URL (locally, without an `X-Content-Type-Options: nosniff` header). Storage doesn't inspect file contents.
- **Workaround:** None in this app. Risk is limited: browsers render `image/png` as an image, and only the host can write to their folder. Proper validation (magic bytes, re-encoding, stripping EXIF/GPS metadata) needs code that processes the bytes.
- **Time spent:** ~10 min (verifying)
- **Backend needed?** **Yes, if you need real upload validation**, e.g. an Edge Function that validates/re-encodes before storing, or a background job.

## Files outlive their owner; cleanup needs the Storage API
- **Step:** 7 (Storage)
- **What happened:** Deleting an auth user (cascade-deletes their profile, slots, bookings) leaves their files in Storage. `delete from storage.objects` is blocked on purpose ("Use the Storage API instead"), because removing the row would leave the actual file in the storage backend. So a "delete my account" feature can't clean up in one SQL transaction.
- **Workaround:** The test script deletes its own uploads through the API before the users are removed; one orphan was removed manually with the local secret key (one-off, not stored). A real "delete account" flow would need an Edge Function with the secret key: list + remove the user's files, then delete the user.
- **Time spent:** ~15 min
- **Backend needed?** **Yes for account deletion** (small: one Edge Function).

## Replacing a picture is three non-atomic calls
- **Step:** 7 (Storage)
- **What happened:** Overwriting a fixed path (`<uid>/avatar.png`) keeps the same public URL, so browsers/CDN keep showing the old picture (default `cache-control: max-age=3600`). Using a new random file name per upload avoids that, but replacing then means: upload new file → update `profiles.avatar_path` → delete old file. Three requests, no transaction across Storage and the database.
- **Workaround:** If the profile update fails, delete the just-uploaded file; deleting the old file is best effort (a failure only leaves an orphan, nothing breaks).
- **Time spent:** ~10 min
- **Backend needed?** No, though a cleanup job for orphans would be nice.

## No image resizing locally; it's a paid feature hosted
- **Step:** 7 (Storage)
- **What happened:** Hosts can upload up to 2 MB, and the booking page shows that full file in a 64 px circle. Supabase's on-the-fly image transformations (`getPublicUrl(path, { transform: { width: 128 } })`) use the `imgproxy` service, which the local stack doesn't start by default (seen as "Stopped services: imgproxy" in `supabase start`), and which is a Pro-plan feature on hosted Supabase.
- **Workaround:** Kept the 2 MB limit; images are scaled down by CSS only. Could resize in the browser (canvas) before upload.
- **Time spent:** ~5 min
- **Backend needed?** No (paid plan or client-side resize).

---

# Advanced feature 1: recurring bookings (transactions)

A guest books the same weekly slot for N weeks: one `booking_series` row + one booking per week (each booking marks its slot taken via the existing trigger). Rule: **all-or-nothing**; if any week clashes, nothing is created and the guest is told which week. Probe page: `/probes/recurring`, test data: `npm run probe:recurring:seed` (test host with 6 Mondays, week 4 already booked). The page calls `bookRecurring()` from `src/services/`, with the implementation selectable.

## Stage 1: separate supabase-js calls break all-or-nothing
- **Step:** Advanced 1, stage 1
- **What happened:** The naive version (`split.js`) makes 1 + 2N calls: insert the series, then per week look up the free slot and insert the booking. Booking 6 weeks with week 4 taken: the client stops at week 4 and tells the guest it failed, but the **series row and weeks 1–3 stay committed**, and those three slots are now taken for everyone else. Confirmed with `check.sql` in Studio: `weeks_requested 6, weeks_saved 3, saved_weeks 1, 2, 3`. supabase-js has **no transaction API**. Every call is its own HTTP request and its own transaction, committed the moment it returns.
- **Not the problem: one call with an array.** `.insert([row1, row2, …])` is a single SQL statement and is **atomic**. Tested: inserting weeks 5 (free) + 4 (taken) in one call → `42501`, **0 rows saved**. So the problem only appears when one action needs **several calls or several tables**. Here that's unavoidable: the series must exist before bookings can reference it (separate table), and each week needs its slot id first.
- **Guests can't tell "booked" from "never offered".** RLS only shows guests free, future slots, so the booked week 4 is simply missing, the same as a week the host never offered. The guest can only be told "week 4 is not available", not why.
- **Cleaning up in the browser doesn't work.** Deleting the leftovers after a failure would be another request: it fails if the tab closes or the network drops, and it would mean giving anonymous guests DELETE rights on series and bookings that they otherwise never need. Not built, on purpose.
- **A pre-check doesn't fix it either.** Reading all N weeks first and only writing if all are free still leaves a window between check and write where another guest can book a week (the insert then fails with `42501`/`23505`, mid-series). Only a transaction closes that window.
- **Integrity gap:** with separate inserts the database can't easily check that a booking's slot belongs to the series' host, or that `week_no` matches the date. Anonymous guests have no SELECT on `booking_series`, so an RLS check on `bookings` can't even look at the series. Low risk (series ids are random uuids), but the rows are only as consistent as the browser code makes them.
- **Code:** migration 73 lines (`booking_series` table, `series_id`/`week_no` on bookings, grants, RLS). `split.js` 65 lines. Services layer 56 lines (`src/services/index.js` backend switch + `src/services/supabase/index.js`). Probe page 140 lines, seed 62 + check SQL 29 lines, 2 lines in the router, 1 npm script. 10 files, ~485 lines including the CLAUDE.md (57).
- **Testing / debugging:** Easy. The failure is deterministic with the seed data, and one SQL query shows the half-finished series. The guest-facing result looks correct ("week 4 not available"), which is exactly why it's dangerous: **nothing in the UI or the library warns that 4 earlier writes were kept.**
- **Surprising:** `npm run test:clean` deletes all `@test.dev` users, which includes the probe's test host. Re-run the seed afterwards.
- **Seen during manual testing (looked like a bug, wasn't):** after three test runs the page showed only 3 of the 5 free Mondays, and one run failed with "Week 2 (Mon, 30 Nov) is not available". Both were stage 1 working as designed: each failed run had left its earlier weeks booked (hiding those Mondays from the next run and causing the next clash), and the "30 Nov" run had started from the *last* seeded Monday, so week 2 simply didn't exist. The leftovers are invisible from the guest's side; only Studio showed what had happened. The probe was improved: the seed now prints a reset confirmation (counts of slots, bookings, series), and a request for more weeks than the host offers from that date is rejected **before any write** as "only K weeks available" instead of being reported as a clash. The guest can only see free slots, so if the host's *last* week is booked, this check counts one week less (another RLS visibility limit).
- **Time spent:** ~45 min (incl. removing the earlier transactions probe and setting up `src/services/`) + ~20 min investigating the manual-test report
- **Backend needed?** Not yet decided: stage 2 (Postgres function via `rpc()`) and stage 3 (Edge Function with a direct Postgres connection) test the two fixes.

## Stage 2: one Postgres function via `rpc()` makes it all-or-nothing
- **Step:** Advanced 1, stage 2
- **What happened:** The whole loop (check weeks offered → insert series → per week: find slot, insert booking) moved into a PL/pgSQL function `book_recurring`, called once from the browser with `supabase.rpc('book_recurring', {...})`. PostgREST runs an rpc call as **one transaction**, so when the function raises an error, Postgres undoes every write it already made. `SECURITY INVOKER`, so it runs as the caller (`anon` for guests) and the same grants and RLS apply inside it. Results, all as an anonymous guest with the publishable key:
  - **Week-4 clash:** error `RB001 Week 4 is not available` → **0 series, 0 bookings** (stage 1: 1 series + 3 weeks left behind).
  - **Not enough weeks:** `RB002` before any write.
  - **Success (2 weeks):** 1 series + 2 bookings, both slots marked taken.
  - **Real race:** another session booked week 3 inside an open transaction. The function **waited** on the unique index until that transaction committed (~1.6 s: the test held the other transaction open for 2 s on purpose, so this is not a performance figure), then got `23505`, reported "week 3 just taken" and rolled back weeks 1–2. Nothing left behind.
  - **RLS proof** (`sql/rpc-rls-proof.sql`): with the series insert policy dropped (inside a rolled-back transaction), the function called as `anon` fails with `42501 new row violates row-level security policy`. The same call as the database owner succeeds, because the owner bypasses RLS. So `SECURITY INVOKER` really does keep RLS on.
- **Gotchas found while writing it:**
  - **Failures must be RAISEd, not returned.** A function that returns `{ok: false}` after inserting weeks 1–3 *commits* weeks 1–3, the stage 1 bug all over again, just inside SQL. Only an exception rolls back. Clashes are therefore errors with custom SQLSTATE codes (`RB001`, `RB002`) and a JSON `detail`. PostgREST passes both through (`error.code`, `error.details` as a **string** the client must `JSON.parse`).
  - **`INSERT … RETURNING` needs SELECT rights.** Guests can't read `booking_series`, so the function generates the series id itself instead of getting it back from the insert.
  - **`interval '7 days'` follows the session time zone's DST rules**; `interval '168 hours'` doesn't. Used hours, matching `WEEK_MS` in `split.js`.
  - The race needed an extra `BEGIN … EXCEPTION` block around each insert to turn `23505`/`42501` into "week N just taken". Without it the guest gets the raw unique-violation message and no week number (it still rolls back correctly).
- **Trade-off: SECURITY INVOKER keeps the side door open.** Because the function runs with the guest's rights, guests must keep their direct INSERT grants on `booking_series` and `bookings`. Anyone can still skip the function and send stage-1-style separate inserts by hand (that's how stage 1 still works). Forcing everyone through the function means `SECURITY DEFINER` + revoking those grants, but then RLS is bypassed inside the function and every rule (free slot, future, host match) must be re-written as explicit checks in the function. Supabase gives you one or the other: **RLS inside, or a single enforced entry point, not both.**
- **Logic now lives in two languages.** The weeks-offered and week-date calculations exist in `split.js` and again in SQL; the NestJS version will be a third copy. Moving logic into the database is what makes it atomic, but it splits the app's rules between JavaScript and PL/pgSQL.
- **Code:** migration 107 lines (function ~85 lines incl. comments), `rpc.js` 37 lines, 4 lines in the services index, 4 lines on the page, RLS proof script 28 lines. 5 files, ~179 lines. No new tables or grants.
- **Testing / debugging:** Moderate. The happy path and clash were easy to check (`check.sql`). Proving the race and the RLS behaviour needed `psql` with concurrent sessions and `set role anon`, things you can't do from the browser. Errors inside the function come back with a useful `CONTEXT` line (function + line number), but there's no step debugger; `raise notice` is the print statement. Changing an already-applied function means a new migration (`create or replace`); `npx supabase migration up` applies it without wiping data.
- **Surprising:** How small the browser side became: one call, no loop, no cleanup. And that a correct transaction **blocks** under contention (the guest's request waited for the other one), which is right but invisible until you test concurrency.
- **Time spent:** ~40 min
- **Backend needed?** **No** for atomic multi-table writes: a Postgres function is enough, as long as everything happens inside the database. It stops being enough if a step must call the outside world mid-transaction (payment, e-signature: features 4 and later), or if you want the logic in application code. Stage 3 tests that alternative.

## Stage 3: Edge Function with a direct Postgres connection (BEGIN/COMMIT/ROLLBACK)
- **Step:** Advanced 1, stage 3
- **What happened:** `supabase/functions/book-recurring/index.ts` (Deno/TypeScript) opens a direct Postgres connection (`postgres` npm package, `SUPABASE_DB_URL`), reserves one connection and runs `BEGIN` → series → per week: find slot, insert booking → `COMMIT`, or `ROLLBACK` on any clash. The browser calls it with `supabase.functions.invoke('book-recurring', …)`. Proof script `npm run probe:recurring:edge-proof`: **17/17 checks pass**:
  - **Identity verified before any database access:** no apikey, an unknown apikey, and forged ES256/HS256 tokens claiming `service_role` → all **401**, nothing written.
  - **Anonymous guest:** week-4 clash → **409, 0 series, 0 bookings**; ran as role `anon`, `auth.uid()` null. "Only 2 weeks available" → 422.
  - **Logged-in user:** booked, and inside the transaction `current_user = authenticated` and `auth.uid()` = that user's id.
  - **RLS enforced:** a past slot is visible to the `postgres` connection but not to `anon`. Booking it through the function → "week 1 not available"; the slot stays free. "No past bookings" is a rule only RLS enforces (no constraint), so this shows the role switch works.
  - **Race:** a concurrent booking of week 3 → the function waited for it (the test held it open ~2 s), reported "week 3 just taken", rolled back weeks 1–2.
- **The big trap: a direct connection bypasses RLS.** `SUPABASE_DB_URL` connects as `postgres`. That role is **not a superuser** on Supabase (checked locally: only `supabase_admin` is), but it is privileged: it **owns the tables** and has the **`BYPASSRLS`** attribute (and the tables don't use `FORCE ROW LEVEL SECURITY`), so RLS doesn't apply to it. Which role the hosted `SUPABASE_DB_URL` uses: to verify before publishing. Every query would silently ignore every policy. Supabase doesn't warn about this. To get RLS back, the function must do by hand what PostgREST does for every API request: `set_config('role', 'anon' | 'authenticated', true)` and `set_config('request.jwt.claims', <claims>, true)` at the start of **each** transaction (the `true` = transaction-local, so the next request on the same connection doesn't inherit it). Forget either and it still "works", just without RLS, or with `auth.uid()` = null.
- **Verifying the caller is your job, and the built-in check doesn't do it.** Findings (local CLI 2.120):
  - A guest has **no JWT**. With the new keys supabase-js sends the publishable key (`sb_publishable_…`) as the bearer token, not a JWT.
  - The built-in `verify_jwt` rejects a malformed token, but **lets through the publishable key or no `Authorization` header at all**, so it doesn't establish an identity. `supabase functions new` already scaffolds `verify_jwt = false`.
  - The function therefore checks: apikey ∈ `SUPABASE_PUBLISHABLE_KEYS`; publishable key (or no) bearer → `anon`; otherwise `auth.getClaims(token)` (ES256 signature checked against the project's JWKS; HS256 or unknown keys fall back to asking the Auth server) and only `anon`/`authenticated` roles are accepted. A legitimately signed `service_role` token is refused (403), because it would bypass RLS.
  - The new `@supabase/server` helper (`withSupabase({ auth: … })`, which the CLI template now uses) can validate keys and JWTs, but the client it hands you is the normal HTTP API client, so it **can't** run BEGIN/COMMIT across statements. Not used.
- **Local dev needs a second process.** `supabase start` runs the Edge runtime but doesn't serve new functions; `npm run functions:serve` (`supabase functions serve`) must run in its own terminal. Its hot reload briefly answers 503 `name resolution failed` right after a file save.
- **Error bodies are awkward on the client.** On any non-2xx response, `functions.invoke` returns a generic `FunctionsHttpError` ("Edge Function returned a non-2xx status code"); the JSON body (which week clashed) must be read from `error.context` (the raw `Response`).
- **Logic now exists in three places.** The week maths and "weeks offered" check live in `split.js`, the SQL function and the Edge Function (TypeScript, but a Deno function can't simply import the Vue app's `src/` files). The NestJS version will be a fourth.
- **Hosted-only concerns (not tested locally):** connection limits. Each function instance holds its own Postgres connection, so hosted projects should use the transaction pooler (port 6543; the code already sets `prepare: false` for it). Plus cold starts, and the function must handle CORS itself (locally the gateway answered the preflight).
- **Code:** function 146 lines + `deno.json` 7, client `edge.js` 29, services index 4, page 4 (shows the role the transaction ran as), `config.toml` 11 (generated), proof script 109, 2 npm scripts. 9 files, ~314 lines.
- **Testing / debugging:** The best of the three for *writing* the logic: ordinary TypeScript, `console.log` shows in the `functions serve` terminal, readable try/catch around the transaction. The hardest to *trust*: everything security-related (who is calling, which role, whether RLS applies) is now hand-written code that has to be proven with tests. Nothing fails visibly if it's wrong.
- **Surprising:** It worked on the first call. The time went into finding out what the gateway actually sends and checks (two throwaway echo functions), which isn't clear from the docs with the new key types.
- **Time spent:** ~60 min
- **Backend needed?** **This *is* a small backend**, just hosted by Supabase. It's worth it when the transaction must sit next to application code: calling an external API between steps (payments, e-signature, feature 4), or keeping complex rules in TypeScript. The price is re-implementing what PostgREST gives for free: authentication, role switching, error mapping, CORS, connection handling.

### Recurring bookings: the three stages compared

| | Stage 1: split calls | Stage 2: Postgres function | Stage 3: Edge Function |
|---|---|---|---|
| All-or-nothing | ❌ series + weeks 1–3 left behind | ✅ | ✅ |
| Where the logic lives | browser JS | PL/pgSQL in a migration | TypeScript (Deno) on Supabase |
| Requests per booking | 1 + 2N (13 for 6 weeks) | 1 | 1 |
| RLS inside | ✅ (normal API) | ✅ `SECURITY INVOKER` | ✅ only because the function switches role itself |
| Auth handled by | Supabase | Supabase | **your code** |
| Race (concurrent booking) | partial writes | waits, rolls back | waits, rolls back |
| Can call an external API mid-transaction | — | ❌ | ✅ |
| New lines (approx.) | ~485 incl. setup | ~179 | ~314 |
| Hardest part | noticing the problem at all | raise-don't-return, invoker vs definer trade-off | identity + RLS on a privileged (RLS-bypassing) connection |

**For the blog:** Supabase handles multi-table transactions without a custom server, via a Postgres function. A server (an Edge Function counts) only becomes necessary when the transaction has to include something outside the database. Even then the database stays the place where atomicity happens; the server just has to be careful not to switch RLS off on the way in.

---

# Advanced feature 2: audit log

A permanent record of who changed what, and when: bookings (create/cancel), slots (create/move/delete), booking series, profiles. Decisions: actor = user id + role from the JWT (guests: role `anon`, no id), no IP addresses, only changed fields, guest emails masked, no secrets (`cancel_token`). Hosts read entries about their own slots; nobody edits or deletes entries. Sign-in events are not logged here: Supabase Auth keeps its own auth logs (Dashboard → Logs), outside the app's database tables.
Probe page: `/probes/audit`, reset: `npm run probe:audit:seed`, proof: `npm run probe:audit:proof`.

## Stage 1: logging from the browser can't be trusted
- **Step:** Advanced 2, stage 1
- **What happened:** Each action (guest books, guest cancels, host cancels, host deletes a slot) does the action and then inserts an entry into `audit_log_client` (two requests). The proof script reproduces all five problems from the plan (18/18 checks):
  1. **Skipping:** the same booking sent directly with supabase-js (what anyone can do from devtools) → a real booking, **no log entry**.
  2. **Other paths:** a recurring booking via rpc (2 bookings + series), a profile edit in Studio, and the seeded "Someone Else" booking → **no entries**. The existing booking and cancel pages don't log either. Every code path, current and future, must remember to call the logger.
  3. **Forging:** an anonymous guest writes "host deleted slot (week 3)" → **accepted**; the slot still exists. Guests must have INSERT on the log for browser logging to work at all, and the database can't check that the described action happened.
  4. **Act, then the log request fails:** the booking is saved and the log has no entry.
  5. **Log first, then the action fails:** the log says "booking created" for week 4 (already taken), and **no such booking exists**.
- **What did work:** the *who* can't be faked. `actor_id`/`actor_role` are column defaults from the JWT (`auth.uid()`, `auth.role()`) and clients get no grant on those columns (`42501` when trying). Hosts read only entries about them (RLS); nobody can edit or delete entries (no UPDATE/DELETE grants → `42501`).
- **Guests can't even say what they changed.** Guests have no SELECT on `bookings`, so the browser never learns the id of the booking it just created: the entry can only reference the slot. A guest cancel (via the `cancel_booking` rpc, by token) has the same problem, and the token itself is a secret that must not go into the log.
- **Studio's check is the only reliable view.** `sql/check.sql` compares reality with the log in both directions (bookings with no entry; entries with no booking or a slot that still exists). Nothing in the app can do that comparison, because guests can't read either table.
- **Code:** migration 49 lines, `clientLog.js` 117 (masking, two orderings, 4 actions), services index +22/6, probe page 173, proof script 93, check + seed SQL 49, router 1, 2 npm scripts. 11 files, ~520 lines incl. CLAUDE.md (10).
- **Testing / debugging:** Easy to demonstrate, because every problem is deterministic. The problems are invisible from the app: the page itself says "logged" for forged entries. Only an owner-level comparison (Studio/psql) shows the gaps.
- **Surprising:** How *normal* the failing code looks: "do it, then log it" is what most tutorials show. And that even the easy case (a guest's own booking) can't produce a complete entry, because RLS hides the new row's id from its own creator.
- **Time spent:** ~45 min
- **Backend needed?** Not yet decided. The problems come from logging in a *separate request from an untrusted client*. Stage 2 moves logging into database triggers (same transaction, no client grants); the NestJS comparison would put it in server code (interceptor/service), which has the "other paths" problem for anything that bypasses the server (Studio, migrations, scripts).

## Stage 2: database triggers make the log complete and tamper-proof
- **Step:** Advanced 2, stage 2
- **What happened:** One PL/pgSQL trigger function (`audit_row_change`) on `bookings`, `slots`, `booking_series` and `profiles` writes `audit_log` after every insert/update/delete, in the same transaction as the change. Clients have **no** insert/update/delete rights on `audit_log`; hosts read entries about them (RLS). Proof script `npm run probe:audit:proof:triggers`: **21/21 checks**. Every stage 1 problem is gone:
  1. **Skipping:** a direct API booking with no logging code → logged, with the **real booking id** (stage 1 couldn't know it), the host, actor `anon`, masked email, no cancel token.
  2. **Other paths:** rpc (recurring + guest cancel), Edge Function (direct connection), host actions, Studio → all logged. The Edge Function entries carry the caller's identity (`anon`, or the logged-in user's id) because stage 3 of feature 1 sets the JWT claims; without that, they'd show up as `postgres`.
  3. **Forging:** guests and hosts get `42501` inserting into `audit_log`; the trigger function can't be called as an rpc.
  4./5. **Out of sync:** impossible. A failed booking leaves no entry, and the recurring rpc that clashes in week 4 leaves **0 entries** (the series + weeks 1–3 entries were rolled back with them). A successful 2-week recurring booking gives 3 entries sharing one `tx_id`.
  Side by side for the same booking with the browser's log request failing: browser log 0 entries, trigger log 1.
- **How the trigger knows who:** `auth.uid()`/`auth.role()` read the request's JWT claims, a session setting, so they still work inside `SECURITY DEFINER` functions (the trigger itself, and `cancel_booking`, where a guest cancel is still recorded as `anon`).
- **What triggers can't do:**
  - **No person for admin changes.** Studio, psql and the secret key have no JWT: entries show the database user (`postgres`, `supabase_auth_admin`) and no id. The log knows *that* something changed, not *who* in your team did it.
  - **Cascades flood the log.** Deleting the test host wrote 16 entries (profile, 6 slots, 1 booking created and deleted), and the cascaded **booking deletion has no host**: its slot was already gone when the trigger looked it up, so the host can't see that entry.
  - **Reads aren't logged**, only changes (that would need `pgaudit` to the server log, or logging in an API layer).
  - **The owner can still erase history.** `postgres` can disable triggers or delete log rows. Protection against admins needs something outside the database (e.g. shipping entries to external storage).
  - **Logic in SQL again.** Diffing old/new rows, masking emails, naming actions and finding the host: 146 lines of migration, harder to read than the JS equivalent. Changing it means a new migration (I edited this one before committing and used `db reset`, which also wipes local data).
- **Noise decisions:** a slot update that only flips the derived `is_booked` flag isn't logged (the booking entry already says what happened); empty fields are stripped from created/deleted rows.
- **Code:** migration 146 lines (table, masking function, trigger function, 4 triggers), proof script 140, Studio comparison SQL 30, seed +6, page +4, 1 npm script. **No app code changed.** Logging no longer depends on any service function.
- **Testing / debugging:** Easy to verify from outside (every path just shows up in the table), but the trigger itself is only debuggable via `raise notice` or by reading the log rows. A bug in the trigger would make **every** write to those tables fail, so the proof script is essential.
- **Surprising:** It's the first feature where the Supabase answer is clearly *better* than typical backend code: an API-layer logger (e.g. a NestJS interceptor) would still miss Studio, scripts, migrations and cascades.
- **Time spent:** ~50 min
- **Backend needed?** **No.** Triggers are the stronger solution and need no server. A backend would only add value for logging reads, attaching request context (e.g. which admin in a back-office tool), or shipping logs somewhere the database owner can't edit.

## Stage 3: Supabase's ready-made tools (supa_audit, pgaudit) vs. our triggers
- **Step:** Advanced 2, stage 3
- **What happened:** Installed `supa_audit` next to our stage 2 triggers (migration `20261012182300_audit_supa_audit.sql`), and switched on `pgaudit` temporarily (it's a role setting, not schema). `npm run probe:audit:compare` runs the same five actions (guest booking, rolled-back recurring rpc, guest cancel rpc, host deletes a slot, Studio edit) and reads all three logs: **11/11 checks**.

| | Ours (stage 2 triggers) | supa_audit | pgaudit |
|---|---|---|---|
| Status | our code | **repository archived** on GitHub, last commit 2 Jan 2024 (checked via the GitHub API on 14 Oct 2026); not in the local image | preloaded in the local Supabase image (`shared_preload_libraries`) |
| Install | 1 migration | copy its SQL + **patch** (see below) | `create extension` + role settings + restart API connections |
| Where | `audit_log` table | `audit.record_version` table | Postgres **server log** (local: `docker logs`; hosted: Dashboard → Logs, retention per plan) |
| Who: guest | `anon` | `anon` | only `authenticator` (the API's shared DB user) |
| Who: host | host's user id | host's user id | only `authenticator` |
| Who: Studio | `postgres` | nothing | `postgres` |
| Values | changed fields, from → to | **full** old + new row | none for API calls (`<not logged>`); literal values for SQL typed in Studio |
| Rolled-back changes | not recorded | not recorded | **recorded**, no marker that they were undone |
| One guest booking | 1 entry | 2 (+ the `is_booked` flag update) | 9 lines (incl. our trigger's and Realtime's internal statements) |
| Secrets | email masked, no cancel token | **cancel token + full email copied** | API values not logged |
| Readable in the app | yes, host's own entries (RLS) | no (schema not exposed) | no |
| Reads logged | no | no | yes (needed anyway, see below) |

- **supa_audit, as published, broke every sign-up.** Its trigger looks up `uuid_generate_v4/v5` through the *caller's* `search_path`; Supabase installs them in `extensions`, and `handle_new_user()` (creates the profile on sign-up) runs with an empty `search_path`. Result: `500 "Database error saving new user"`, and our seed script failed too. Nothing in the install pointed at the cause; the Postgres log did. Fixed with a 2-line patch (pin the functions' `search_path`), reproduced in the compare script inside a rolled-back transaction. Its two `pg_extension_config_dump` calls also had to be removed (only valid inside `CREATE EXTENSION`). Its functions were executable by `PUBLIC` (harmless here only because `anon` has no access to the `audit` schema); revoked.
- **supa_audit got "who" right.** When it detects Supabase it adds `auth_uid`/`auth_role` columns from the JWT. The README's example doesn't show them; only the install script does. I first assumed it couldn't record who, and was wrong.
- **pgaudit and the API:** with `pgaudit.log = 'write'`, API writes are **not logged at all**: PostgREST sends them as `WITH … INSERT … SELECT`, which pgaudit classifies as a *read*. Only `'read, write'` captures them, which also logs every read. Role settings reach the API only after its pooled connections reconnect (restart the API container). Locally, `postgres` can't enable `pgaudit.log_parameter` (permission denied), so values of API calls stay `<not logged>`; whether hosted Supabase allows it: to verify before publishing.
- **Verdict:** for an in-app audit trail (who did what, readable by the host), our ~150-line trigger is the best of the three. supa_audit is a decent generic *change history* (full rows, stable record ids) but is unmaintained, needed a patch to not break sign-up, and stores secrets and personal data unfiltered. pgaudit answers a different question ("which SQL ran on this server?"), useful for compliance and debugging, not for showing users a history.
- **Other friction:** `supabase migration new <name>` waits for input when it isn't run in an interactive terminal (it reads the migration's SQL from stdin): it created an empty file and hung until killed; pass `< /dev/null`. During testing the local Edge Function endpoint once stopped answering for a few minutes and recovered without changes; cause unclear. The audit proof now times out after 5 s instead of waiting forever.
- **Code:** supa_audit migration 323 lines (~290 vendored + header, patch, tracking), compare script 169, seed +5, proof timeout 1 line, 1 npm script. 5 files, ~500 lines. No app code changed.
- **Testing / debugging:** supa_audit: easy to inspect (it's a table), hard to diagnose when it breaks *something else* (sign-up failed with a generic 500). pgaudit: slow loop (role settings + API restart + reading container logs), output is raw SQL text, and the noise (internal statements of triggers and functions) makes finding one action hard.
- **Surprising:** that the "official" auditing tool broke authentication on install, and that pgaudit can't see writes from Supabase's own API without logging all reads.
- **Time spent:** ~90 min (incl. the revert/redo and the pgaudit investigation)
- **Backend needed?** **No.** None of the three needs a server. A backend would only help with "who" for pgaudit-style SQL logs (it knows the user, the database doesn't) and with shipping logs somewhere the database owner can't edit.

## Stage 4: the host's history page
- **Step:** Advanced 2, stage 4
- **What happened:** A **History** page (`/history`, link in the top bar) shows the logged-in host everything that happened on their booking page, newest first, in plain words: who ("You", "Guest", "Database admin", "System (account)") and what ("booked Mon 19 Oct 15:30 for Anna (a\*\*\*@example.com)", "moved a slot from … to …", "renamed the page …"). A recurring booking (series + N bookings, one transaction) is **one line**. Filter (all / bookings / slots / profile), "Load more" (50 per page). Data: `listAuditHistory()` in `src/services/`; display logic in `src/features/audit/history.js` (pure functions, tested without the app). Proof `npm run probe:audit:proof:history`: **12/12 checks**.
- **Context at write time.** Stage 2 entries for bookings only stored `slot_id`, so after a slot was moved or deleted the history couldn't say *which time* had been booked. New `context` column, filled by the trigger when the entry is written (booking: slot time + guest name; slot: its time; series: weeks/weekday/time). Proven: Anna's booking still shows "Mon 19 Oct 15:30" after the host cancelled it and deleted the slot. Lesson: an audit trail must not depend on joins to data that can change later.
- **Paging gotcha:** all entries of one transaction share the same `created_at` (Postgres' `now()` is the transaction *start*). A "older than this time" cursor would silently skip the rest of a recurring booking at a page boundary. The cursor is (`created_at`, `id`), expressed as a PostgREST `or=(created_at.lt.X,and(created_at.eq.X,id.lt.Y))` filter. Proven by paging 2 at a time: every entry exactly once.
- **No new security code.** Reading was already restricted by stage 2's RLS policy (host sees entries about them); the page needed nothing extra. Proven again through the page's own service: another host gets 0 entries, a guest gets `42501`.
- **supa_audit removed** (`20261012214601_audit_remove_supa_audit.sql`): no more double logging, cancel tokens or full emails in `audit.record_version`. `probe:audit:compare` now skips with a pointer to commit `603a771`.
- **Limits:** times show in the viewer's browser time zone (feature 6). Older stage 2 entries have no context and show "a slot". Cascaded booking deletions still have no host (stage 2), so they never appear here. No live updates: "Refresh" re-reads (Realtime on `audit_log` would need its own RLS-safe channel, like the slots broadcast).
- **Code:** 2 migrations (101 lines context + trigger, 13 lines removal), service 31, display helpers 72, page 75, router/nav/services 9, proof 97, compare guard 7, 1 npm script. 12 files, ~400 lines.
- **Testing / debugging:** Easy. The proof prints exactly what the page shows; the display logic is plain JavaScript; RLS was already proven.
- **Surprising:** that the hardest part was not Supabase but data modelling: recording context at write time, and a transaction-safe cursor.
- **Time spent:** ~45 min
- **Backend needed?** **No.** RLS + a view-less query + client-side formatting is enough.

### Audit log: the four stages compared

| | Stage 1: browser logs | Stage 2: triggers | Stage 3: supa_audit | Stage 3: pgaudit |
|---|---|---|---|---|
| Can be skipped | ❌ yes (direct API call) | ✅ no | ✅ no | ✅ no |
| Other paths (rpc, Edge Function, Studio) | ❌ missed | ✅ logged | ✅ logged | ✅ logged |
| Forged entries | ❌ accepted | ✅ impossible | ✅ impossible | ✅ impossible |
| Rolled-back changes | ❌ out of sync | ✅ not logged | ✅ not logged | ❌ logged as if they happened |
| Who | ✅ from JWT | ✅ from JWT | ✅ from JWT | ❌ only `authenticator` |
| Secrets / personal data | ✅ masked by client | ✅ masked, no token | ❌ token + full email | ✅ API values not logged |
| Host can read it in the app | ✅ | ✅ (stage 4 page) | ❌ | ❌ |
| Effort | small JS, but every path must call it | ~150 lines SQL | vendor + patch (broke sign-up) | role settings + API restart |

**For the blog:** an audit log is where Supabase does *better* than typical backend code. Database triggers see every change from every path, in the same transaction, and RLS makes them readable per host with no extra code. A NestJS interceptor would still miss Studio, scripts, migrations and cascades. The two "official" tools didn't fit: `supa_audit` is archived and broke sign-up as published; `pgaudit` answers "which SQL ran", not "who did what". **Total feature time: ~4 h (4 stages).**

---

# Advanced feature 4: third-party integration (DocuSign e-signature)

A host can require a **signed agreement**: new bookings on their page wait for the guest's signature (DocuSign, by email) before they're confirmed. Decisions: host opt-in (other hosts unchanged), signing by email (works for anonymous guests), webhooks tested with simulated DocuSign messages plus a "check status with DocuSign" fallback (DocuSign can't reach `localhost`, and no tunnel is installed). Setup verified beforehand with `scripts/docusign-check.mjs` (JWT grant, demo account).

Planned stages: 1. bookings that wait for a signature (no DocuSign yet), 2. sending the agreement (Edge Function), 3. receiving the result (webhook Edge Function + status check), 4. failure cases (DocuSign down, declined, never signed, cancelled after sending).

## Stage 1: bookings that wait for a signature
- **Step:** Advanced 4, stage 1
- **What happened:** `profiles.require_signature` (host setting, checkbox on the Dashboard); booking status `pending_signature` plus columns for the integration (`signature_status`, `envelope_id`, `signature_error`, `signature_updated_at`). A `BEFORE INSERT` trigger turns a new booking on an opt-in host's page into `pending_signature`; clients can't send a status, so nobody can skip it. A waiting booking **holds the slot**. Proof `npm run probe:docusign:proof:pending`: **15/15**: hosts without opt-in unchanged; slot held and hidden; second booking rejected; guest and host can't confirm or mark it signed; guest (rpc) and host can cancel it; recurring bookings wait per week; switching off affects only new bookings. Core RLS suite still 60/60.
- **The integration reaches into the core.** A new state isn't additive. The double-booking index (`status = 'confirmed'`), the `is_booked` trigger, the host's cancel policy and the `cancel_booking` rpc all hard-coded `'confirmed'` and had to be replaced. The core pages had to change as well: the guest's page treated anything not `confirmed` as **cancelled** (struck through), and the Dashboard showed a waiting booking's slot as **free** with a "Delete" button that RLS would then silently refuse. 8 changed lines in `BookView.vue`, 10 in `DashboardView.vue` (they still call supabase directly, as listed in CLAUDE.md).
- **Who decides the status:** a trigger, not the client and not RLS. RLS can only *reject* rows; it can't change a value, so "your booking starts as pending" needs `BEFORE INSERT`. Status columns have no client grants, so a guest sending `status: 'confirmed'` gets `42501`.
- **Code:** migration 122 lines, Dashboard setting component 47, services 16, core pages ~20 changed lines, proof 93. 9 files, ~300 lines.
- **Testing / debugging:** Easy. Everything is database rules, testable with a guest and a host client. The regression suite mattered most here, because core rules were replaced.
- **Surprising:** how many places a "simple" new status touched: 4 database objects and 2 pages, all of which silently did the wrong thing until updated.
- **Time spent:** ~45 min
- **Backend needed?** Not for this stage (pure database). Sending and receiving (stages 2–3) need the private key and a public webhook URL, so server-side code (Edge Functions).

## Stage 2: sending the agreement (database → pg_net → Edge Function → DocuSign)
- **Step:** Advanced 4, stage 2
- **What happened:** When a booking starts as `pending_signature`, an `AFTER INSERT` trigger queues an HTTP call with **pg_net** to the Edge Function `docusign-send` (once per booking, or once per recurring series). The function claims the booking(s) (`pending → sending`, committed first), builds an HTML agreement (host, guest, all session times, anchors for signature and date), creates the DocuSign envelope via the eSignature API (JWT grant, token cached per instance) and records `envelope_id` + `sent`, or `failed` + the error. Proof `npm run probe:docusign:proof:send`: **13/13**, including **real envelopes**: DocuSign confirmed status `sent` to the test address; a 2-week series got **one** envelope; calling the function again sends nothing; the History page shows "DocuSign sent the agreement to …".
- **pg_net as an outbox:** `net.http_post()` only queues; pg_net's background worker sends after **commit**. Proven: a recurring booking that clashes and rolls back queues **0** requests, a committed one exactly 1. This is the transaction lesson of feature 1 applied to an external system: no agreement for a booking that never existed.
- **Configuration can't live in migrations.** The trigger needs the function's URL (local: `http://kong:8000/...` from inside Docker; hosted: the project URL) and a secret key, so they live in **Vault**. Plus the function needs the DocuSign values, the private key as base64 (a deployed function has no key file) in `supabase/functions/.env`. Two places, kept in sync by `npm run probe:docusign:setup`; on a hosted project that would be `supabase secrets set` + Vault entries, set by hand per environment.
- **pg_net's 5 s default timeout vs. cold starts:** the first request to the local function timed out after 5 s (cold start); a warm one answered in milliseconds. Raised to 30 s. A timed-out request isn't retried, so the booking would stay `pending` (stage 4 adds a retry).
- **Who sent it:** the function writes through a direct connection as `postgres` (a system process; no user identity to apply), but sets JWT claims `{"role": "docusign"}`, so the audit trigger records the actor as `docusign` and the History page shows "DocuSign". Without that it would read "Database admin".
- **Security:** the function only accepts the project's secret key (browsers get 401). It trusts nothing in the request but an id: it loads the booking itself and only sends for bookings that are really waiting, so a repeated or forged call can at worst trigger the one send that was due anyway. Guest/host names are HTML-escaped in the agreement.
- **Gotcha found in testing:** after this stage, *every* waiting booking sends a real email. The stage 1 proof books with made-up addresses (`g@example.com`), so it now switches sending off (Vault URL → unreachable) while it runs and restores it on exit. Its "pending count" check also had to be scoped to the test host, because real bookings made by hand on other hosts were counted.
- **Code:** migration 73 lines, shared DocuSign helper 82, send function 110, setup script 56, proof 162, History wording +27, stage 1 proof +13, config 11 (generated). 11 files, ~540 lines.
- **Testing / debugging:** Harder than any stage so far: four moving parts (trigger, pg_net worker, Edge Function, DocuSign) and two of them asynchronous. Failures show up in different places: `net._http_response` (did the request arrive?), the function's terminal output, `bookings.signature_error`. Real sends need a real inbox and leave envelopes in the DocuSign account.
- **Surprising:** that the database itself can be the reliable trigger for an outbound API call (outbox via pg_net), with no queue service, and that the hardest part was configuration, not code.
- **Time spent:** ~75 min
- **Backend needed?** **Yes, a small one:** the Edge Function holds the private key and talks to DocuSign; Postgres can't (and shouldn't) sign JWTs or call DocuSign itself. But no separate server or queue: Postgres + pg_net + one Edge Function.

## Stage 3: receiving the result (webhook + status check)
- **Step:** Advanced 4, stage 3
- **What happened:** Two ways in, one set of rules. `docusign-webhook` is what DocuSign Connect calls (signed, declined, voided); `docusign-sync` is a "Check signature status" button for the host that asks DocuSign directly. Both end in one database function, `docusign_apply_envelope_status`: signed → booking `confirmed`; declined or voided → `cancelled` and the slot is free again. Proof `npm run probe:docusign:proof:receive`: **19/19**, including a **real envelope**: sent, checked ("still waiting", unchanged), voided through the DocuSign API, checked again → booking cancelled, slot free. History shows "Anna signed the agreement: booking … confirmed", "Ben declined …", one line for a series.
- **The webhook is a public door.** DocuSign sends no Supabase key, so `verify_jwt` must be off and *anyone* can POST to the URL. Every message must carry DocuSign's HMAC signature (`X-DocuSign-Signature-1`, HMAC-SHA256 over the **raw** body with the account's Connect key), compared in constant time; `-2`, `-3` headers cover key rotation. Proven: no signature, wrong key, or a body changed after signing (anna → ben) → 401; a genuine signature for another DocuSign account → ignored.
- **Webhooks repeat and arrive out of order.** DocuSign retries until it gets a 200, and events can come late. The rule "only bookings that are still `pending_signature` change" makes every message safe: a retry changes nothing, a late "voided" after "signed" is ignored, and a guest who cancelled before signing stays cancelled. Always 200 for messages we've handled (or deliberately ignored), otherwise DocuSign keeps retrying.
- **Local development can't receive webhooks.** DocuSign needs a public HTTPS URL; local functions are on `localhost` (no tunnel installed). So the webhook is proven with simulated messages signed with a local key (generated by `probe:docusign:setup`), and real envelopes are reconciled with the status check. On a hosted project: set `DOCUSIGN_WEBHOOK_URL` (each envelope then registers it via `eventNotification`) and the real Connect HMAC key from DocuSign admin.
- **Signing can't be automated.** There's no API to sign *as* the guest; the "signed" path with a real envelope needs a person (manual step in TESTING.md). The proof covers it with simulated messages and covers the real round trip with "voided" (which the API can do).
- **Code:** migration 43 lines, webhook 73, status check 65, shared helper +26, host button +29, services +13, History wording +9, proof 165, shared Node DocuSign helper 34 (proof-send now uses it, −21), setup +13, config 22 (generated). 19 files, ~510 lines.
- **Testing / debugging:** The simulated messages make every edge case deterministic (retries, order, forgery, rotation) in seconds. What the simulation can't prove is that DocuSign's real messages look exactly like ours; that needs a hosted project or tunnel once.
- **Surprising:** how little code the "receive" side needs once the state rules live in one database function, and how much of it is about distrust (signature, account, idempotency, ordering).
- **Time spent:** ~60 min
- **Backend needed?** **Yes:** a public endpoint that verifies signatures and a function holding DocuSign credentials. Edge Functions are enough; the rules stay in Postgres.

## Stage 4: when things go wrong (drawbacks shown first, then fixed)
- **Step:** Advanced 4, stage 4
- **Drawbacks, reproduced before any fix.** `npm run probe:docusign:proof:failures` was written first and run against stages 1–3: **11 of 17 checks failed**:

| Drawback (stages 1–3) | Evidence from the first run |
|---|---|
| A send request pg_net couldn't deliver is **lost** | function down → `Couldn't connect`, booking `pending` forever, no agreement ever sent |
| A send that crashed half-way stays **`sending` forever** | nothing picks it up |
| A booking that's **never signed blocks the slot forever** | still waiting after "3 days"; also when the session is about to start |
| **Cancelling doesn't withdraw the agreement** | real envelope: guest cancelled, DocuSign still `sent` (guest could still sign) |
| **Nothing runs on a schedule** | no jobs at all (`cron.job` doesn't exist) |

- **Fixes, built only from Postgres + Supabase pieces** (migration `20261013095757_docusign_reliability.sql`, Edge Function `docusign-void`). Same proof afterwards: **17/17**, incl. the real envelope now `voided` after the guest cancels:
  - **pg_cron** (scheduled jobs inside Postgres): `docusign-retry-sends` every minute re-queues lost or failed sends with backoff (1, 2, 4, 8 min), gives up after 5 attempts, and rescues sends stuck in `sending` for 5 min. `docusign-expire-unsigned` every 5 minutes cancels bookings unsigned after 48 h or whose session starts within the hour (`expired`, slot freed). Proven: the retry job really runs (`cron.job_run_details`: `succeeded`).
  - **Withdraw on cancel:** a trigger queues `docusign-void` (pg_net) when a waiting booking with an agreement is cancelled by the guest, host or expiry, but only when *no* booking of a recurring series still uses it, and not when DocuSign already ended it (declined). The function re-checks before voiding.
  - **Race:** if a booking is cancelled while `docusign-send` is still creating its envelope, the new envelope is voided right away.
- **No job runner: this is the part you build yourself.** (Supabase Queues, `pgmq`, used in feature 5, stores messages with visibility timeouts, but nothing *runs* jobs: retries, backoff, scheduling and workers are still yours to build. This stage didn't use pgmq at all.) A traditional backend would use a queue library (e.g. BullMQ, or NestJS's scheduler) with retries, backoff, dead-letter handling and a dashboard. Here the same took: pg_cron schedules, a retry function with an attempt counter and backoff maths in SQL, a "stuck" detector, pg_net for delivery, Vault for three URLs and a key, and a fourth Edge Function. It works, but none of it was provided, and **observability is SQL queries** (`cron.job_run_details`, `net._http_response`, `bookings.signature_error`).
- **New risk created by the fix:** the retry job sends *any* waiting booking every minute. Proof scripts and manual tests that book with made-up emails now must keep sending switched off until their data is gone (two proof scripts had a gap: they restored the real URL *before* resetting). A guest who books with a typo'd email gets 5 retries to that address.
- **Time-dependent tests:** retry and expiry rules take an age/interval parameter, so the proof can test "3 days later" and "backoff passed" by moving timestamps, without waiting. One unrelated older proof (`recurring/edge-proof`) broke today because its "yesterday at this time" slot collided with the seeded Monday 10:00 slots at 10:0x UTC; pinned to 03:00 UTC.
- **Code:** migration 184 lines (pg_cron, attempt counter, call helper, retry, expiry, void trigger, schedules), `docusign-void` 57, shared helper +15, send race +16, History +4, Dashboard +3, setup +16, proof 182, proof fixes ~25. 15 files, ~500 lines.
- **Testing / debugging:** Writing the proof first made the drawbacks concrete and the fixes measurable. Hardest part: background behaviour (pg_net worker, cron every minute) that affects *other* tests running at the same time.
- **Surprising:** that cancelling a booking had real-world side effects we'd forgotten (a live, signable agreement), and that the reliability layer ended up larger than the feature itself.
- **Time spent:** ~75 min
- **Backend needed?** Edge Functions, yes (since stage 2). A *dedicated* backend isn't strictly needed, but this stage is where it starts to pay off: retries, scheduling, dead letters and monitoring are standard features of a backend job queue and had to be hand-built here.

### DocuSign: the four stages compared

| | 1. Waiting bookings | 2. Send | 3. Receive | 4. When things go wrong |
|---|---|---|---|---|
| Built with | trigger + RLS | trigger → pg_net → Edge Function | webhook + status-check Edge Functions | pg_cron + trigger + Edge Function |
| Supabase alone (browser + DB)? | ✅ | ❌ private key, outbound API | ❌ public signed endpoint | ❌ needs the functions above |
| Hardest part | core rules hard-coded `confirmed` | configuration (Vault, function env, cold starts) | distrust: HMAC, retries, ordering | background jobs interfering with tests |
| Proof | 15 checks | 13 (real sends) | 19 (real envelope voided) | 17 (11 failed before the fix) |
| Time | ~45 min | ~75 min | ~60 min | ~75 min |

**For the blog:** the integration works on Supabase, but only with server code (4 Edge Functions) and a reliability layer assembled from pg_net, pg_cron, Vault and triggers. The things a traditional backend gives you out of the box (a job queue with retries, a scheduler, a place for secrets, logs) are exactly what had to be built here. Local development can't receive webhooks at all. **Total feature time: ~4 h 45 min (incl. ~45 min setup check).**

---

# Advanced feature 3: spam protection (rate limiting anonymous bookings)

Guests book without an account. RLS decides *who* may write, not *how often*, and Supabase's built-in rate limits and CAPTCHA only cover Auth (sign-in, sign-up), not database writes. Decisions: IP addresses only for rate limiting, hashed and deleted after a day; CAPTCHA via Cloudflare Turnstile (official test keys); limits: max 3 active bookings per email per host, max 10 bookings per host per 10 minutes. Separate test host `spam-host@test.dev` with 50 slots (`npm run probe:spam:seed`).

Planned stages: 1. show the problem (flood script), 2. limits in the database (and try to get around them), 3. CAPTCHA (anonymous sign-in with CAPTCHA vs. Edge Function), 4. compare.

## Stage 1: one script can take over a host's calendar
- **Step:** Advanced 3, stage 1
- **What happened:** `npm run probe:spam:flood` acts like an attacker with only what every visitor's browser has (project URL + publishable key), through the same public API as the booking page. All four problems reproduced:
  - **A. Whole calendar:** all **50 slots booked in well under a second** (0.24–0.29 s in 3 local runs) by one script (parallel, fake names and emails); the host's booking page then offers 0 slots.
  - **B. No per-guest limit:** 50 bookings accepted for the **same** email address.
  - **C. No rate limit on writes:** **500 write requests in ~0.5–0.7 s (~700–1,000/s; 3 local runs)**, never a `429 Too Many Requests` (50 × `201`, 450 × `401` "slot taken").
  - **D. The DocuSign multiplier:** on a host that requires signatures, 50 fake bookings queued **50 DocuSign send requests**, i.e. 50 agreement emails from our DocuSign account to addresses the attacker chooses. (Sending was switched off for the test; nothing reached DocuSign.)
- **Why RLS can't help:** every single booking is legitimate on its own (free future slot, valid email). The abuse is in the *amount* and *speed*, which RLS policies don't see: they look at one row, with no memory of earlier requests and no notion of time.
- **What "anonymous" means here:** all guests share the same role (`anon`) and the same publishable key, so the database can't tell one guest from a thousand. The only per-request clues are what the client sends (email: chosen by the attacker) and request headers (IP: tested in stage 2).
- **Local only:** the local stack (Kong + PostgREST) has no rate limiting on API writes. Hosted Supabase may have platform-level protection; not tested here, and not something the app can configure per table.
- **Test infrastructure fix:** counting pg_net requests by "rows in `net._http_response` after minus before" came out **negative** once: pg_net periodically deletes old responses. Now all scripts count responses to request ids newer than the start (rolled-back requests never get a response, so the DocuSign rollback check stays correct). Fixed in `flood.mjs`, `proof-send.mjs`, `proof-failures.mjs`.
- **Code:** seed 46 lines, flood script ~125 lines, 2 npm scripts; counting fix in 2 DocuSign proofs. No app code changed.
- **Testing / debugging:** Easy and fast; the numbers are the finding. The only care needed: round D must never let fake addresses reach DocuSign (sending off, data reset *before* switching it back on, also on crash).
- **Surprising:** that the DocuSign integration turned a nuisance (blocked calendar) into a real cost and reputation risk (our account emailing strangers).
- **Time spent:** ~35 min
- **Backend needed?** Not decided yet: stage 2 tests what the database alone can enforce.

## Stage 2: limits inside the database (and what they can't do)
- **Step:** Advanced 3, stage 2
- **What happened:** A `BEFORE INSERT` trigger on `bookings` counts recent bookings and refuses with **HTTP 429** (`raise … using errcode = 'PT429'` makes PostgREST answer 429): max **3 active bookings per email per host**, **10 new bookings per host per 10 minutes**, **30 per IP per 10 minutes**; a recurring series counts once. Limits live in a one-row `rate_limit_settings` table (tunable by the owner, used by the tests). IPs are stored only as salted hashes (salt in Vault), deleted after a day (pg_cron). Proof `npm run probe:spam:proof:limits`: **15/15**. The stage 1 attacks are now stopped: **A** 10 of 50 slots taken (40 stay free), **B** 3 bookings per email, **C** 10 of 500 burst writes accepted, **D** 10 DocuSign sends instead of 50.
- **Race condition found by the first run.** Under 50 parallel requests the per-host limit of 10 let **14** through (burst: 15). Count-then-insert is a classic race: concurrent transactions don't see each other's uncommitted rows, so they all count "fewer than 10". Fixed with **advisory locks** (`pg_advisory_xact_lock`) per host and per IP hash: bookings for the same host now wait for each other while checking. Cost: *all* bookings for one host are serialized (the same 50-request attack took 0.35–1.3 s across 5 local runs with the locks vs. 0.24–0.29 s without; too noisy to put a number on the slowdown) (an older race test now waits at week 1 instead of week 3; the outcome is the same). A backend would typically use an atomic counter (Redis `INCR`) instead. Saved: `evidence/…spam-stage2-BEFORE-advisory-lock…`.
- **Which IP?** PostgREST exposes the HTTP headers in `request.headers`. `X-Forwarded-For` can be **prepended** by the client (sent `6.6.6.6`, accepted as first entry); the proxy **appends** the real address. So only the **last** entry is trustworthy (locally added by Kong); `CF-Connecting-IP` is passed through unchecked locally. Proven: rotating fake `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` headers doesn't get around the IP limit. On hosted Supabase the proxy chain differs; must be verified there.
- **What database limits can't do (all demonstrated):**
  - **Shared IPs:** all local traffic has the same IP (Docker host); once a bot hits the IP limit, a **real guest on the same network is blocked too** (offices, mobile networks, VPNs).
  - **Host lock-out:** after 10 bot bookings, **real guests can't book that host for 10 minutes**. The limit protects the calendar from being emptied, but the attacker can still deny service, and the 10 bot bookings stay.
  - **Email variations:** `same-guest+abc@…` counts as a new person; the per-email limit is only a speed bump.
  - **No HTTP request, no IP:** bookings over a direct connection (Studio, the `book-recurring` Edge Function) have no `request.headers`, so the IP limit never applies; an Edge Function would have to forward the client IP itself.
  - **Nothing tells a human from a bot** at the moment of booking: that's stage 3 (CAPTCHA).
- **Side effect on tests:** every proof script and the RLS suite now runs under the limits; all still pass (the spam seed resets counters and limits). Local test traffic shares one IP, so suites that book a lot quickly could hit the IP limit; the default (30/10 min) leaves room.
- **Code:** migration 143 lines (settings table, events table, IP helper, trigger with advisory locks, cleanup job), proof 150, seed +10, flood skip +9, one older proof adjusted. ~320 lines. No app code changed: the booking page shows the database's message ("Too many bookings…").
- **Testing / debugging:** The race only showed up under parallel load; sequential tests would have passed. Tunable limits made every edge case testable in seconds.
- **Surprising:** how much a simple "max 10" needs: atomicity (locks), identity (whose IP, which header), privacy (hashing, retention) and side effects on everything else.
- **Time spent:** ~60 min
- **Backend needed?** Not for basic limits: the database enforces them for every path that goes through the API. But the weaknesses above (shared IPs, lock-out, bots that behave) need either a human check (CAPTCHA, stage 3) or edge infrastructure (WAF, bot detection) that sits in front of any backend.

## Stage 3: CAPTCHA (Cloudflare Turnstile) through an Edge Function
- **Step:** Advanced 3, stage 3
- **What happened:** Hosts can switch on **"Require a CAPTCHA"** (Dashboard, `profiles.require_captcha`). The booking page then shows a Turnstile check and books through the new Edge Function `book-slot`, which verifies the token with Cloudflare, then books over a direct connection as the guest's role, with the guest's IP forwarded and the transaction marked as CAPTCHA-verified. A `BEFORE INSERT` trigger refuses unmarked bookings from API roles for those hosts with **HTTP 403** (`PT403`). `book-recurring` accepts a token too (identity, IP, CAPTCHA and transaction setup now shared in `supabase/functions/_shared/caller.ts`). Tested with Cloudflare's official test keys (`npm run probe:spam:setup`). Proof `npm run probe:spam:proof:captcha`: **15/15**.
- **No way around it (proven):** direct API booking → 403; as a freshly signed-up user → 403; headers trying to set the mark → 403 (PostgREST doesn't let clients set arbitrary settings); recurring rpc → 403 with the series rolled back; the stage 1 flood → **0 of 50** booked, and **no rate-limit quota used** (the CAPTCHA check runs before the limits, so bots can't lock humans out that way anymore).
- **Humans get through:** without a token → 403 `captcha_failed`; with one → 201. Stage 2 limits still apply through the function, **including the IP limit**: the function forwards the client IP (last `X-Forwarded-For` entry) into `request.headers`, which closes stage 2's "Edge Functions have no IP" weakness. Hosts who don't opt in: unchanged.
- **A CAPTCHA is only as good as the paths it guards.** The work wasn't the widget or the verification call (a few lines each), but closing every *other* way in: the REST insert, the recurring rpc, logged-in users (anyone can sign up), and keeping the Edge Functions as the only paths that can set the mark. There's no declarative "only this function may write to this table" rule for API roles (the usual Postgres answer, a `SECURITY DEFINER` function plus revoking the table rights, would switch RLS off inside the function); it took a trigger plus a transaction-local setting.
- **Supabase's own CAPTCHA wasn't usable here:** Supabase's CAPTCHA (Turnstile/hCaptcha) is an **Auth setting** (`[auth.captcha]` in `config.toml`: on/off, provider, secret; no per-endpoint or database option). It protects Auth requests, not database writes; guests don't use Auth, so it can't protect a booking insert directly. (Exactly which Auth requests require the token: to verify in Supabase's docs before publishing.) Stage 3b tries the native route (anonymous sign-in with CAPTCHA) and documents what it changes.
- **What local testing can't prove:** with the test secret, any non-empty token passes (made-up tokens included), and test tokens never expire or get "used up". Bot detection and single-use tokens need real keys (Cloudflare dashboard → Turnstile → site key + secret), and the site key's allowed domains.
- **Core pages:** the booking page now books through `bookSlot()` in `src/services/` (directly for normal hosts, via `book-slot` with the token for CAPTCHA hosts), the first booking path that follows the branch's "pages call services" rule; the rest of `BookView.vue` still calls supabase directly.
- **Test friction:** after editing an Edge Function, the local function server reloads; the first call can hang for a while (one proof run timed out at 60 s, the next call took 0.5 s). Same pattern as earlier "temporary outages".
- **Code:** migration 45 lines, shared caller helper 73, `book-slot` 47, `book-recurring` −55/+22 (moved into the helper), widget 60, host setting 47, services +29, core pages ~20 changed lines, setup 24, proof 99. 19 files, ~500 lines.
- **Testing / debugging:** Good with test keys: deterministic pass/fail tokens and no account needed. The real risk (bots solving or farming CAPTCHAs) can't be tested locally.
- **Surprising:** that the IP forwarding needed for the CAPTCHA function fixed a weakness from stage 2 for free, and that "guests have no account" again shaped everything (no Supabase Auth CAPTCHA, no per-user limits).
- **Time spent:** ~75 min
- **Backend needed?** **Yes, a small one:** verifying a CAPTCHA needs a secret and a server-side call, so an Edge Function. Everything else (blocking the bypass, limits) stays in Postgres.

## Stage 3b (skipped): Supabase's own CAPTCHA via anonymous sign-in
- **Decision:** not built; recorded as reasoning, not measured. Supabase's CAPTCHA is an Auth setting (`[auth.captcha]` in `config.toml`: on/off, provider, secret, with no per-endpoint option in the local config), so it guards Auth requests, not database writes (exact list of Auth requests: to verify before publishing). Guests don't use Auth, so it can't guard a booking directly. The workaround would be **anonymous sign-ins with a CAPTCHA**; from the schema it's clear this would also mean: host login and sign-up (and every test script) need a CAPTCHA token too; anonymous users get the `authenticated` role, so every RLS policy that means "a host" would have to exclude `is_anonymous` users (otherwise an anonymous guest could, e.g., create slots); the `handle_new_user` sign-up trigger would create a host profile for every guest. Supabase does rate-limit anonymous sign-ins (`anonymous_users = 30` per hour in the local `config.toml`). Trying it needs `supabase stop/start` twice and breaks local login while on.

## Stage 4: all layers compared
- **Step:** Advanced 3, stage 4
- **What happened:** `npm run probe:spam:compare` runs the same attacks against three levels on the spam host (limits set so high they never trigger = "none"; stage 2 limits; limits + CAPTCHA) and measures what a real guest experiences afterwards. 8/8 expected-pattern checks pass:

| Attack (bot, straight to the API) | None | Limits | Limits + CAPTCHA |
|---|---|---|---|
| Calendar takeover (50 parallel bookings) | 50/50 | 10/50 | **0/50** |
| Real guest right after the takeover | nothing left ❌ | blocked, 429 ❌ (host lock-out) | **can book ✅** |
| One email, 10 bookings | 10 | 3 | 0 |
| Email variations (name+xyz@), 10 | 10 | 10 (per-email limit fooled, host limit caps) | 0 |
| Fake IP headers, 40 (host limit lifted) | 40 | 30 (IP limit holds) | 0 |
| Bot signs up first, then 20 | 20 | 10 | 0 |
| Recurring rpc (skipping the page) | booked | booked | refused (403) |
| DocuSign emails from 50 bot bookings | 50 | 10 | 0 |
| Normal booking, average time (4 local runs) | ~15–25 ms | ~15–35 ms (no meaningful difference: noise) | **~70–100 ms** (Cloudflare check + Edge Function) |

- **Reading the table:** limits alone **reduce** the damage (50 → 10) but then **turn on the real guests**: after a takeover attempt, the host is locked for 10 minutes. Only the CAPTCHA stops bots without hurting humans, at the cost of roughly 50–80 ms more per booking (4 local runs), a visible widget, an Edge Function, and a dependency on Cloudflare. Takeover times in the first row varied too much between runs to compare (single runs; e.g. the "none" column 0.35–0.8 s).
- **Code:** comparison script ~170 lines, 1 npm script. No app code changed.
- **Time spent:** ~25 min (+ restarting `functions:serve`, which had stopped)
- **Backend needed?** See the feature summary below.

### Spam protection: the stages compared

| | 1. Show the problem | 2. Limits in the database | 3. CAPTCHA via Edge Function | 4. Compare |
|---|---|---|---|---|
| Built with | flood script | trigger + advisory locks + pg_cron (cleanup) + Vault (salt) | Edge Function + trigger + Turnstile widget | comparison script |
| Supabase alone (browser + DB)? | n/a | ✅ | ❌ CAPTCHA verification needs a secret + server call | n/a |
| Stops the takeover | ❌ (50/50) | partly (10/50) | ✅ (0/50) | |
| Hurts real guests | — | yes (host lock-out, shared IPs) | no (one extra click) | |
| Hardest part | — | race condition (count-then-insert), which IP to trust | closing every other way in | |
| Proof | 4 problems reproduced | 15 checks (14 of max 10 before the lock fix) | 15 checks | 8 checks |
| Time | ~35 min | ~60 min | ~75 min | ~25 min |

**For the blog:** RLS answers *who* may write, not *how often*, and anonymous guests are indistinguishable. Postgres can enforce limits for every path through the API (with care: atomicity, trusting the right IP header, privacy), but limits alone let an attacker lock out real guests. Telling humans from bots needs a CAPTCHA, which needs a secret and a server-side check (an Edge Function), and most of the work is closing every other way in. Supabase's built-in CAPTCHA is an Auth setting, not a guard for table writes, so it didn't fit anonymous guests (exactly which Auth requests it covers: to verify before publishing). **Total feature time: ~3 h 15 min.**

---

# Advanced feature 5: bulk reminders

A day before each session, the guest gets a reminder email (session time, host, cancel link). Decisions: emails go to the **local Mailpit** inbox only (http://127.0.0.1:54324, no real provider); **guests only**; **24 hours before** the session. Supabase only sends its own Auth emails, so app emails need server code (core friction: "no notification emails"). Separate test host `reminder-host@test.dev` with 200 bookings in ~24 h (`npm run probe:reminders:seed`).

Planned stages: 1. show the problem (naive scheduled loop), 2. Supabase Queues (`pgmq`), 3. opt-out + provider rate limits, 4. compare.

## Stage 1: the naive scheduled loop loses and duplicates emails
- **Step:** Advanced 5, stage 1
- **What happened:** The design most tutorials show: a pg_cron job (`send-reminders`, hourly, **created switched off**) calls `public.run_reminders()`, which calls the Edge Function `send-reminders` via pg_net; the function finds bookings starting in 23–25 h without `reminder_sent_at`, sends one email each in a loop (Mailpit HTTP API), and marks them all at the end. `npm run probe:reminders:naive` (all problems reproduced):
  - **A. Quiet day:** 200 reminders in under a second (0.3–0.9 s across 7 local runs), all marked. It works, which is why the design is popular.
  - **B. Crash halfway + the next run:** crash after 120 emails → 120 delivered, **0 marked**; the retry sends to everyone unmarked → **120 guests reminded twice**. Nothing recorded which 120 were already sent.
  - **C. Slow provider (200 ms per email, 40 s total):** the scheduler's request (pg_net, 30 s timeout) gives up after ~140 emails. Two outcomes seen locally: usually the function **keeps going and finishes unseen** (the database only recorded "Timeout"); once, under load, the Edge runtime **terminated it half-way** (HTTP 546; runtime log: "CPU time soft limit reached", "early termination has been triggered") after 34 emails, 0 marked, so the next run would resend those 34.
  - **D. Two runs overlap:** both find the same 200 unmarked bookings → **all 200 guests reminded twice**.
  - **E. One long call (3 s per email, `--with-time-limit`):** the caller got **HTTP 504 after 150 s** (49 sent, 0 marked), but that was only the **gateway** giving up: the function **kept running in the background**, sending a reminder every 3 s to guests for minutes afterwards ("wall clock duration warning" in the runtime log), including into the next test run. The only local way to stop it was **restarting `functions:serve`**.
- **What this shows:** a loop in one function call has **no memory of its own progress**. Every way it can end early (crash, caller timeout, runtime termination, gateway timeout) leaves "sent but not recorded", and every retry or overlap turns that into duplicates. Marking each email right after sending would shrink the window but not close it (crash between send and mark), and wouldn't stop overlapping runs.
- **Edge Function limits are real and three-fold:** the caller's timeout (pg_net 30 s here), the gateway's (150 s locally), and the runtime's own CPU/wall-clock limits. They don't stop the function together: the caller can give up while the function continues, or the function can be killed while the caller waits. Hosted limits are documented by Supabase (run time and CPU time per invocation); measured here only locally.
- **Mailpit as the test inbox:** reachable from the Edge Functions inside Docker (`http://inbucket:8025`), with an HTTP API to send and to count emails per recipient; test emails use one domain (`reminder-test.example`) so only they are deleted afterwards. No account, no real mail.
- **Seeding hit feature 3:** inserting 200 bookings for one host as the database owner tripped the spam-protection limit (max 10 per host per 10 min applies to every insert). The seed lifts the limits inside its own transaction and restores them before commit.
- **Code:** migration 63 lines (`reminder_sent_at`, `invoke_edge_function`, `run_reminders`, cron job off), naive function 75, seed 63, setup 22, demonstration ~150, 3 npm scripts.
- **Testing / debugging:** Reproducing was easy with test switches (`crashAfter`, `delayMs`) and Mailpit's API. Debugging the runaway run was not: the only evidence was emails arriving with nobody calling, and the runtime log in `docker logs supabase_edge_runtime_…`.
- **Surprising:** that an HTTP 504 didn't stop anything, and that a "finished" scheduled job (pg_cron only queues the request) says nothing about whether any email went out.
- **Time spent:** ~70 min (incl. the time-limit run and the runaway function)
- **Backend needed?** Not decided yet: stage 2 tests Supabase's own queue (`pgmq`) as the fix.

## Stage 2: Supabase Queues (pgmq) make reminders reliable
- **Step:** Advanced 5, stage 2
- **What happened:** Two steps connected by a queue (migration `20261013224858_reminders_queue.sql`, Edge Function `process-reminders`). `enqueue_reminders()` (hourly) puts one pgmq message per due reminder and marks the booking `reminder_queued_at` in the same transaction. The worker reads small batches (pgmq hides them from other workers for `vt` seconds), skips cancelled/past/already-reminded bookings, sends, then **marks + deletes the message in one transaction**; failed messages reappear and are retried; after 5 reads they go to the archive (dead letter); the worker stops itself after a time budget and hands unprocessed messages back. Both jobs are created **switched off**. Proof `npm run probe:reminders:proof:queue`: **11/11**, the stage 1 scenarios again:

| Scenario | Stage 1 (naive loop) | Stage 2 (queue) |
|---|---|---|
| Quiet day | 200 emails | 200 emails |
| Crash after 120, then the next run | **120 guests twice** | **0 twice** (the 120 were recorded one by one) |
| Crash between sending and recording | (same as above) | **1** twice: only the email in flight |
| Slow provider via the scheduler | caller timeout, result unknown or cut off | runs of ≤ 20 s, each answers; 200 guests, 0 twice |
| Two runs at once | **200 guests twice** | 0 twice (each message goes to one worker) |
| One long call | 504, then sends in the background for minutes | returns on its budget; nothing sent after it returned |
| Overlapping enqueue runs | n/a | each reminder queued once |
| Booking cancelled after queuing | n/a | skipped, no reminder |
| One address always fails | would fail the whole run | 199 sent, 1 dead letter in `pgmq.a_reminders` |

- **The runtime cuts workers off anyway.** Locally the Edge runtime sometimes **terminated a worker on its own** (HTTP 546; log "CPU time soft limit reached" / "early termination") after ~90–130 emails in one call, even though the code would have stopped at its budget. With the queue that's harmless: unfinished messages come back and the next run continues. The proof accepts it and reports it. In the naive design the same termination meant lost or duplicate emails.
- **At-least-once, not exactly-once.** A crash or termination *between* sending and recording repeats that one email. A queue can't close that gap alone: exactly-once needs the email provider's idempotency key (e.g. a per-booking key the provider deduplicates on). The window shrinks from "the whole run" (stage 1: 120 twice) to "one email".
- **pgmq is "just Postgres":** the queue is a table, so enqueuing + marking the booking is one transaction, and the archive is queryable in Studio (`select * from pgmq.a_reminders`). Compared with DocuSign stage 4, where retries, backoff, attempt counting and stuck detection were hand-built, pgmq gives visibility timeout, read counts and archiving for free. Still hand-built: the worker loop, the time budget, the dead-letter rule and the scheduler wiring.
- **Gotchas:** `pgmq.send` returns a set, so it can't go inside `count(...)` (use `from …, lateral pgmq.send(…)`). pgmq functions are overloaded (`delete(queue, id)` vs `delete(queue, ids[])`), so calls from the Edge Function with untyped parameters fail ("function is not unique") until every argument is cast.
- **Test friction:** timing-dependent behaviour. The worst-case and slow-provider checks failed once each before they were written to accept the runtime's own terminations (546) next to the planned crash. Running a scenario three times in a row showed the 546 in one of three.
- **Code:** migration 70 lines (pgmq, queue, `reminder_queued_at`, enqueue, scheduler wrapper, 2 jobs off), worker 125, seed +10 (purge queue), setup +3, proof ~170, 1 npm script.
- **Testing / debugging:** Good: the queue state is plain SQL (`pgmq.metrics`, `pgmq.q_reminders`, `pgmq.a_reminders`), Mailpit counts per guest. Hardest: deciding what a "pass" is when the runtime may stop a worker at any time.
- **Surprising:** that the local Edge runtime terminates fairly modest workloads (~100 emails with short waits), so any design that assumes one call finishes its loop is fragile.
- **Time spent:** ~80 min
- **Backend needed?** Not for a reliable queue: pgmq + pg_cron + one Edge Function is enough. A backend's job-queue library would add an exactly-once helper only if the provider supports idempotency keys, and better observability (dashboard, alerts) out of the box.

## Stage 3: opt-out without an account + the email provider's sending limit
- **Step:** Advanced 5, stage 3
- **What happened:** (migration `20261014060631_reminders_optout_limits.sql`, Edge Functions `reminders-unsubscribe` and `test-mail-provider`, worker updated, page `/reminders/unsubscribe/:token`.) Proof `npm run probe:reminders:proof:optout`: **15/15**.
- **Opt-out without an account:** every reminder links to `/reminders/unsubscribe/<cancel token>`. The cancel token is the guest's existing secret (whoever has the email can already cancel the booking), so it can also stop reminders for that address; no new secret, no account. Opt-outs are stored as a **hash** of the lower-cased address and checked twice: when queuing (proven: 199 queued after one opt-out) and **just before sending** (proven: a guest who opts out after queuing gets nothing). Unknown tokens change nothing and get the same answer as real ones.
- **Mail apps' "Unsubscribe" button needs a public endpoint.** Gmail / Apple Mail use the `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058) and **POST** directly to the URL, with no Supabase key and no JavaScript. The REST API needs an `apikey` header, so this needed one more small public Edge Function (`verify_jwt = false`). A GET (a person or a link scanner opening the URL) only redirects to the page, which asks before unsubscribing.
- **The provider's sending limit, problem first.** Mailpit has no limit, so a test double (`test-mail-provider`) behaves like a real provider: max N per second (database counter under an advisory lock, so it holds across parallel callers), **429 + Retry-After** above that. With the stage 2 worker (no pacing, two workers, 429 treated as a failure) and a 20/s limit: **~180–200 refusals and 22–30 perfectly fine reminders dead-lettered** (170–178 of 200 guests reminded): a guest silently gets nothing because the provider was busy.
- **The fix:** the worker sends at a **steady pace** (10/s), holds a **lease so only one worker sends at a time** (it expires by itself, budget + 5 s, so a killed worker can't block others for long), and on a 429 **puts the message back with a delay as a fresh message** and ends its run. Proven: 200/200 reminded, **0 refusals, 0 dead letters**; with the provider lowering its limit to 5/s mid-way: 39 refusals, all put back, 200/200 reminded, 0 dead letters; a lease left by a "killed" worker blocks for 3 s, then the next worker takes over.
- **pgmq counts reads, not failures.** The first fixed version still dead-lettered **16 healthy reminders** under throttling: the worker reads 20 at a time and hands unprocessed ones back when it stops early, and each read increments `read_ct`; after a few early stops, untouched messages passed `maxReads`. Handing them back as fresh messages (delete + send in one transaction) resets the count, so `read_ct` only grows on real failures or crashes. Easy to miss, and it turns "retry later" into "silently dropped".
- **New defaults ripple into older tests.** With pacing (10/s) and the lease as the worker's defaults, the stage 2 proof got slow (> 10 min) and its scenarios changed meaning (one run can't send 195 any more; longer runs were stopped by the runtime more often, 546, plus one 503 from the gateway). The stage 2 proof now runs the worker with stage 2's settings (no pacing, no lease) and allows **at most one duplicate per runtime stop**, which is the guarantee the queue actually gives.
- **Code:** migration ~150 lines (opt-out table + functions, enqueue update, worker lease, test-provider tables), worker rewritten (~185 lines), one-click endpoint 30, test provider 45, page 45, service +8, route 1, seed +12, proof ~170, 1 npm script.
- **Testing / debugging:** The test provider made limits deterministic and visible (`test_mail_provider_log`: accepted / refused). The `read_ct` problem only showed under repeated early stops; a single run looked fine.
- **Surprising:** that "unsubscribe" pulled in an email standard with its own HTTP rules (POST, no auth), and that a queue's retry counter can silently drop healthy work.
- **Time spent:** ~85 min
- **Backend needed?** No new kind: one more tiny public Edge Function (one-click unsubscribe). Pacing, the single-worker lease and throttling are hand-built on Postgres; a backend job-queue library usually ships rate limiting ("limiter") and concurrency control as options.

## Stage 4: the three versions compared
- **Step:** Advanced 5, stage 4
- **What happened:** `npm run probe:reminders:compare` runs the same scenarios against the naive loop (stage 1), the queue with stage 2 settings, and the queue with limits (stage 3). After each first run, "the scheduler's next run" happens as in practice (naive: one more run; queues: workers until empty). 6/6 expected-pattern checks pass:

| Scenario | Naive loop (stage 1) | Queue (stage 2) | Queue + limits (stage 3) |
|---|---|---|---|
| Quiet day: time until all 200 sent | ~1 s (0.3–1.3 s, 8 runs) | ~5 s (2 runs) | ~30 s (by design: paced at 10/s) |
| Crash after 120, then the next run | **120 guests twice** | 0 twice | 0 twice |
| Two runs at the same time | **200 guests twice** | 0 twice | 0 twice |
| Provider limit 20/s, two runs at once | **14/200 reminded**, 6 twice | **170/200**, 30 dead letters | **200/200** |
| Guest opted out after queuing | reminded anyway | not reminded | not reminded |
| Booking cancelled before sending | not reminded | not reminded | not reminded |

- **Reading the table:** the naive loop is the fastest on a quiet day and wrong on every bad day. The queue fixes duplicates and lost work from crashes and overlaps; the limits fix what an external provider does to you (throttling), at the price of speed: 200 reminders take ~30 s instead of ~1 s, which is fine for a nightly job but shows that "polite" sending is slow by design. (The naive loop "respects" cancellations only because it queries at send time; the opt-out check exists only in the worker.)
- **Code:** naive function +8 lines (optional test provider, for this comparison), comparison script ~180 lines, 1 npm script.
- **Time spent:** ~30 min
- **Backend needed?** See the feature summary below.

### Bulk reminders: the stages compared

| | 1. Naive loop | 2. Supabase Queues | 3. Opt-out + sending limits | 4. Compare |
|---|---|---|---|---|
| Built with | pg_cron + pg_net + one Edge Function | pgmq + pg_cron + Edge Function worker | + lease table, pacing, 429 handling, opt-out table, 2 small Edge Functions (one-click unsubscribe, test provider) | comparison script |
| Supabase alone (browser + DB)? | ❌ sending email needs server code | ❌ | ❌ | n/a |
| Duplicates after a crash / overlap | 120 / 200 | 0 (at most 1 per runtime stop) | 0 | |
| Survives provider throttling | ❌ | ❌ (healthy reminders dead-lettered) | ✅ | |
| Hardest part | three different limits ending the loop (caller, gateway, runtime); a runaway function | runtime terminating workers (546); pgmq overloads | pgmq counts reads, not failures; new defaults breaking older tests | |
| Proof | 4 problems (+ time limit) | 11 checks | 15 checks | 6 checks |
| Time | ~70 min | ~80 min | ~85 min | ~30 min |

**For the blog:** Supabase can run a reliable bulk-email job without a separate server: pg_cron schedules, pgmq queues (visibility timeout, read counts, archive), Edge Functions send. But it's assembled by hand: the worker loop, time budget, lease, pacing, throttling and the dead-letter rule are all ours, and the Edge runtime's limits (caller timeout, gateway 504, CPU/wall-clock termination) shape the design. A backend job-queue library (e.g. BullMQ) ships most of this as configuration (concurrency, rate limiter, retries with backoff, dashboard). Exactly-once delivery needs the email provider's idempotency key either way. **Total feature time: ~4 h 25 min.**

---

# Advanced feature 6: weekly availability & time zones (skipped)

**Decision (2026-10-14): not built.** The feature (hosts set "Mon–Fri 09:00–17:00, 30-min slots, Europe/Berlin" once and slots are created automatically; times shown in each person's time zone) would mostly show where Supabase is **enough**, not where it falls short, so it wouldn't add much to the blog's question. What planning it found:

- **Postgres handles time zones well.** It ships the full IANA time-zone database: `('2026-10-26 09:00' at time zone 'Europe/Berlin')` gives the right UTC instant on either side of a daylight-saving change, including the hour that doesn't exist (spring) and the one that happens twice (autumn). Generating a host's slots from weekly rules would be a few lines of SQL (`generate_series` + `at time zone`) plus a nightly job. No backend needed.
- **One real Supabase limitation (verified locally): scheduled jobs run in UTC.** In the local image (pg_cron 1.6.4), `cron.timezone` is `GMT` (the default), it's a server-start setting (`postmaster`: only changeable in the server configuration plus a restart), and the project's `postgres` role has no privilege to set it. Whether a hosted project can change it (e.g. through Supabase support or a platform setting): to verify before publishing. A job meant to run "every day at 06:00 Berlin time" fires at 06:00 UTC, i.e. 07:00 or 08:00 in Berlin depending on the season. Workaround: schedule hourly and let the job decide whether it's the right local hour, or keep jobs time-zone-independent (e.g. "create slots for the next 8 weeks", safe to run at any time).
- **The server doesn't know an anonymous guest's time zone.** Guests have no account, so emails can only show the guest's local time if the browser sends its zone with the booking (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Same root cause as in features 3 and 5: anonymous guests carry no profile.
- **Two small bugs in our own code, noted, not fixed:**
  - **Recurring bookings drift by an hour across a clock change.** Feature 1 repeats a booking every 168 hours in UTC (`book_recurring`, `split.js`, `book-recurring`). The test host's Mondays (10:00 UTC) are 12:00 Berlin time on 19 Oct but 11:00 on 26 Oct (summer time ends 25 Oct 2026). Fix: store the series as "weekday + local time + host time zone" and compute each week with `at time zone`. Not a Supabase issue.
  - **Emails show UTC times.** Reminders (feature 5) and DocuSign agreements (feature 4) format times in UTC because the guest's zone isn't stored. Fix: store the guest's browser time zone with the booking and format with it.
- **Time spent:** ~30 min (planning, checking `cron.timezone`, this entry)
- **Backend needed?** **No.** Postgres covers the hard part; the only Supabase-specific gap is UTC-only scheduling, which has simple workarounds.

---

# Security review (after all features)

Requested in review: run Supabase's own checks, scan everything the public key and a normal login can reach, and test SQL injection. Folder `src/probes/security/`, migrations `20261014212615_security_fixes.sql` (fixes) and `20261014212943_security_sqli_probe.sql` (SQL-injection probe).

## Step 1: Supabase's Security Advisor and database linter

`npm run probe:security:advisors` runs `supabase db advisors --local --type all` (the Security / Performance Advisor's checks, "splinter") and `supabase db lint` (plpgsql_check). **No errors; 11 advisor findings, 1 linter warning.** Every one reviewed:

| Finding | Level | Verdict |
|---|---|---|
| `rls_policy_always_true`: `booking_series` "Anyone can create a booking series" (`with check (true)`) | WARN | **Real, fixed (step 2).** The insert has to stay open (all three recurring-booking stages insert the series as the guest), but it was **uncounted**, and it was the door for a bypass of the spam limits. |
| `rls_policy_always_true`: `audit_log_client` "Anyone can write client audit entries" | WARN | **Intended, probe only.** This is audit-log stage 1's table, deliberately forgeable to *show* the problem. Nothing reads it except the probe. Must be dropped before any real deployment. |
| `rls_enabled_no_policy` × 6 (rate-limit tables, reminder opt-outs and lease, test mail provider) (+1 later: `sqli_probe_switch`) | INFO | **Intended.** RLS on + no policy + no grants = closed to the API; only `SECURITY DEFINER` functions and triggers use them. The scan confirms anon and logged-in users can't read or write them. |
| `extension_in_public`: pg_net | WARN | **Cosmetic, not changed.** Our migration said `create extension pg_net` without a schema, so the *extension record* sits in `public`, but pg_net puts all 27 of its objects in its own `net` schema (checked in `pg_depend`); nothing is added to `public`. Moving it means drop + create (pg_net can't be relocated), which would lose queued requests. On hosted, enabling it from the dashboard avoids the warning. |
| `multiple_permissive_policies`: `slots` select | WARN (performance) | Intended (guests see free slots, hosts see their own); a small cost per query. |
| `unused_index`: `test_mail_provider_log_at_idx` | INFO (performance) | Test double; irrelevant. |
| Linter: `book_recurring`, `v_weeks jsonb := '[]'` "text to jsonb" | warning | Harmless (the literal is cast once). Not changed. |

**Surprise: neither tool notices the two serious problems this review found.** The advisor's `with check (true)` warning *pointed at* the right table but couldn't know that weeks of a series skip the limits. And the SQL-injection function from step 3 gets **no advisor finding at all**; the linter's only remarks on it ("OUT variable maybe unmodified") are word for word the same for the safe version. The advisors check configuration (RLS on? policy too wide? search_path set?), not what your functions do.

- **Time spent:** ~30 min

## Step 2: exposure scan (everything the public key and a normal login can reach)

`npm run probe:security:scan` (`exposure-scan.mjs`, 115 checks). Two fresh hosts: B owns the data, A is a stranger; plus a visitor with only the public key. Then:
- **Every table** in `public`: read, insert, update, delete on B's (or internal) rows, as anon and as A. Updates and deletes are judged **in the database** (did the row change?), because a blocked update through the API answers "success, 0 rows".
- **Every function** in `public`, called through `rpc()` as anon and as A.
- **Every Edge Function** (all 10 have Supabase's JWT check off, so each checks callers itself), Storage (avatars), the GraphQL endpoint.
- Each result is compared with an **expected map**. A table or function the scan doesn't know fails as "not reviewed", so anything added later must be looked at.

**Result before the fixes:** everything matched (no data readable or changeable across hosts; internal functions all blocked; the 5 internal Edge Functions answer 401 without the secret key; storage folders private; GraphQL not installed) **except two abuse checks:**
1. **Unlimited empty series:** one visitor created 30 series for a host in a row, all accepted; each became a line in the host's history page (spam in the host's own audit view).
2. **A bypass of the spam limits (feature 3):** weeks 2+ of a series skipped the limits ("the series was counted with its first week"), but **nothing tied a booking to its series**: not the host, not the weekday, not the time. With 4 made-up series a visitor booked **40 of a host's slots; the limit is 10**. Feature 3's own proofs never tried this, because they tested the paths the app uses, not every combination of columns the grants allow.

**Fix** (`20261014212615_security_fixes.sql`, ~145 lines): the three limits moved into one function used by two triggers. A **series is counted once, when it's created**, and a booking that claims to be week N of a series must match it (same host, weekday, time, guest email, week ≤ length); bookings of a series aren't counted again. After: 30 series → only the remaining quota accepted, 40 → 0. Re-ran `test:rls` (60/60) and the recurring, audit (3), spam (2) and DocuSign pending proofs: all pass.

- **What this says about Supabase:** with the database exposed to the browser, **every column a role may insert is part of the public API**, including combinations no screen in the app produces (`series_id` + `week_no` on any slot). The app's own code paths were safe; the hole was in what the grants *allow*. A backend that only exposes `POST /bookings/recurring` never accepts a hand-built `series_id`.
- **Positive:** the scan itself was easy to write (supabase-js + psql), and judging "blocked" in the database rather than by the API's answer avoids RLS's silent "0 rows" trap.
- **Not covered:** Realtime subscriptions (core design: broadcasts carry no guest data), Auth endpoints' own rate limits, hosted-only behaviour.
- **Time spent:** ~1 h 45 min (inventory of grants/policies/functions, the scan, finding and fixing the bypass, regression runs)

## Step 3: SQL injection

`npm run probe:security:sqli` (`sqli-proof.mjs`, 24 checks; the INVOKER contrast in migration `20261015101503_security_sqli_invoker.sql`).
- **supabase-js filters are parameterised:** `.eq('guest_email', "x' or '1'='1")` returns 0 rows, and a guest literally named `' or '1'='1` is found exactly once. supabase-js builds URL parameters, PostgREST sends values to Postgres as bound parameters, so a quote is just a character.
- **A related trap that isn't SQL:** gluing user input into a PostgREST filter *string* (`.or(\`guest_email.eq.${input}\`)`) lets input like `x,guest_email.neq.x` add its own condition. Proven: the "search" returned all of the attacker's bookings, but **RLS still kept it to their own rows**.
- **Where injection really happens: your own Postgres functions.** `sqli_search_bookings_unsafe` (a host searches their bookings) builds the query by concatenation and runs it with `EXECUTE`. **It is `SECURITY DEFINER`**: it runs as its owner, `postgres` (owns the tables, `BYPASSRLS`), as helper functions that need to read across tables often are. Through `rpc()`, a normal logged-in host sent:
  - `zzz%' or true --` → **every host's bookings** (214 rows of other hosts' guests in the local data);
  - `… union all select … from auth.users --` → **every account's email address**;
  - `… union all select … from vault.decrypted_secrets --` → **the project's Vault secrets** (the script counts them, doesn't print them).
- **Contrast: the identical function as `SECURITY INVOKER`** (`sqli_search_bookings_unsafe_invoker`, runs as the caller, `authenticated`). The injection **still works** (the input still becomes SQL), but it can only do what the caller's role may do:
  - `zzz%' or true --` → **2 rows: only the attacker's own bookings**; RLS filtered out every other host's;
  - `… from auth.users --` → refused (`permission denied for table users`);
  - `… from vault.decrypted_secrets --` → refused (`permission denied for schema vault`);
  - **but** `… net.http_get('http://…') --` → **the database server sent an HTTP request** for the attacker (response 200 from a harmless local endpoint). The `net` schema isn't in the API, yet Supabase's default grants give `anon` and `authenticated` USAGE on it and EXECUTE on `net.http_get` / `http_post`, so any SQL running as those roles can make outbound requests (server-side request forgery: e.g. calling internal URLs the browser can't reach).
  - **Precisely:** injection + DEFINER = the attacker gets the function owner's rights (here: the whole database, `auth.users`, Vault). Injection + INVOKER = the attacker gets **no more than their own role's rights**: RLS and grants still apply, so other users' rows stay hidden. That is the same set of rights the API already gives them, **plus** whatever the role may do that the API doesn't expose (here: pg_net). INVOKER limits the damage; it doesn't make the injection harmless.
- **The safe version** (`sqli_search_bookings_safe`): values passed as parameters (`execute … using`), the sort column quoted with `format('%I')` (`%L` would be the choice for a value that can't be a parameter). The same inputs are searched for literally (0 rows); a sort column `starts_at; delete from public.bookings --` is just an unknown column (error, nothing runs).
- **The unsafe functions (both versions) can't stay switched on by accident:** (1) no API role may execute them (revoked in the migrations; the proof grants them only for its run and revokes them on exit, also on Ctrl+C or a crash); (2) even if granted, they refuse unless `sqli_probe_switch.unsafe_enabled_until` is in the future, and the proof sets that to +2 minutes (the INVOKER version asks a small DEFINER helper, `sqli_probe_unsafe_enabled()`, since the caller can't read the switch table); (3) the exposure scan fails if the API can call them.
- **What this says about Supabase:** `rpc()` makes **every function in `public` with execute rights an API endpoint**, and `SECURITY DEFINER` turns off RLS inside it. One careless `EXECUTE` in a DEFINER function therefore exposes the whole database, including `auth.users` and Vault, to any logged-in user; in an INVOKER function, RLS still holds, but the default pg_net grants turn it into an outbound-request tool. (Revoking `net` access from `anon`/`authenticated` would close that, if nothing in the app needs it; not changed here, recorded.) Supabase's advisors didn't flag it (step 1). In a NestJS backend the same mistake (string-built SQL in a repository) is possible too, but the endpoint would sit behind a route and the database user wouldn't normally own `auth`/Vault-like secrets.
- **Time spent:** ~45 min + ~30 min (INVOKER contrast)

### Security review: summary

| | Advisors + linter | Exposure scan | SQL injection |
|---|---|---|---|
| Built with | Supabase CLI (`db advisors`, `db lint`) | supabase-js + psql, expected-access map | 3 Postgres functions (unsafe DEFINER, unsafe INVOKER, safe) + proof script |
| Found | 11 advisor + 1 linter items: 1 real (pointer to the series issue), rest intended/cosmetic | **2 real issues** (unlimited series; limit bypass 40/10), fixed | supabase-js safe; own functions are the risk; unsafe + DEFINER leaked other hosts' guests, all user emails, Vault secrets; unsafe + INVOKER stayed within RLS but could still send HTTP requests via pg_net |
| Missed by Supabase's tools | — | the limit bypass | the injectable function |
| Proof | evidence file | 115 checks | 24 checks |
| Time | ~30 min | ~1 h 45 min | ~1 h 15 min |

**For the blog:** Supabase's built-in protections held up: no cross-host reads or writes, internal functions closed, supabase-js parameterised. But the two real holes were both in **what the database exposes by design**: insertable columns the app never uses together, and a function callable via `rpc()`. Supabase's Security Advisor checks configuration and missed both; a scan that tries every table, function and column combination as each role is what found them. SQL injection in one sentence: **injection + `SECURITY DEFINER` exposes everything the owner can reach; injection + `SECURITY INVOKER` is still limited by RLS and grants, but those grants include more than the API shows (pg_net).** **Total: ~3 h 30 min.**

---

# Hosted checks (prepared, not run yet)

The *to verify before publishing* items depend on Supabase's cloud setup, so they need a hosted project. Prepared: `HOSTED_CHECKS.md` (setup, order, how to record results), `src/probes/hosted/` (7 scripts), two Edge Functions (`hosted-probe`, token-locked: sleeps with heartbeats, echoes IP headers, reports its database role; `hosted-jwt-check`, built-in JWT check **on**), migration `20261015110057_hosted_probe.sql` (heartbeat table, closed to the API).

- **Probe-only objects on a hosted project:** `db push` applies every migration (the schema must match, and later migrations depend on earlier ones), so nothing is skipped; instead `hosted:lockdown` **drops** both injectable functions, **closes** `audit_log_client` and unschedules the DocuSign/reminder jobs, and only the two check functions are deployed. Every hosted script re-checks this in the database first and refuses to run otherwise; `hosted:preflight` also checks it through the public API.
- **Caught while dry-running the lockdown locally (inside a rolled-back transaction):** my first "is `audit_log_client` writable?" check used `has_table_privilege`, which said `false` even locally, where it is writable: the insert right is a **column-level** grant, which `has_table_privilege` doesn't see. `has_any_column_privilege` does. Easy to get wrong when auditing grants by hand.
- **Already visible locally:** `hosted-jwt-check` keeps Supabase's JWT check on, yet answered **200 to the publishable key alone**, confirming that check doesn't identify the caller (local CLI 2.120).
- **Not verified end to end:** the hosted scripts' SQL and pg_net calls were tried locally; the scripts themselves need the hosted project to run.
- **Time spent:** ~1 h 30 min

# NestJS comparison plan (plan only)

`NESTJS_COMPARISON_PLAN.md`: a scenario runner in `scenarios/` with one adapter per backend (front door = the `src/services/` function names; back door = seeding, database truth, fault injection), ported and proven against Supabase first; a table of which of today's scripts become shared scenarios (most) and which stay Supabase-only (audit stage 1, supa_audit/pgaudit, advisors, DEFINER/INVOKER, hosted limits); and the same effort method (Claude Code, same briefs, same stages, objective numbers per stage, platform work kept separate, the "built second" bias stated). **Time spent:** ~30 min

---

# NestJS version

Branch `feature/msa-nestjs` (stacked on `feature/msa-supabase-advanced`). Plan: `NESTJS_COMPARISON_PLAN.md`. Decisions (2026-10-16): **Prisma** for database access, **JWT bearer tokens** for the NestJS's own login (same model as Supabase Auth), **shared test runner first** (N1) so the core is built against a ready target.

**Measured the same way as the Supabase version:** AI-assisted build time with Claude Code (model: Claude Opus 5.5), the author directing, reviewing and testing; one commit per stage; same entry format. **Platform work** (things Supabase gave for free: database setup, login, hosting) is marked *platform* so the per-feature numbers stay comparable.

## N0: scaffold (platform)

NestJS app from the official CLI (`@nestjs/cli` 12.0.8 generated a NestJS **11** template), Postgres 17 in Docker on port 5433 (`backend/docker-compose.yml`), Prisma 7.10.0 with the node-postgres driver adapter, `GET /health` checks the database. Root scripts: `backend:install`, `backend:db:start|stop`, `backend:migrate`, `backend:dev`, `backend:build`.

- **What Supabase gave for free here:** a running database, an API and a dashboard after `supabase start`. NestJS: choose and wire an ORM, a database container, config loading, a module for the database client, an endpoint. Small, but it's the first of several "platform" costs.
- **Surprises:**
  - **Prisma's `latest` npm tag pointed at a release candidate** (8.0.0-rc.23, published the day before). Installing "latest" would have pulled a pre-release; pinned **7.10.0** (August) instead.
  - **`prisma init` installed AI-assistant instruction files** (`.agents/skills/…`, `.claude/skills`, `.windsurf/skills`, `skills-lock.json`, downloaded from Prisma's GitHub). Removed: they would change how Claude Code behaves inside `backend/`, and the Supabase version was built without vendor instructions, so keeping them would break the "same assistant setup" rule. It also named its config `prisma7.config.ts` and ignored the `--url` flag (placeholder URL in `.env`); renamed to the standard `prisma.config.ts`, URL set by hand.
  - **Prisma 7 changes the setup:** the client is generated as TypeScript into `src/generated/prisma` (git-ignored, `postinstall` regenerates it), needs `moduleFormat = "cjs"` for NestJS's CommonJS build, and connects through a driver adapter (`@prisma/adapter-pg`). The config file next to `src/` was compiled too and moved the build output to `dist/src/` (`Cannot find module dist/main.js`); excluded in `tsconfig.build.json`.
  - **`.env` is found relative to where you start the API, not where the code is.** Started from the repo root, NestJS didn't find `backend/.env`, `DATABASE_URL` was empty, and Postgres silently tried a database named after the OS user (`database "mahima" does not exist`, as a 500 on `/health`). Fixed: load `backend/.env` by path, and refuse to start without `DATABASE_URL`. Supabase has no equivalent trap here: `supabase start` wires its own connection settings.
- **Files:** `backend/` (~290 lines of our own code and config, plus the CLI template and `package-lock.json`), root `package.json` (+6 scripts).
- **Testing/debugging:** easy (one `curl`). The first `nest build` took several minutes; later builds are quick.
- **Time spent:** ~55 min (platform, incl. ~10 min for the `.env` path fix)

## N1: shared scenario runner (test infrastructure, both versions)

`scenarios/`: a runner (`run.mjs`), one adapter per backend (`adapters/supabase.mjs` done, `adapters/nestjs.mjs` a placeholder until N2) and the first shared feature, `features/core-permissions.mjs`: the 60 checks of `scripts/test-rls.mjs`, same order, written against the adapter. `npm run scenarios -- --backend supabase|nestjs`, `npm run scenarios:supabase`; the adapter interface is documented in `scenarios/README.md`.

- **Proof the port is faithful, not just passing:** both report 60/60 with identical check names in the same order, and with a deliberate hole opened (anonymous visitors allowed to read bookings, then closed again) **both fail the same 5 checks**. A first attempt at a hole (letting hosts change a guest's email) failed to break either test: the bookings RLS policy only accepts updates that end in `cancelled`, so a second layer still refused it. Good to know (defence in depth), and a reminder that a mutation test must remove the *only* layer.
- **Where the shared version had to differ:** 2 checks test Supabase mechanics (insert + read back in one request, rolled back as a whole); the adapter declares that capability, so they run on Supabase and will show as **SKIP with a reason** on NestJS. Live updates (4) and avatars (11) are the same: the NestJS adapter declares them when N4 builds them. Skips are printed and never counted as passed. Two checks compare *shapes* instead of exact field names (status lookup and broadcast payload: "no guest data, 4 fields"), since NestJS will name fields its own way.
- **Deviation from the plan:** the plan's step 1 ("make `src/services/` usable from Node") isn't needed yet. The scenarios must also send requests the app never sends (attacks), which the services layer doesn't offer, so the Supabase adapter uses supabase-js directly. `src/services/` gets its NestJS twin in N3.
- **Files:** `scenarios/` (~410 lines incl. README), root `package.json` (+2 scripts), `scripts/evidence.mjs` (+1 entry).
- **Testing/debugging:** easy; one run takes ~10 s. The hand-made mutation test is the useful part and should be repeated for each ported feature.
- **Time spent:** ~45 min (shared: counts for neither version)
