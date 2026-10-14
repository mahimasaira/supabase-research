# Final pass: testing and documentation

One procedure for the end of the Supabase version: **test everything, then document it for the blog**.
Details live in two other files; this one tells you the order:

- [TESTING.md](TESTING.md): what each command / page should show (detailed tables per feature and stage)
- [BLOG_EVIDENCE.md](BLOG_EVIDENCE.md): the screenshot checklist per stage (90 items)

Estimated time: **setup 15 min · automated tests 25 min · manual tests ~2 h · documentation ~3–4 h**.

---

## Part 0: Before you start (15 min)

- [ ] **Commit everything** (`git status` must be clean). Evidence files are labelled with the commit; uncommitted work shows up as `-dirty`.
- [ ] **Docker Desktop is running.**
- [ ] `npm run db:start` (local Supabase). Check: `npm run db:status` lists the services.
- [ ] **Second terminal:** `npm run functions:serve` and leave it running. Wait for `Serving functions on http://127.0.0.1:54321/functions/v1/…`.
  - If it says *"No such container: supabase_edge_runtime…"*: `npx supabase stop && npx supabase start`, then start it again (data is kept).
- [ ] **One-time setups** (again after any `npm run db:reset`):
  ```bash
  npm run probe:docusign:setup     # DocuSign values + key into supabase/functions/.env, Vault entries
  npm run probe:spam:setup         # Turnstile test secret
  npm run probe:reminders:setup    # Vault entries for the reminder functions
  ```
  Then restart `functions:serve` (Ctrl+C, start again) so the functions read the new env file.
- [ ] **DocuSign still works:** `node --env-file=.env.local scripts/docusign-check.mjs` → 4 × PASS. If not, fix this first (demo accounts can expire).
- [ ] **Third terminal:** `npm run dev` → app at http://127.0.0.1:5173
- [ ] Bookmark: **Studio** http://127.0.0.1:54323 · **Mailpit** http://127.0.0.1:54324

**Test accounts** (all `password123`):

| Account | Used for | Reset |
|---|---|---|
| `recurring-host@test.dev` | recurring bookings, audit log, DocuSign | `npm run probe:audit:seed` |
| `spam-host@test.dev` | spam protection | `npm run probe:spam:seed` |
| `reminder-host@test.dev` | bulk reminders | `npm run probe:reminders:seed` |

`npm run test:clean` deletes **all** `@test.dev` users, including these hosts: run the three seeds again afterwards.

---

## Part 1: Automated tests (25 min)

### 1.1 Everything at once

```bash
npm run evidence -- all
```

- Runs all 18 proof scripts in order and **saves each output** to `evidence/` with today's date and commit.
- Sends **about 8 real DocuSign emails** to `DOCUSIGN_TEST_SIGNER_EMAIL`. Use `npm run evidence -- all --no-email` to skip those sections.
- Don't use the app while it runs (some scripts restart the API container or reset test data).

**Expected:** the final list shows `ok` for every script. Then:

```bash
npm run test:clean && npm run probe:audit:seed && npm run probe:spam:seed && npm run probe:reminders:seed
```

### 1.2 What each script proves (and its expected last line)

| Feature | Command | Expected |
|---|---|---|
| Core | `npm run test:rls` | `60/60 passed` |
| 1 Recurring | `npm run probe:recurring:edge-proof` | `All checks passed` (17) |
| 2 Audit | `npm run probe:audit:proof` | `All demos reproduced` (19) |
| | `npm run probe:audit:proof:triggers` | `All checks passed` (21) |
| | `npm run probe:audit:compare` | `SKIP` (supa_audit removed in stage 4; see Part 3.3) |
| | `npm run probe:audit:proof:history` | `All checks passed` (12) |
| 4 DocuSign | `npm run probe:docusign:proof:pending` | `All checks passed` (15) |
| | `npm run probe:docusign:proof:send` | `All checks passed` (13), 2 real emails |
| | `npm run probe:docusign:proof:receive` | `All checks passed` (19), 1 real envelope sent + voided |
| | `npm run probe:docusign:proof:failures` | `All checks passed` (17), ~2 min |
| 3 Spam | `npm run probe:spam:flood` | `SKIP` (limits stop it now; stage 1 output already in `evidence/`) |
| | `npm run probe:spam:proof:limits` | `All checks passed` (15) |
| | `npm run probe:spam:proof:captcha` | `All checks passed` (15) |
| | `npm run probe:spam:compare` | table + `All checks passed` (8), ~2 min |
| 5 Reminders | `npm run probe:reminders:naive` | `All problems reproduced`, ~1.5 min |
| | `npm run probe:reminders:proof:queue` | `All checks passed` (11), ~3 min |
| | `npm run probe:reminders:proof:optout` | `All checks passed` (15), ~3 min |
| | `npm run probe:reminders:compare` | table + `All checks passed` (6), ~4 min |
| Build | `npm run build` | `✓ built` |

