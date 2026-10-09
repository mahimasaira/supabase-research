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
