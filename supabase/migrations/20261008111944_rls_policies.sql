-- Step 4: who may do what.
--
-- Two layers work together:
--   1. GRANTs decide which *operations and columns* a role may touch at all.
--      Supabase grants anon/authenticated ALL privileges on new public tables by default,
--      so we revoke and re-grant column by column. RLS can't do this: it filters rows, not columns.
--   2. RLS POLICIES decide which *rows* those operations apply to.
--      `using (...)`      = which existing rows are visible / targetable (select, update, delete)
--      `with check (...)` = what the row must look like after insert/update
-- Roles: `anon` = no login (guests), `authenticated` = logged-in host.
-- `(select auth.uid())` = id of the logged-in user from the JWT (wrapped in select so
-- Postgres evaluates it once per query, not once per row).

-- ---------------------------------------------------------------------------
-- Grants: start from nothing, add back what's needed.
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.slots, public.bookings from anon, authenticated;

-- profiles: anyone can read (name + avatar for the booking page), hosts edit 2 columns.
grant select on public.profiles to anon, authenticated;
grant update (display_name, avatar_path) on public.profiles to authenticated;

-- slots: anyone can read (rows filtered by RLS); hosts create/move/delete their own.
-- is_booked is deliberately NOT writable by anyone; only the trigger changes it.
grant select on public.slots to anon, authenticated;
grant insert (host_id, starts_at, ends_at) on public.slots to authenticated;
grant update (starts_at, ends_at) on public.slots to authenticated;
grant delete on public.slots to authenticated;

-- bookings: anyone may insert these 4 columns. status/id/created_at come from defaults.
-- Only hosts can select, and only hosts can update, and only the status column.
grant insert (slot_id, guest_name, guest_email, cancel_token) on public.bookings to anon, authenticated;
grant select on public.bookings to authenticated;
grant update (status) on public.bookings to authenticated;

-- A guest generates the cancel token in the browser (see friction log), so make sure it's unique.
alter table public.bookings add constraint bookings_cancel_token_key unique (cancel_token);

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- Public read: profiles only hold display_name + avatar_path (no email), and the
-- public booking page must show whose page it is.
create policy "Profiles are publicly readable"
  on public.profiles for select
  to anon, authenticated
  using (true);

create policy "Hosts update their own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No insert policy: the handle_new_user trigger creates profiles.
-- No delete policy: profiles are removed by cascade when the auth user is deleted.

-- ---------------------------------------------------------------------------
-- slots
-- ---------------------------------------------------------------------------
-- Guests (and anyone else) see only free, future slots.
create policy "Anyone can read free future slots"
  on public.slots for select
  to anon, authenticated
  using (not is_booked and starts_at > now());

-- Hosts additionally see all of their own slots, booked and past included.
-- (Multiple permissive policies are OR-ed together.)
create policy "Hosts read their own slots"
  on public.slots for select
  to authenticated
  using (host_id = (select auth.uid()));

create policy "Hosts create their own future slots"
  on public.slots for insert
  to authenticated
  with check (host_id = (select auth.uid()) and starts_at > now());

-- Moving a slot is only allowed while nobody has booked it.
create policy "Hosts move their own unbooked slots"
  on public.slots for update
  to authenticated
  using (host_id = (select auth.uid()) and not is_booked)
  with check (host_id = (select auth.uid()) and starts_at > now());

-- Deleting a booked slot would silently cascade-delete the guest's booking, so block it.
-- The host must cancel the booking first.
create policy "Hosts delete their own unbooked slots"
  on public.slots for delete
  to authenticated
  using (host_id = (select auth.uid()) and not is_booked);

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------
-- Anyone may book a slot that is free and in the future. status is not in the insert
-- grant, so it always takes the default 'confirmed'. The double-booking race is still
-- settled by the unique index from step 2; this check just gives a cleaner rule.
create policy "Anyone can book a free future slot"
  on public.bookings for insert
  to anon, authenticated
  with check (
    exists (
      select 1 from public.slots s
       where s.id = slot_id
         and not s.is_booked
         and s.starts_at > now()
    )
  );

-- Hosts see bookings on their own slots. Guests have NO select policy: they can never
-- read bookings, not even their own (they have no identity to match on).
create policy "Hosts read bookings on their slots"
  on public.bookings for select
  to authenticated
  using (
    exists (
      select 1 from public.slots s
       where s.id = slot_id and s.host_id = (select auth.uid())
    )
  );

-- Hosts can cancel (and only cancel) bookings on their own slots.
create policy "Hosts cancel bookings on their slots"
  on public.bookings for update
  to authenticated
  using (
    status = 'confirmed'
    and exists (
      select 1 from public.slots s
       where s.id = slot_id and s.host_id = (select auth.uid())
    )
  )
  with check (status = 'cancelled');

-- No delete policy: bookings are never deleted, only cancelled.

-- Stamp cancelled_at in the database, so clients don't need (or get) write access to it.
create function public.set_cancelled_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new.cancelled_at := now();
  end if;
  return new;
end;
$$;

create trigger bookings_set_cancelled_at
  before update of status on public.bookings
  for each row execute function public.set_cancelled_at();

-- ---------------------------------------------------------------------------
-- Guest cancellation: an RPC, because RLS can't express it.
-- A guest has no login, so there's no auth.uid() to match. Their proof is the
-- cancel_token they generated when booking. An RLS update policy would need to
-- compare a column against a value the client sends, and there's no clean way
-- to pass that into a policy. A security definer function takes the token as an
-- argument and does the check itself.
-- Called from the browser as: supabase.rpc('cancel_booking', { p_cancel_token })
-- ---------------------------------------------------------------------------
create function public.cancel_booking(p_cancel_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated int;
begin
  update public.bookings b
     set status = 'cancelled'
    from public.slots s
   where b.cancel_token = p_cancel_token
     and b.status = 'confirmed'
     and s.id = b.slot_id
     and s.starts_at > now();      -- can't cancel a slot that has already started
  get diagnostics v_updated = row_count;
  return v_updated = 1;            -- false = unknown token, already cancelled, or too late
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges. Postgres lets everyone execute new functions by default,
-- and PostgREST exposes every function in `public` as /rest/v1/rpc/<name>.
-- Lock down everything, then allow only the one RPC that's meant to be called.
-- ---------------------------------------------------------------------------
revoke execute on function public.handle_new_user()      from public, anon, authenticated;
revoke execute on function public.sync_slot_is_booked()  from public, anon, authenticated;
revoke execute on function public.set_cancelled_at()     from public, anon, authenticated;
revoke execute on function public.cancel_booking(uuid)   from public, anon, authenticated;
grant  execute on function public.cancel_booking(uuid)   to anon, authenticated;
