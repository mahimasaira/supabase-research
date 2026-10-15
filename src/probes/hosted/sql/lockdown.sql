-- Run ONCE on the hosted project, right after `supabase db push` (npm run hosted:lockdown).
-- Never on the local database: the local proofs need these objects.
--
-- `db push` applies every migration, so the hosted schema matches the local one (needed for a
-- like-for-like comparison). Probe-only objects that are deliberately unsafe are then removed or
-- closed here, before the project is used. npm run hosted:preflight confirms the result.
\set ON_ERROR_STOP on
begin;

-- 1. SQL-injection probe: the two deliberately injectable functions are dropped (the injection
--    proof is never run on the hosted project; it only shows Postgres behaviour, not platform
--    behaviour). The safe version and the switch table stay; the switch stays off.
drop function if exists public.sqli_search_bookings_unsafe(text);
drop function if exists public.sqli_search_bookings_unsafe_invoker(text);
update public.sqli_probe_switch set unsafe_enabled_until = null where id = 1;

-- 2. Audit-log stage 1 table: deliberately forgeable (anyone may insert). Closed: no API role may
--    write or read it. (Kept, not dropped, so the schema stays comparable.)
drop policy if exists "Anyone can write client audit entries" on public.audit_log_client;
revoke all on public.audit_log_client from anon, authenticated;

-- 3. Scheduled jobs: nothing on the hosted project should send DocuSign envelopes or reminders.
--    Only the privacy job that deletes IP hashes after a day keeps running.
select cron.unschedule(jobname) from cron.job where jobname <> 'rate-limit-cleanup';

commit;

-- What's left, for the record.
select 'unsafe sqli functions' as what, count(*)::text as value
  from pg_proc where proname like 'sqli_search_bookings_unsafe%'
union all
select 'audit_log_client writable by anon/authenticated',
       (has_any_column_privilege('anon', 'public.audit_log_client', 'insert') or has_any_column_privilege('authenticated', 'public.audit_log_client', 'insert'))::text
union all
select 'cron jobs', string_agg(jobname, ', ') from cron.job;
