-- Step 2: core schema for the booking app.
-- Tables: profiles (one per host), slots (time windows a host offers), bookings (a guest claiming a slot).
-- RLS is switched ON for every table here with NO policies yet, which means "deny everything"
-- for the anon/authenticated API roles. Step 4 adds the policies that open up exactly what's needed.

-- btree_gist lets us mix "=" (on host_id) and "&&" (range overlap) in one exclusion constraint.
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- profiles: public info about a host. Its id IS the auth user's id (1:1 with auth.users).
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  avatar_path  text,                       -- path inside the storage bucket (step 7)
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Create a profile row automatically whenever someone signs up.
-- security definer = runs with the function owner's rights, because the sign-up request
-- itself has no permission to write to public.profiles.
-- search_path = '' forces fully-qualified names, so nobody can hijack it with a lookalike table.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- slots: a one-off time window a host offers.
-- ---------------------------------------------------------------------------
create table public.slots (
  id         uuid primary key default gen_random_uuid(),
  host_id    uuid not null references public.profiles (id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  -- Derived from bookings by the trigger below; never set by clients (enforced in step 4).
  -- It exists because guests aren't allowed to read bookings, but still need to know
  -- which slots are free, and Realtime (step 6) needs a change on *this* table to broadcast.
  is_booked  boolean not null default false,
  created_at timestamptz not null default now(),

  constraint slot_ends_after_start check (ends_at > starts_at),
  -- A host can't offer two overlapping slots.
  constraint slot_no_overlap exclude using gist (
    host_id with =,
    tstzrange(starts_at, ends_at) with &&
  )
);

create index slots_host_starts_idx on public.slots (host_id, starts_at);

alter table public.slots enable row level security;

-- ---------------------------------------------------------------------------
-- bookings: a guest (no account) booking a slot.
-- ---------------------------------------------------------------------------
create table public.bookings (
  id           uuid primary key default gen_random_uuid(),
  slot_id      uuid not null references public.slots (id) on delete cascade,
  guest_name   text not null check (char_length(trim(guest_name)) between 1 and 100),
  guest_email  text not null check (guest_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  status       text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  -- Secret the guest gets back after booking; proves they're allowed to cancel (step 4/5).
  cancel_token uuid not null default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz
);

-- THE double-booking rule: at most one *confirmed* booking per slot.
-- Partial unique index, so a cancelled booking doesn't block someone else from rebooking.
-- Two simultaneous inserts for the same slot: Postgres lets exactly one win, the other
-- gets error 23505 (unique_violation). No UI check can give that guarantee.
create unique index bookings_one_confirmed_per_slot
  on public.bookings (slot_id)
  where status = 'confirmed';

alter table public.bookings enable row level security;

-- Keep slots.is_booked in sync with bookings.
-- security definer because the guest who inserts a booking won't have rights to update slots.
create function public.sync_slot_is_booked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.slots s
     set is_booked = exists (
       select 1 from public.bookings b
        where b.slot_id = s.id and b.status = 'confirmed'
     )
   where s.id = coalesce(new.slot_id, old.slot_id);
  return null;
end;
$$;

create trigger bookings_sync_slot
  after insert or update of status or delete on public.bookings
  for each row execute function public.sync_slot_is_booked();
