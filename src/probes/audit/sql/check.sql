-- Paste into Supabase Studio → SQL Editor after using /probes/audit.
-- Studio runs as the database owner, so it sees reality AND the log, unfiltered by RLS.

-- 1. What the log says (newest first).
select created_at, actor_role, actor_id, action, table_name, record_id, changes
  from public.audit_log_client
 order by created_at desc;

-- 2. Reality → log: every booking on the test host's slots, and whether the log knows about it.
--    created_logged = false: a booking nobody logged (skipped, other path, or a lost log request).
select sl.starts_at,
       b.guest_name,
       b.status,
       b.series_id is not null as from_recurring,
       exists (select 1 from public.audit_log_client a
                where a.action = 'booking.created'
                  and a.changes ->> 'slot_id' = b.slot_id::text
                  and a.changes ->> 'guest_name' = b.guest_name)               as created_logged,
       case when b.status = 'cancelled' then
         exists (select 1 from public.audit_log_client a
                  where a.action = 'booking.cancelled'
                    and (a.record_id = b.id or a.changes ->> 'slot_id' = b.slot_id::text))
       end                                                                      as cancel_logged
  from public.bookings b
  join public.slots sl on sl.id = b.slot_id
 where sl.host_id = '11111111-1111-4111-8111-111111111111'
 order by sl.starts_at, b.created_at;

-- 3. Log → reality: entries describing things that did NOT happen
--    (log-first + failed action, or forged entries).
select a.created_at, a.actor_role, a.action, a.changes, 'no such booking' as problem
  from public.audit_log_client a
 where a.action = 'booking.created'
   and not exists (select 1 from public.bookings b
                    where b.slot_id::text = a.changes ->> 'slot_id'
                      and b.guest_name = a.changes ->> 'guest_name')
union all
select a.created_at, a.actor_role, a.action, a.changes, 'slot still exists'
  from public.audit_log_client a
 where a.action = 'slot.deleted'
   and exists (select 1 from public.slots s where s.id = a.record_id)
 order by 1 desc;
