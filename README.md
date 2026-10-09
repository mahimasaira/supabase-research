# Supabase booking

A minimal booking app built to answer one question: **where is Supabase enough on its own, and where does a dedicated backend become necessary?**

- **Hosts** sign up, create one-off time slots, see their bookings and upload a profile picture.
- **Guests** need no account: they open a host's public page, book a free slot with name + email, and can cancel.

There is **no custom backend**. The Vue app talks to Supabase directly from the browser with `supabase-js` and only the publishable (anon) key. All rules live in the database: constraints, row-level security (RLS), column grants, triggers and one RPC function.

Related docs:
- [FRICTION_LOG.md](FRICTION_LOG.md): what was harder than expected, the workarounds, and where a backend would be needed.
- [RLS_RULES.md](RLS_RULES.md): what each role is allowed and blocked from doing, and how to test it.

## Stack

- Vue 3 + Vite (SPA), Vue Router, Composition API, JavaScript, Tailwind CSS
- `@supabase/supabase-js`
- Supabase CLI for local development; all schema changes are SQL migrations in `supabase/migrations`

## Prerequisites

- **Node.js** 22.18+ or 24.12+ (see `engines` in `package.json`)
- **Docker** (Docker Desktop or similar), running
- **psql** (optional, only for `npm run test:clean`)

You don't need a supabase.com account: the whole Supabase stack runs locally in Docker.

## Setup

```sh
# 1. Install dependencies (includes the Supabase CLI as a dev dependency)
npm install

# 2. Start local Supabase. The first run downloads ~10 Docker images and can take 10–20 minutes.
#    Migrations in supabase/migrations are applied automatically.
npm run db:start

# 3. Create your env file
cp .env.example .env.local
```

Fill in `.env.local` with the values printed by `npm run db:status`:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<the "Publishable" key, sb_publishable_…>
```

> Only the publishable key goes here. It's public by design: the RLS policies protect the data, not the key. **Never** put the secret / service_role key in a `VITE_` variable: Vite ships every `VITE_` variable to the browser.

```sh
# 4. Start the app
npm run dev
```

Open **http://127.0.0.1:5173**.

## Local URLs

| What | URL |
|---|---|
| App | http://127.0.0.1:5173 |
| Supabase Studio (DB admin, logs; no login needed locally) | http://127.0.0.1:54323 |
| Mailpit (catches auth emails sent locally) | http://127.0.0.1:54324 |
| Supabase API | http://127.0.0.1:54321 |

## Trying it out

1. **Sign up** as a host. Email confirmation is off locally, so you're logged in right away.
2. On the **dashboard**, set a display name and picture, and add a few slots.
3. Open **your public booking link** (shown at the top of the dashboard, `/book/<your-user-id>`) in a private window and book a slot as a guest.
4. Keep the booking page open in two windows: a slot booked in one disappears from the other within a second (Realtime).
5. Cancel as the guest (button or cancel link) or as the host (dashboard).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on 127.0.0.1:5173 |
| `npm run build` | Production build into `dist/` |
| `npm run db:start` / `db:stop` | Start / stop local Supabase |
| `npm run db:status` | Show local URLs and keys |
| `npm run db:reset` | **Wipe** the local database and re-apply all migrations |
| `npm run test:rls` | 60 permission checks (RLS, grants, Realtime, Storage) through supabase-js with only the publishable key. Creates throwaway `@test.dev` hosts. `VERBOSE=1` shows why each action was blocked. |
| `npm run test:clean` | Delete the `@test.dev` users created by `test:rls` (needs `psql`) |

To apply a new migration without wiping data, use `npx supabase migration up`.

## Project structure

```
supabase/
  config.toml                         local Supabase settings
  migrations/
    …_init_schema.sql                 tables, constraints, triggers (step 2)
    …_rls_policies.sql                grants, RLS policies, cancel_booking() RPC (step 4)
    …_realtime_slots.sql              first Realtime attempt (postgres_changes), undone in the next one
    …_realtime_broadcast_slots.sql    Broadcast from Database + realtime.messages policy (step 6)
    …_avatars_storage.sql             avatars bucket + storage policies (step 7)
    …_guest_booking_status.sql        get_booking_statuses() RPC: guests see host cancellations
scripts/
  test-rls.mjs                        permission test suite
src/
  lib/supabase.js                     the single Supabase client
  composables/useAuth.js              session state, sign up / in / out
  composables/useSlotChannel.js       Realtime subscription for a host's slots
  components/ProfileCard.vue          display name + avatar upload
  views/                              Home, Login, Signup, Dashboard, Book (/book/:hostId), Cancel (/cancel/:token)
```

## How it works

### Data model

- **profiles**: one row per host, created by a trigger on sign-up. `id` = the auth user id.
- **slots**: `host_id`, `starts_at`, `ends_at`, `is_booked`. An exclusion constraint prevents overlapping slots per host.
- **bookings**: `slot_id`, guest name/email, `status` (`confirmed` / `cancelled`), `cancel_token`.

**No double booking:** a partial unique index allows at most one *confirmed* booking per slot. If two guests book at the same moment, Postgres accepts one and rejects the other. A cancelled booking frees the slot again.

### Security

- **Column grants** decide which columns each role may write (Supabase grants everything by default; we revoke and re-grant).
- **RLS policies** decide which rows. See [RLS_RULES.md](RLS_RULES.md).
- Guests can't read bookings, so:
  - the browser generates the booking's `cancel_token` itself;
  - cancelling goes through the `cancel_booking(token)` RPC function;
  - the `get_booking_statuses(tokens)` RPC lets a guest's page see whether the host cancelled;
  - `slots.is_booked` (kept in sync by a trigger) tells guests which slots are free.

### Realtime

A trigger on `slots` broadcasts `{ id, starts_at, ends_at, available }` to the private channel `slots:<host_id>`. Anyone may receive on it; no client may send. The booking page and the dashboard subscribe to it. Realtime's `postgres_changes` mode was tried first and doesn't work here: it drops the "slot booked" event for guests because of RLS. See the friction log.

### Storage

Public `avatars` bucket (2 MB, PNG/JPEG/WebP). Files live under `<host_id>/…`, and the storage policies only let a host write inside their own folder.

## What this app deliberately doesn't do

These need server-side code (e.g. a Supabase Edge Function) and are discussed in the friction log:

- confirmation / cancellation emails
- rate limiting or CAPTCHA for guest bookings
- validating that an uploaded file really is an image
- "delete my account" including stored files

## Deploying to hosted Supabase (not done in this project)

1. Create a project on supabase.com.
2. `npx supabase link --project-ref <ref>` then `npx supabase db push` (applies the same migrations).
3. Put the project's URL and publishable key in your production env.
4. Set the auth **Site URL** / redirect URLs to your deployed domain. Note that **email confirmation is on by default** in hosted projects: sign-up then shows "check your email" instead of logging in.