**If a script fails:** run it once more on its own. Timing-dependent ones (reminders, Edge Functions after a reload) can hit a local hiccup; a second failure is real. See *Troubleshooting* at the end of TESTING.md.

---

## Part 2: Manual tests in the browser (~2 h)

The scripts test the API and database; these check what a **person sees**. Reset the relevant host before each feature. Detailed expectations: TESTING.md, section per feature.

### 2.0 Core app (10 min)
- [ ] Sign up a new host, log in, add 2 slots on the Dashboard, upload a profile picture.
- [ ] In a private window (logged out), open the host's booking page, book a slot → green "Booked" + cancel link.
- [ ] Keep the booking page open in a second window: booking in one makes the slot disappear in the other (Realtime).
- [ ] Cancel via the cancel link → slot free again; the host's Dashboard shows "cancelled".

### 2.1 Recurring bookings (15 min) · `/probes/recurring`, logged out
- [ ] Stage 1, first Monday × 6 → 🔴 week 4 + 🟠 "still saved: weeks 1, 2, 3"; Studio `src/probes/recurring/sql/check.sql` → `6 | 3`.
- [ ] Reseed; Stage 2 → 🟢 "Rolled back"; `check.sql` → no rows.
- [ ] Reseed; Stage 3 → "ran as role anon"; log in and repeat → `authenticated` + your id.

### 2.2 Audit log (20 min) · `/probes/audit` and `/history`
- [ ] Logged out on `/probes/audit`: produce 🟢, 🟠 (log fails), ⚪ and 🔴 (log first + **Book again**), plus a fake entry.
- [ ] Studio `check-triggers.sql`: the 🟠 booking is missing from the browser log but present in the trigger log; no ghost entries.
- [ ] Log in as `recurring-host@test.dev` → **History**: Guest / You / Database admin lines, a recurring booking as one line, filters work.

### 2.3 Spam protection (20 min) · spam host
- [ ] ⚠️ **Never tested in a browser before:** log in as `spam-host@test.dev`, tick **Require a CAPTCHA**. Log out, open `/book/22222222-2222-4222-8222-222222222222`, pick a slot → Cloudflare box shows "Success!", then **Book this slot** is enabled → booking works. Book a second slot without reloading (the box resets and passes again).
- [ ] Same email 4 times → 4th: "You already have 3 active bookings with this host."
- [ ] Reseed; 11 quick bookings (any emails) → 11th: "This host is receiving too many bookings right now…"
- [ ] Untick the CAPTCHA → no box, booking as before.

### 2.4 DocuSign (30 min) · `recurring-host@test.dev`, your own email
- [ ] Dashboard: tick **Require a signed agreement**.
- [ ] Logged out, book with **your** email → "Held for you … sign it"; Dashboard: "Awaiting signature from …".
- [ ] The DocuSign email arrives (check spam) → **Review Document → Sign → Finish** → Dashboard: **Check signature status** → "1 signed"; slot green; History: "… signed the agreement".
- [ ] Book again, **Decline to Sign** in the email → Check status → booking cancelled, slot free.
- [ ] Book again, then **cancel** (guest or host) → DocuSign sends a "voided" email; the agreement can't be signed.
- [ ] Untick the setting at the end (otherwise every booking on this host sends an email).

