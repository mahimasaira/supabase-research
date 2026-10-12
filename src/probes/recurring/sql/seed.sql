-- Test data for the recurring-bookings probe. Safe to run again: it deletes and
-- recreates everything belonging to the test host, so it doubles as "reset".
-- Run: npm run probe:recurring:seed   (or paste into the Supabase Studio SQL editor)
--
-- Creates:
--   * a test host  recurring-host@test.dev / password123  (fixed id, the probe page uses it)
--   * 6 weekly slots: the next 6 Mondays, 10:00-10:30 UTC
--   * week 4 already booked by "Someone Else", so a 6-week series must clash in week 4
--
-- Runs as the database owner (postgres), so RLS doesn't apply here.

begin;

-- Removing the user cascades: auth.users → profiles → slots → bookings, and
-- profiles → booking_series. So every earlier probe run (including half-finished
-- series left behind by stage 1) is wiped. The confirmation at the end proves it.
delete from auth.users where id = '11111111-1111-4111-8111-111111111111';

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000', '11111111-1111-4111-8111-111111111111',
  'authenticated', 'authenticated', 'recurring-host@test.dev',
  extensions.crypt('password123', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{"display_name":"Recurring Test Host"}',
  now(), now(), '', '', '', ''
);

-- Needed so the test host can also log in with email + password.
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values (
  '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
  '{"sub":"11111111-1111-4111-8111-111111111111","email":"recurring-host@test.dev","email_verified":true}',
  'email', now(), now()
);
-- (The handle_new_user trigger has created the profile.)

-- Next 6 Mondays at 10:00 UTC. date_trunc('week') = this week's Monday 00:00,
-- + 7 days = next Monday, so week 1 is always in the future.
insert into public.slots (host_id, starts_at, ends_at)
select '11111111-1111-4111-8111-111111111111',
       monday + interval '10 hours',
       monday + interval '10 hours 30 minutes'
  from generate_series(1, 6) as w,
       lateral (select date_trunc('week', now() at time zone 'utc') at time zone 'utc'
                       + (w * interval '7 days') as monday) m;

-- Someone else already booked week 4. The slot trigger marks it is_booked = true.
insert into public.bookings (slot_id, guest_name, guest_email)
select id, 'Someone Else', 'someone@example.com'
  from public.slots
 where host_id = '11111111-1111-4111-8111-111111111111'
 order by starts_at
 offset 3 limit 1;

commit;

-- Confirmation. Expected: 6 slots, 5 free, 1 booking (Someone Else), 0 series.
select case when slots = 6 and free_slots = 5 and bookings = 1 and series = 0
            then 'OK: test host reset' else 'UNEXPECTED: check the counts' end as status,
       slots, free_slots, bookings, series
  from (select
          (select count(*) from public.slots where host_id = h.id)                         as slots,
          (select count(*) from public.slots where host_id = h.id and not is_booked)       as free_slots,
          (select count(*) from public.bookings b join public.slots s on s.id = b.slot_id
            where s.host_id = h.id)                                                        as bookings,
          (select count(*) from public.booking_series where host_id = h.id)                as series
          from (select '11111111-1111-4111-8111-111111111111'::uuid as id) h) c;

-- The 6 Mondays. starts_at is UTC; e.g. 10:00 UTC = 15:30 IST, same date.
select row_number() over (order by starts_at) as week, starts_at, is_booked
  from public.slots
 where host_id = '11111111-1111-4111-8111-111111111111'
 order by starts_at;
