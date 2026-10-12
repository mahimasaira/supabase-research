-- Advanced feature 1: recurring bookings (showcase for transactions).
--
-- A guest books the same weekly slot (same weekday + time) for N weeks. That creates:
--   1. one booking_series row
--   2. one booking per week, linked to the series (bookings.series_id + week_no)
--   3. each week's slot marked as taken: done by the existing sync_slot_is_booked
--      trigger, inside the same statement as each booking insert (clients can't
--      write slots.is_booked themselves).
-- Rule: all-or-nothing. Whether that rule actually holds depends on HOW the writes are
-- sent (stage 1: split browser calls, stage 2: rpc, stage 3: Edge Function).
--
-- Additive only: existing one-off bookings keep series_id/week_no = null and behave as before.
-- Weekday and time are stored in UTC for now; time zones are feature 6.

create table public.booking_series (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references public.profiles (id) on delete cascade,
  guest_name  text not null check (char_length(trim(guest_name)) between 1 and 100),
  guest_email text not null check (guest_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  weekday     smallint not null check (weekday between 0 and 6),   -- 0 = Sunday (UTC)
  start_time  time not null,                                        -- UTC
  weeks       smallint not null check (weeks between 2 and 12),
  created_at  timestamptz not null default now()
);

create index booking_series_host_idx on public.booking_series (host_id);

alter table public.booking_series enable row level security;

-- Link bookings to their series. Deleting a series removes its bookings
-- (and the slot trigger frees the slots again).
alter table public.bookings
  add column series_id uuid references public.booking_series (id) on delete cascade,
  add column week_no   smallint check (week_no between 1 and 12),
  -- Either both are set (part of a series) or neither (a one-off booking).
  add constraint bookings_series_week_together check ((series_id is null) = (week_no is null)),
  -- Each week of a series exists at most once.
  add constraint bookings_series_week_unique unique (series_id, week_no);

create index bookings_series_idx on public.bookings (series_id) where series_id is not null;

-- ---------------------------------------------------------------------------
-- Grants (same pattern as the core: revoke Supabase's wide defaults, add back columns).
-- ---------------------------------------------------------------------------
revoke all on public.booking_series from anon, authenticated;

-- Guests can create a series. They send the id themselves (generated in the browser),
-- because they can't read the row back afterwards (no SELECT policy for them).
grant insert (id, host_id, guest_name, guest_email, weekday, start_time, weeks)
  on public.booking_series to anon, authenticated;
grant select on public.booking_series to authenticated;

-- Guests may now also fill the two new booking columns.
grant insert (series_id, week_no) on public.bookings to anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Anyone may start a series. The column checks and the host_id foreign key validate it.
-- Rate limiting anonymous writes is feature 3.
create policy "Anyone can create a booking series"
  on public.booking_series for insert
  to anon, authenticated
  with check (true);

-- Hosts read series on their own page. Guests read nothing (same as bookings).
create policy "Hosts read their own booking series"
  on public.booking_series for select
  to authenticated
  using (host_id = (select auth.uid()));

-- No update/delete policies: a series is never edited or deleted by clients.
-- Booking inserts are still checked by the core "Anyone can book a free future slot" policy.
