-- Advanced feature 4 (DocuSign e-signature), stage 1: bookings that wait for a signature.
-- No DocuSign calls yet: this stage adds the state the integration will drive.
--
-- A host can switch on "require a signed agreement" (profiles.require_signature). Then a new
-- booking on their page starts as 'pending_signature' instead of 'confirmed'. It already
-- HOLDS the slot (nobody else can book it), and becomes 'confirmed' once the guest has
-- signed (stage 3) or 'cancelled' if they decline / never sign (stage 4).
-- Hosts who don't opt in: nothing changes.

-- ---------------------------------------------------------------------------
-- Host setting
-- ---------------------------------------------------------------------------
alter table public.profiles add column require_signature boolean not null default false;
-- Covered by the existing "Hosts update their own profile" RLS policy.
grant update (require_signature) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- New booking state + what the integration will record
-- ---------------------------------------------------------------------------
alter table public.bookings drop constraint bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('confirmed', 'pending_signature', 'cancelled'));

alter table public.bookings
  -- Where the signing process is. Set by the database and (later) by the Edge Functions,
  -- never by clients: there is no grant on these columns.
  add column signature_status     text check (signature_status in ('pending', 'sent', 'completed', 'declined', 'voided', 'failed')),
  add column envelope_id          text unique,          -- DocuSign's id for the sent agreement
  add column signature_error      text,                 -- last error from DocuSign, if any
  add column signature_updated_at timestamptz;

-- A waiting booking holds the slot just like a confirmed one.
-- Replaces the core index "at most one CONFIRMED booking per slot".
drop index public.bookings_one_confirmed_per_slot;
create unique index bookings_one_active_per_slot
  on public.bookings (slot_id)
  where status in ('confirmed', 'pending_signature');

-- Same function as in the core schema, with pending_signature counting as "booked".
create or replace function public.sync_slot_is_booked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.slots s
     set is_booked = exists (
       select 1 from public.bookings b
        where b.slot_id = s.id and b.status in ('confirmed', 'pending_signature')
     )
   where s.id = coalesce(new.slot_id, old.slot_id);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- New bookings on an opt-in host's page start as pending_signature.
-- Clients can't send a status (no insert grant on it), so the default 'confirmed'
-- is replaced here. SECURITY DEFINER: reads the host's setting regardless of the caller.
-- ---------------------------------------------------------------------------
create function public.bookings_apply_signature_requirement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.slots s join public.profiles p on p.id = s.host_id
     where s.id = new.slot_id and p.require_signature
  ) then
    new.status := 'pending_signature';
    new.signature_status := 'pending';
    new.signature_updated_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.bookings_apply_signature_requirement() from public, anon, authenticated;

create trigger bookings_apply_signature_requirement
  before insert on public.bookings
  for each row execute function public.bookings_apply_signature_requirement();

-- ---------------------------------------------------------------------------
-- Cancelling works for waiting bookings too (host and guest).
-- ---------------------------------------------------------------------------
drop policy "Hosts cancel bookings on their slots" on public.bookings;
create policy "Hosts cancel bookings on their slots"
  on public.bookings for update
  to authenticated
  using (
    status in ('confirmed', 'pending_signature')
    and exists (
      select 1 from public.slots s
       where s.id = slot_id and s.host_id = (select auth.uid())
    )
  )
  with check (status = 'cancelled');

create or replace function public.cancel_booking(p_cancel_token uuid)
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
     and b.status in ('confirmed', 'pending_signature')
     and s.id = b.slot_id
     and s.starts_at > now();      -- can't cancel a slot that has already started
  get diagnostics v_updated = row_count;
  return v_updated = 1;            -- false = unknown token, already cancelled, or too late
end;
$$;
