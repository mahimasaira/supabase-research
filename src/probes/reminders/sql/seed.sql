-- Test data for the bulk-reminders probe (feature 5). Safe to run again: it deletes and
-- recreates everything belonging to the reminder test host, so it doubles as "reset".
-- Run: npm run probe:reminders:seed
--
--   * reminder-host@test.dev / password123  (fixed id 33333333-…)
--   * 200 confirmed bookings starting in ~24 hours (23 h 30 min … 24 h 10 min from now),
--     guests guest-001@reminder-test.example … guest-200@… (made-up; all mail goes to Mailpit)
-- Runs as the database owner. The spam-protection limits (feature 3) apply to every insert,
-- including this one, so they're lifted inside this transaction and restored before commit.

begin;

delete from auth.users where id = '33333333-3333-4333-8333-333333333333';
delete from public.audit_log where host_id = '33333333-3333-4333-8333-333333333333';

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000', '33333333-3333-4333-8333-333333333333',
  'authenticated', 'authenticated', 'reminder-host@test.dev',
  extensions.crypt('password123', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{"display_name":"Reminder Test Host"}',
  now(), now(), '', '', '', ''
);
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values (
  '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333',
  '{"sub":"33333333-3333-4333-8333-333333333333","email":"reminder-host@test.dev","email_verified":true}',
  'email', now(), now()
);

-- 200 short slots, 12 seconds apart, starting 23 h 30 min from now (inside the 23–25 h window).
insert into public.slots (host_id, starts_at, ends_at)
select '33333333-3333-4333-8333-333333333333',
       date_trunc('minute', now()) + interval '23 hours 30 minutes' + n * interval '12 seconds',
       date_trunc('minute', now()) + interval '23 hours 30 minutes' + n * interval '12 seconds' + interval '10 seconds'
  from generate_series(0, 199) n;

-- Lift the booking limits for this transaction only (restored below, before commit).
create temporary table saved_limits on commit drop as select * from public.rate_limit_settings;
update public.rate_limit_settings set max_active_per_email = 100000, max_per_host = 100000, max_per_ip = 100000;

insert into public.bookings (slot_id, guest_name, guest_email)
select s.id,
       'Guest ' || lpad(row_number() over (order by s.starts_at)::text, 3, '0'),
       'guest-' || lpad(row_number() over (order by s.starts_at)::text, 3, '0') || '@reminder-test.example'
  from public.slots s
 where s.host_id = '33333333-3333-4333-8333-333333333333';

update public.rate_limit_settings r set
  max_active_per_email = s.max_active_per_email, max_per_host = s.max_per_host, max_per_ip = s.max_per_ip
  from saved_limits s where r.id = s.id;
delete from public.booking_rate_events where host_id = '33333333-3333-4333-8333-333333333333';

-- Stage 2: an empty queue and dead-letter archive (if the queue exists).
do $$ begin
  if exists (select 1 from pgmq.list_queues() where queue_name = 'reminders') then
    perform pgmq.purge_queue('reminders');
    delete from pgmq.a_reminders;
  end if;
exception when invalid_schema_name or undefined_function then null; -- pgmq not installed (stage 1)
end $$;

commit;

select case when (select count(*) from public.bookings b join public.slots s on s.id = b.slot_id
                   where s.host_id = '33333333-3333-4333-8333-333333333333' and b.status = 'confirmed') = 200
            then 'OK: reminder host reset (200 bookings in ~24 h)' else 'UNEXPECTED: check the bookings' end as status;
