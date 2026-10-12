-- Reset for the audit probe. `npm run probe:audit:seed` first runs the recurring seed
-- (test host, 6 Mondays, week 4 booked by "Someone Else"), then this file.
-- The log tables have no foreign keys (entries outlive what they describe), so deleting the
-- test host doesn't clear them; that's done here.
delete from public.audit_log_client;

select 'OK: audit log emptied' as status, (select count(*) from public.audit_log_client) as audit_log_client_rows;

-- Stage 2: the trigger-written log. Running the recurring seed just now (deleting and
-- recreating the test host) wrote entries here too; clear them for a clean start.
delete from public.audit_log;

select 'OK: trigger log emptied' as status, (select count(*) from public.audit_log) as audit_log_rows;

-- Stage 3: supa_audit's table (if installed).
do $$ begin
  if to_regclass('audit.record_version') is not null then truncate audit.record_version; end if;
end $$;
