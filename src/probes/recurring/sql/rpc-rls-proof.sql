-- Proof that book_recurring (SECURITY INVOKER) obeys RLS. Changes nothing: both parts roll back.
-- Run: psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f src/probes/recurring/sql/rpc-rls-proof.sql
-- (In Studio, run each part on its own.) Needs fresh seed data: npm run probe:recurring:seed

-- Part 1: as an anonymous guest, with the series insert policy removed.
-- Expected: ERROR 42501  new row violates row-level security policy for table "booking_series"
-- i.e. the function is subject to the guest's RLS policies.
begin;
drop policy "Anyone can create a booking series" on public.booking_series;
set local role anon;                -- the role every browser request without login uses
select public.book_recurring(
  '11111111-1111-4111-8111-111111111111',
  (select min(starts_at) from public.slots where host_id = '11111111-1111-4111-8111-111111111111'),
  2, 'RLS Proof', 'proof@example.com'
);
rollback;

-- Part 2, for contrast: same call, same missing policy, but as the database owner (postgres),
-- which bypasses RLS. Expected: success, returns {"seriesId": ..., "weeks": [...]}.
-- That's what SECURITY DEFINER (or an Edge Function connected as postgres) would do.
begin;
drop policy "Anyone can create a booking series" on public.booking_series;
select public.book_recurring(
  '11111111-1111-4111-8111-111111111111',
  (select min(starts_at) from public.slots where host_id = '11111111-1111-4111-8111-111111111111'),
  2, 'RLS Proof', 'proof@example.com'
);
rollback;