### 2.5 Bulk reminders (20 min) · reminder host, Mailpit
- [ ] `npm run probe:reminders:seed`, then in Studio: `select public.enqueue_reminders('33333333-3333-4333-8333-333333333333')` → 200; again → 0.
- [ ] `select public.process_reminders()` → after ~30 s, 200 reminders in Mailpit.
- [ ] Open one: host, time (UTC), cancel link, unsubscribe link; **Headers** tab shows `List-Unsubscribe`.
- [ ] Open the unsubscribe link → **Stop reminders** → "Done…". Reseed; enqueue → 199.

### 2.6 Clean up
- [ ] Untick test settings (CAPTCHA, signature), run the three seeds, `npm run test:clean` if you created test users.
- [ ] In Mailpit, delete the test emails (search `reminder-test.example`, delete).

---

## Part 3: Documentation (~3–4 h)

Work through [BLOG_EVIDENCE.md](BLOG_EVIDENCE.md) **in this order**:

### 3.1 DocuSign first (external account, may expire)
- [ ] Feature 4 section: emails, agreement document, Check signature status, voided email, History lines.

### 3.2 Everything on the current code
- [ ] Features 1, 2 (stages 1, 2, 4), 3, 5 and 6 (optional): one section at a time.
- Per screenshot: **reset first** (seed), set up the scene the item describes, capture, tick the box.
- **File names:** `f<feature>-s<stage>-<what>.png`, e.g. `f3-s3-captcha-widget.png`. Keep them in one folder outside the repo (or a `blog/` folder, but don't commit large images by accident).
- **Blur** real emails, envelope ids, keys, and the DocuSign account name if you prefer.
- **Text evidence:** use the matching file in `evidence/` (newest, with a clean commit label from Part 1.1). Terminal screenshots of the comparison tables work well for the blog.

### 3.3 The two old states (needs an old commit)
Only after everything else, because it rebuilds the database:
- [ ] **Audit stage 3** (supa_audit breaking sign-up, pgaudit lines): `git checkout 603a771`, `npm run db:reset`, `npm run probe:audit:seed`, then `npm run probe:audit:compare` and the items in BLOG_EVIDENCE.
- [ ] Return: `git checkout feature/msa-supabase-advanced`, `npm run db:reset`, run the three setups from Part 0, restart `functions:serve`, run the three seeds.
- DocuSign stage 4 "before" doesn't need this: its text is saved in `evidence/…docusign-stage4-before-fixes…`.

### 3.4 Your own notes (blog material the logs don't have)
- [ ] **Your testing and review time** per feature (the friction log only has build time).
- [ ] **What was confusing as a newcomer** (e.g. RLS vs. grants, why an Edge Function was needed, what a queue is).
- [ ] **One-line takeaway per feature.** Each friction-log feature summary ends with a "For the blog" paragraph to start from.

### 3.5 The overall answer
- [ ] Add an **overall summary** at the top of FRICTION_LOG.md: one table across all features, "where is Supabase enough, where does a backend become necessary?" (I can draft it from the five feature summaries.)
- [ ] Re-read the five "Backend needed?" conclusions for consistency.

### 3.6 Finish
- [ ] `npm run evidence -- all` once more if code changed during the pass.
- [ ] Commit the documentation (FRICTION_LOG.md, BLOG_EVIDENCE.md with ticks, your notes). Screenshots and `evidence/` stay out of git unless you decide otherwise.

---

## Known limits of what was tested

- **CAPTCHA:** only with Cloudflare's test keys (any token passes); real bot detection needs real keys. The widget itself is untested in a browser until Part 2.3.
- **Webhooks:** DocuSign can't reach `localhost`; the webhook is proven with simulated, signed messages. Real Connect messages need a hosted project or a tunnel.
- **Edge Function limits, IP headers, rate limits:** measured locally; hosted Supabase may differ (noted in the friction log).
- **Emails:** reminders only went to Mailpit; no real email provider was used.
