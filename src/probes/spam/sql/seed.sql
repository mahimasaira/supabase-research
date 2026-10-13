-- Test data for the spam-protection probe (feature 3). Safe to run again: it deletes and
-- recreates everything belonging to the spam test host, so it doubles as "reset".
-- Run: npm run probe:spam:seed
--
-- A separate host, so floods never touch the recurring/audit/DocuSign test host or real data:
--   * spam-host@test.dev / password123  (fixed id 22222222-…)
--   * 50 free slots: the next 10 days, 09:00–14:00 UTC, one per hour
--   * require_signature off (the flood script switches it on for round D)
-- Runs as the database owner (postgres), so RLS doesn't apply here.

begin;

-- Cascades to profile, slots, bookings. Log entries have no foreign keys, so remove them too.
delete from auth.users where id = '22222222-2222-4222-8222-222222222222';
delete from public.audit_log where host_id = '22222222-2222-4222-8222-222222222222';

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000', '22222222-2222-4222-8222-222222222222',
  'authenticated', 'authenticated', 'spam-host@test.dev',
  extensions.crypt('password123', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{"display_name":"Spam Test Host"}',
  now(), now(), '', '', '', ''
);

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values (
  '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222',
  '{"sub":"22222222-2222-4222-8222-222222222222","email":"spam-host@test.dev","email_verified":true}',
  'email', now(), now()
);

-- 10 days × 5 hours = 50 slots, starting tomorrow (UTC), so all are in the future.
insert into public.slots (host_id, starts_at, ends_at)
select '22222222-2222-4222-8222-222222222222', t, t + interval '45 minutes'
  from generate_series(1, 10) as d,
       generate_series(9, 13) as h,
       lateral (select ((current_date + d) + make_interval(hours => h)) at time zone 'UTC' as t) x;

commit;

select case when (select count(*) from public.slots where host_id = '22222222-2222-4222-8222-222222222222') = 50
            then 'OK: spam host reset (50 free slots)' else 'UNEXPECTED: check the slots' end as status;
