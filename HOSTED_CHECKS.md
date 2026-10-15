# Hosted checks: re-running local findings on a free Supabase project

Everything in this project ran on the **local** Supabase stack. A few findings depend on Supabase's real cloud setup (gateway, proxies, Edge runtime limits) and are marked *to verify before publishing* in FRICTION_LOG.md and BLOG_REPORT.md. This file is the plan and the procedure for checking them on a **free hosted project** that you create and delete afterwards.

Scripts: `src/probes/hosted/`. Edge Functions: `supabase/functions/hosted-probe` and `hosted-jwt-check`. Migration: `20261015110057_hosted_probe.sql` (one heartbeat table).

## What gets measured

| Question (local result) | Script | How |
|---|---|---|
| **Edge Function timeout:** locally the gateway answered **504 after 150 s** while the function **kept running** for minutes. Hosted? | `npm run hosted:timeout` (optional: `-- 300` for the long call's seconds; default 200) | `hosted-probe` sleeps 20 s, then 200 s, writing a heartbeat row every 5 s. The script records the status and time the caller got, then reads the heartbeats: did the function stop when the caller got its error, or keep going (and until when)? |
| **IP spoofing:** locally a client could prepend fake `X-Forwarded-For` entries; only the **last** entry (added by the proxy) is trusted. Hosted proxy chain? | `npm run hosted:ip` | 1. What `hosted-probe` receives with and without fake `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`. 2. The real per-IP booking limit (5) with a new fake IP on each of 10 bookings: does it still stop at 5, and how many distinct IP hashes did the database store? |
| **pg_net timeout:** locally the default **5 s** timeout lost requests to Edge Function cold starts, and a timed-out request could still have done its work. | `npm run hosted:pgnet` | A: 20 calls at once (run after ~10 min idle for cold starts), default timeout: how many time out? B: an 8 s call with the 5 s default: pg_net gives up, does the function still finish? C: the same with 15 s: succeeds. |
| The other *to verify* items: role behind `SUPABASE_DB_URL`, `cron.timezone`, pgaudit, pg_net grants, what the built-in Edge Function JWT check lets through | `npm run hosted:facts` | Queries + one request per credential type to `hosted-jwt-check` (built-in JWT check **on**). Prints NOTE lines with the local value next to each. |
| The security scan, on the real platform | `npm run hosted:scan` | The same exposure scan as locally (every table, function, Edge Function, Storage, GraphQL), with the probe-only objects expected closed. Hosted projects usually have **GraphQL** switched on; the scan checks it shows the public key no more than REST does. |

**Deliberately not run on the hosted project:** the SQL-injection proof (it shows Postgres behaviour, which is the same everywhere, and would open an injectable function on the internet), the spam flood, DocuSign and reminders (no real emails or envelopes from a test project).

## Probe-only objects: excluded or locked (checked before every script)

`supabase db push` applies **all** migrations, so the hosted schema matches the local one (needed for a fair comparison; skipping single migrations would break the ones after them). Right after the push, `npm run hosted:lockdown` runs `src/probes/hosted/sql/lockdown.sql` on the **hosted** database:

| Object | Local | Hosted |
|---|---|---|
| `sqli_search_bookings_unsafe` (DEFINER) and `…_unsafe_invoker` | exist, locked (no grant + 2-minute switch) | **dropped** |
| `sqli_probe_switch` | off | off (checked) |
| `audit_log_client` (audit stage 1, deliberately forgeable) | anyone may insert | **closed**: policy dropped, all grants revoked |
| Scheduled jobs (DocuSign retry/expiry, reminders) | as built | **unscheduled**, except `rate-limit-cleanup` (deletes IP hashes after a day) |
| Edge Functions | 12 | **only `hosted-probe` and `hosted-jwt-check` deployed**; `hosted-probe` needs a secret token |

`npm run hosted:preflight` then confirms all of it **in the database and through the public API** (unsafe functions → 404, insert into `audit_log_client` refused, the 10 app functions → 404 not deployed, `hosted-probe` → 401 without the token). **Every other hosted script re-checks the database part first and refuses to run** if anything is open again.

## Setup (about 20 minutes, once)

1. **Create a project** at https://supabase.com/dashboard (free plan, any region). Note the **database password** you choose.
2. **Auth settings** (dashboard → Authentication → Sign In / Providers → Email): switch **"Confirm email" off**. The scan and `hosted:facts` sign up throwaway `@test.dev` users and need a session straight away. (Our `config.toml` auth settings are not pushed to hosted projects.)
3. **Link and push** (the CLI asks you to log in once; the project ref is in the dashboard URL):
   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>      # asks for the database password
   npx supabase db push                               # all migrations
   ```
   If a migration fails on the hosted platform, **stop and record it** (migration, error) in FRICTION_LOG: that is a finding too.
4. **Secrets file:** `cp .env.hosted.example .env.hosted` and fill it in (dashboard → Connect: the **Session pooler** string, because the direct connection is IPv6-only on the free plan; Project Settings → API keys: the publishable key). Pick a long random `HOSTED_PROBE_TOKEN` (e.g. `openssl rand -hex 24`).
5. **Lock down, then deploy only the two check functions:**
   ```bash
   npm run hosted:lockdown
   npx supabase secrets set HOSTED_PROBE_TOKEN=<the same token>
   npx supabase functions deploy hosted-probe hosted-jwt-check
   npm run hosted:preflight                           # must end with "All preflight checks passed"
   ```

**Secrets stay out of git:** `.env.hosted` is git-ignored (check with `git check-ignore -v .env.hosted`), the CLI keeps the project link in `supabase/.temp/` (git-ignored), the token lives in `.env.hosted` and in the project's secrets only, and the scripts never print the database URL. Don't paste the publishable key, token or password into FRICTION_LOG / BLOG_REPORT; the outputs below contain none of them.

## Running (about 30 minutes)

```bash
npm run hosted:facts
npm run hosted:scan
npm run hosted:ip
npm run hosted:timeout          # ~6–10 min (waits for heartbeats to stop)
# wait ~10 minutes without calling anything, so the next run includes cold starts:
npm run hosted:pgnet
```

Save each output like the local evidence (the evidence script doesn't know the hosted env file, so redirect by hand):
```bash
npm run -s hosted:timeout 2>&1 | tee evidence/$(date +%F_%H%M)_hosted-timeout.txt
```

## Recording the results

For each script, copy the NOTE / PASS / FAIL lines into a new FRICTION_LOG section "Hosted checks", and update BLOG_REPORT.md:
- section 9, "To verify before publishing": move each item to *verified on hosted (date)* with the hosted value, or keep it with what was found;
- features 3 (IP headers), 4 (pg_net), 5 (Edge Function limits) and 1 (database role): add the hosted value next to the local one.
Where hosted and local differ, say so plainly; that difference is the finding.

## Tear down

Dashboard → Project Settings → General → **Pause** or **Delete project**. Then delete `.env.hosted` (or blank the password and token), and run `npx supabase unlink` so a later `db push` can't hit it by accident.
