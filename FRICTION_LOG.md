# Friction log

Things about Supabase that were harder than expected, needed a workaround, or would push toward a dedicated backend.

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
| **Abuse protection** for guest bookings | RLS controls *who* may write, not *how often*. No rate limit on data writes; CAPTCHA only covers auth. |
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
  - **Real race:** another session booked week 3 inside an open transaction. The function **waited ~1.6 s** on the unique index until that transaction committed, then got `23505`, reported "week 3 just taken" and rolled back weeks 1–2. Nothing left behind.
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
  - **Race:** a concurrent booking of week 3 → the function waited ~1.6 s, reported "week 3 just taken", rolled back weeks 1–2.
- **The big trap: a direct connection is `postgres`, the owner, which bypasses RLS.** Every query would silently ignore every policy. Supabase doesn't warn about this. To get RLS back, the function must do by hand what PostgREST does for every API request: `set_config('role', 'anon' | 'authenticated', true)` and `set_config('request.jwt.claims', <claims>, true)` at the start of **each** transaction (the `true` = transaction-local, so the next request on the same connection doesn't inherit it). Forget either and it still "works", just without RLS, or with `auth.uid()` = null.
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
| Hardest part | noticing the problem at all | raise-don't-return, invoker vs definer trade-off | identity + RLS on a superuser connection |

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
| Status | our code | **archived** since Jan 2024, not in the local image | maintained, preloaded in Supabase |
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
- **pgaudit and the API:** with `pgaudit.log = 'write'`, API writes are **not logged at all**: PostgREST sends them as `WITH … INSERT … SELECT`, which pgaudit classifies as a *read*. Only `'read, write'` captures them, which also logs every read. Role settings reach the API only after its pooled connections reconnect (restart the API container). `postgres` can't enable `pgaudit.log_parameter` (permission denied), so values of API calls stay `<not logged>`.
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
