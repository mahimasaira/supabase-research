# Shared scenarios

The same tests against both backends, so the Supabase and NestJS versions are judged by identical checks (plan: [../NESTJS_COMPARISON_PLAN.md](../NESTJS_COMPARISON_PLAN.md)).

```bash
npm run scenarios -- --backend supabase                    # all features
npm run scenarios -- --backend supabase core-permissions   # one feature
npm run scenarios:supabase                                 # shortcut (also used by npm run evidence)
VERBOSE=1 npm run scenarios -- --backend supabase          # show details for passing checks too
```

- `features/*.mjs`: one file per feature. Each exports `name` and `run(t, api)` and talks **only** to `api` (the adapter), never to supabase-js or HTTP directly.
- `adapters/<backend>.mjs`: one per backend. `supabase.mjs` is done; `nestjs.mjs` comes in N2.
- `run.mjs`: loads the adapter and the features, prints PASS / FAIL / SKIP, exits non-zero on any FAIL.

**SKIP** means the backend doesn't have that part (yet), with the reason printed. It is never counted as passed: "50/50 passed, 15 skipped" is not "65 passed".

## The adapter interface

Every function returns `{ ok, data, error }`: `ok` false with `error: { code, message }` when the backend refused, `data` in camelCase. A refused update or delete may also come back as `ok: true` with an empty array (that is how Supabase/RLS reports it); scenarios treat both as "blocked". `s` is a session from `guest()` or `signUpHost()`.

| Function | Meaning |
|---|---|
| `name`, `has(feature)` | backend name; optional parts: `'insertReadBack'` (Supabase mechanics), `'realtime'`, `'avatars'` |
| `guest()` → `s` | an anonymous visitor |
| `signUpHost(displayName)` → `{ id, s }` | a new host account, logged in |
| `createSlot(s, { hostId, startsAt, endsAt, isBooked? })` | `data`: the slot. `isBooked` is an attack (clients must not set it) |
| `listFreeSlots(s, hostId)` | slots visible to `s` for that host (for a guest: free, future) |
| `getSlot(s, slotId)` | `data`: the slot if `s` may see it, else `null` |
| `updateSlot(s, slotId, { startsAt?, endsAt?, isBooked? })` / `deleteSlot(s, slotId)` | `data`: changed slots (empty = refused) |
| `getHostProfile(s, hostId)` | `data: { displayName }` |
| `updateProfile(s, hostId, { displayName?, id?, avatarPath? })` | `data`: changed profiles |
| `book(s, { slotId, guestName, guestEmail, cancelToken, status?, readBack? })` | `status` is an attack; `readBack` only with `has('insertReadBack')` |
| `listBookings(s)` | `data: [{ slotId, guestName, guestEmail, status, cancelledAt }]` visible to `s` |
| `updateBooking(s, slotId, { status?, guestEmail? }, { onlyIfStatus? })` / `deleteBooking(s, slotId)` | `data`: changed bookings |
| `cancelByToken(s, token)` | `data: true / false` |
| `bookingStatuses(s, tokens)` | `data`: the raw objects the backend returns (checked for leaked guest data) |
| `callInternal(s)` | try an operation that must not be reachable from outside |
| `subscribeSlots(hostId, onEvent)` → `{ sendFake(payload), close() }` | live slot updates; events `{ id, startsAt/starts_at, endsAt/ends_at, available }` |
| `avatarUpload(s, path, blob, { upsert? })`, `avatarRemove(s, path)`, `avatarUrl(path)` | `path` = `<hostId>/<file>` |
| `cleanup()` | remove what the run created (back door, privileged) |

Later features add their own functions (seeding, database truth, fault injection: the "back door" in the plan).
