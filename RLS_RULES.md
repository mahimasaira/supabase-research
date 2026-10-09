# What the rules allow and block

Every rule below is enforced **in the database** (RLS policies, column grants, constraints, storage policies), not just hidden in the UI. Calling the API directly with the publishable key gets the same answer as the app.

**Automated:** `npm run test:rls` checks all of these (60 checks). Add `VERBOSE=1` to see the exact response for each one. Run `npm run test:clean` afterwards.

**By hand:** use the app in a normal window (host) and a private window (guest). To bypass the UI, call the REST API directly:

```sh
source .env.local
curl "$VITE_SUPABASE_URL/rest/v1/bookings?select=*" -H "apikey: $VITE_SUPABASE_ANON_KEY"
# → 42501 permission denied: guests can't read bookings
```

## How a "no" looks

There are three different shapes. Knowing them makes testing easier:

| Response | Meaning |
|---|---|
| `42501 permission denied for table …` | The role may not touch that table/column at all (grants). |
| `42501 new row violates row-level security policy` | Insert/update produced a row the policy doesn't accept (`with check`). |
| Success, but `[]` / 0 rows affected | RLS hid the row, so the update/delete matched nothing. **Not an error.** |

## Guest (no login)

| Allowed | How to test |
|---|---|
| Read a host's **free, future** slots | Open `/book/<host-id>` in a private window |
| Read host profiles (display name, picture) | Same page shows name + picture |
| Book a free future slot (name, email) | Book on that page |
| Cancel **with the right cancel token** | Cancel button, or open the `/cancel/<token>` link |
| See the **status** of bookings whose cancel token they hold | Host cancels → guest's "Your bookings" shows *Cancelled* |
| Receive live "slot changed" broadcasts | Two private windows; book in one, watch the other |
| Download avatars via public URL | Picture shows in a private window |

| Blocked | How to test / what you'll see |
|---|---|
| Read any bookings (incl. their own) | `curl …/rest/v1/bookings` → 42501 |
| See booked or past slots | Booked slot vanishes from the booking page |
| Book a slot that's taken | Book same slot in two windows → "just taken" |
| Book a slot in the past | Not listed; direct insert → RLS error |
| Set `status` when booking | Insert with `status` → 42501 |
| Invalid email / empty name | Check constraint error (23514) |
| Update or delete bookings directly | 42501 |
| Cancel with a wrong or reused token | `cancel_booking` returns `false` |
| Look up status for a token they don't hold | `get_booking_statuses` returns nothing for it |
| Cancel after the slot has started | `cancel_booking` returns `false` |
| Create, edit or delete slots; change `is_booked` | 42501 |
| Edit profiles | 42501 |
| Upload files | Storage `AccessDenied` |
| Send fake Realtime broadcasts | `send()` says `ok`, but nobody receives it |
| Call internal trigger functions via RPC | Not found / denied |

## Host (logged in), own data

| Allowed | How to test |
|---|---|
| Create slots in the future, for themselves | Dashboard → New slot |
| See all own slots (booked and past too) | Dashboard list |
| Move or delete own **unbooked** slots | Delete button on a free slot |
| See bookings on own slots, incl. guest name + email | Dashboard → All bookings |
| Cancel bookings on own slots | Dashboard → Cancel booking |
| Edit own display name | Dashboard → Profile |
| Upload, replace, delete own picture (in `<own-id>/…`) | Dashboard → Profile |
| Use any public booking page like a guest | Open another host's `/book/…` link |

| Blocked | How to test / what you'll see |
|---|---|
| Create a slot in the past | Dashboard → "Slots must start in the future" |
| Create overlapping slots | Dashboard → "overlaps one of your existing slots" (23P01) |
| Create a slot that ends before it starts | Check constraint (23514) |
| Create a slot for another host | RLS error |
| Delete or move a **booked** slot | 0 rows affected; cancel the booking first |
| Change `is_booked` | 42501 |
| Edit guest name/email on a booking | 42501 |
| Set booking status to anything but `cancelled` (e.g. un-cancel) | RLS error |
| Change own profile `id` | 42501 |
| Point `avatar_path` at another host's file | RLS error |
| Upload a non-image (by declared type) or a file > 2 MB | Storage `InvalidMimeType` / `EntityTooLarge` |

## Host, someone else's data

Sign up a second host (another browser or private window) to test these.

| Blocked | What you'll see |
|---|---|
| Read another host's bookings | Empty list |
| See another host's booked or past slots | Not returned |
| Move, delete or cancel another host's slots/bookings | 0 rows affected |
| Edit another host's profile | 0 rows affected |
| Upload into, overwrite or delete from another host's folder | Storage `AccessDenied` / nothing deleted |

## Known gaps (not blocked)

These are allowed and would need server-side code to stop. Details in [FRICTION_LOG.md](FRICTION_LOG.md).

- A script can book **every** free slot with fake names/emails (no rate limit, no CAPTCHA, no email verification).
- A file containing non-image bytes but **labelled** `image/png` is accepted.
