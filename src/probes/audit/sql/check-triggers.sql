-- Stage 2: paste into Supabase Studio → SQL Editor after using /probes/audit (or any page).
-- Studio runs as the database owner, so nothing is hidden by RLS.
-- Note: queries you run here that CHANGE data are logged too, as actor "postgres".

-- 1. The trigger-written log, newest first. tx_id groups entries from one transaction.
select created_at, actor_role, actor_id, action, record_id, host_id, changes, tx_id
  from public.audit_log
 order by created_at desc;

-- 2. Stage 1 vs stage 2: every booking on the test host's slots, and which log knows about it.
select sl.starts_at,
       b.guest_name,
       b.status,
       exists (select 1 from public.audit_log_client a
                where a.action = 'booking.created'
                  and a.changes ->> 'slot_id' = b.slot_id::text
                  and a.changes ->> 'guest_name' = b.guest_name) as in_browser_log,
       exists (select 1 from public.audit_log a
                where a.action = 'booking.created' and a.record_id = b.id) as in_trigger_log
  from public.bookings b
  join public.slots sl on sl.id = b.slot_id
 where sl.host_id = '11111111-1111-4111-8111-111111111111'
 order by sl.starts_at, b.created_at;

-- 3. Trigger-log entries describing bookings that don't exist. Expected: none.
--    (Stage 1's equivalent query in check.sql finds ghost and forged entries.)
select a.created_at, a.action, a.record_id
  from public.audit_log a
 where a.action = 'booking.created'
   and not exists (select 1 from public.bookings b where b.id = a.record_id);
