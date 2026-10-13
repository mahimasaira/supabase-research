-- Advanced feature 5 (bulk reminders), stage 2: Supabase Queues (pgmq).
-- Stage 1 (src/probes/reminders/naive.mjs) showed the naive loop reminds guests twice after a
-- crash, a timeout or an overlapping run, and loses track when a call is cut off.
--
-- Now two steps, connected by a queue:
--   1. enqueue_reminders() (hourly): one queue message per due reminder. The booking is marked
--      reminder_queued_at IN THE SAME TRANSACTION (pgmq is just tables in Postgres), so an
--      overlapping or repeated run can't queue anyone twice.
--   2. process-reminders (Edge Function, every minute): reads small batches. pgmq hides a read
--      message from other workers for `vt` seconds (visibility timeout), so overlapping workers
--      never get the same one. After sending, "mark as sent + delete the message" is one
--      transaction. A message that isn't deleted (crash, error) reappears after vt: retried.
--      After 5 reads it's moved to the archive (dead letter). The function stops itself after a
--      time budget, so it never runs into the Edge Function limits; the next run continues.
-- The stage 1 function and job stay, so the stage 1 demonstration still works.

create extension if not exists pgmq;
select pgmq.create('reminders');

alter table public.bookings add column reminder_queued_at timestamptz;

-- Step 1. p_host_id limits it to one host (used by the probe scripts).
create function public.enqueue_reminders(p_host_id uuid default null)
returns int  -- messages queued
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queued int;
begin
  with due as (
    select b.id
      from public.bookings b join public.slots s on s.id = b.slot_id
     where b.status = 'confirmed'
       and b.reminder_sent_at is null
       and b.reminder_queued_at is null
       and s.starts_at between now() + interval '23 hours' and now() + interval '25 hours'
       and (p_host_id is null or s.host_id = p_host_id)
       for update of b skip locked          -- a parallel run skips rows this one is queuing
  ), marked as (
    update public.bookings set reminder_queued_at = now() where id in (select id from due) returning id
  )
  select count(*) into v_queued from marked, lateral pgmq.send('reminders', jsonb_build_object('booking_id', marked.id));
  return v_queued;
end;
$$;

-- Step 2 is the Edge Function process-reminders; this is how the scheduler calls it.
-- p_body: options ({"budgetMs", "batch", "vt", …}); empty for a normal run.
create function public.process_reminders(p_body jsonb default '{}')
returns bigint
language sql
security definer
set search_path = ''
as $$
  select public.invoke_edge_function('reminders_queue_url', p_body)
$$;

revoke execute on function public.enqueue_reminders(uuid) from public, anon, authenticated;
revoke execute on function public.process_reminders(jsonb) from public, anon, authenticated;

-- Schedules. Created SWITCHED OFF (like stage 1): the probe scripts trigger runs themselves.
-- In production: select cron.alter_job(jobid, active := true) from cron.job where jobname in (…).
select cron.schedule('enqueue-reminders', '0 * * * *', 'select public.enqueue_reminders()');
select cron.schedule('process-reminders', '* * * * *', 'select public.process_reminders()');
select cron.alter_job(jobid, active := false) from cron.job where jobname in ('enqueue-reminders', 'process-reminders');
