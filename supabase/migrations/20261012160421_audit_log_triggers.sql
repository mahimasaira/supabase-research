-- Advanced feature 2, stage 2: the audit log is written by the DATABASE, with triggers.
--
-- A trigger runs inside Postgres on every insert/update/delete of a table, whoever made
-- the change and however it arrived (browser, rpc, Edge Function, Studio, cascades).
-- It writes the log entry in the SAME transaction as the change, so they are saved
-- together or not at all: a failed or rolled-back change leaves no entry.
--
-- Clients get NO insert rights on audit_log: only the trigger function can write to it.
-- (audit_log_client from stage 1 stays, so both can be compared.)

create table public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Who: from the caller's JWT. Without a JWT (Studio, psql, Supabase Auth itself) the
  -- database user is recorded instead (e.g. postgres, supabase_auth_admin), with no id.
  actor_id   uuid,
  actor_role text not null,
  action     text not null,          -- e.g. booking.created, booking.cancelled, slot.moved
  table_name text not null,
  record_id  uuid not null,          -- the real row id, even for guests
  host_id    uuid,                   -- whose slots/bookings this is about (decides who may read it)
  changes    jsonb not null default '{}',
  -- All entries written by one transaction share this number (e.g. a whole recurring booking).
  tx_id      bigint not null default txid_current()
);
-- No foreign keys on purpose: entries must outlive the rows (and users) they describe.

create index audit_log_host_idx on public.audit_log (host_id, created_at desc);

alter table public.audit_log enable row level security;

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

create policy "Hosts read audit entries about them"
  on public.audit_log for select
  to authenticated
  using (host_id = (select auth.uid()));

-- No insert/update/delete grants or policies for anyone: only the trigger writes here.

-- ---------------------------------------------------------------------------
-- "guest@example.com" → "g***@example.com"
-- ---------------------------------------------------------------------------
create function public.audit_mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_email like '%@%'
              then left(split_part(p_email, '@', 1), 1) || '***@' || split_part(p_email, '@', 2)
              else '***' end
$$;

-- ---------------------------------------------------------------------------
-- The trigger function, shared by all audited tables.
-- tg_argv[0] = entity name used in the action ('booking', 'slot', 'series', 'profile').
--
-- SECURITY DEFINER: runs as the owner, because the caller (a guest) has no right to
-- insert into audit_log. auth.uid()/auth.role() still read the CALLER's JWT claims,
-- which are a session setting, not tied to the current database user.
-- ---------------------------------------------------------------------------
create function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity  text := tg_argv[0];
  v_old     jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new     jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row     jsonb := coalesce(v_new, v_old);
  v_changes jsonb := '{}';
  v_action  text;
  v_host    uuid;
  k         text;
begin
  -- 1. What changed. Created/deleted: the whole row. Updated: only changed fields, as {from, to}.
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if v_new -> k is distinct from v_old -> k then
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k));
      end if;
    end loop;
  else
    v_changes := jsonb_strip_nulls(v_row); -- empty fields are noise
  end if;

  -- 2. Leave out secrets and noise. is_booked is derived from bookings (the booking's own
  --    entry already says what happened), so a slot update that only flips it isn't logged.
  v_changes := v_changes - 'cancel_token' - 'id' - 'created_at' - 'is_booked';
  if tg_op = 'UPDATE' and v_changes = '{}' then
    return null;
  end if;

  -- 3. Mask guest emails (a plain string, or {from, to} on updates).
  if jsonb_typeof(v_changes -> 'guest_email') = 'string' then
    v_changes := jsonb_set(v_changes, '{guest_email}', to_jsonb(public.audit_mask_email(v_changes ->> 'guest_email')));
  elsif jsonb_typeof(v_changes -> 'guest_email') = 'object' then
    v_changes := jsonb_set(v_changes, '{guest_email}', jsonb_build_object(
      'from', public.audit_mask_email(v_changes -> 'guest_email' ->> 'from'),
      'to',   public.audit_mask_email(v_changes -> 'guest_email' ->> 'to')));
  end if;

  -- 4. Name the action.
  v_action := v_entity || '.' || case
    when tg_op = 'INSERT' then 'created'
    when tg_op = 'DELETE' then 'deleted'
    when v_entity = 'booking' and v_changes -> 'status' ->> 'to' = 'cancelled' then 'cancelled'
    when v_entity = 'slot' and (v_changes ? 'starts_at' or v_changes ? 'ends_at') then 'moved'
    else 'updated'
  end;

  -- 5. Whose page is this about?
  v_host := case v_entity
    when 'slot'    then (v_row ->> 'host_id')::uuid
    when 'series'  then (v_row ->> 'host_id')::uuid
    when 'profile' then (v_row ->> 'id')::uuid
    -- A booking belongs to its slot's host. (If the slot was deleted in the same statement,
    -- e.g. a cascade, it can't be found anymore and host_id stays null.)
    when 'booking' then (select s.host_id from public.slots s where s.id = (v_row ->> 'slot_id')::uuid)
  end;

  insert into public.audit_log (actor_id, actor_role, action, table_name, record_id, host_id, changes)
  values (auth.uid(), coalesce(auth.role(), session_user), v_action, tg_table_name,
          (v_row ->> 'id')::uuid, v_host, v_changes);

  return null; -- AFTER trigger: the return value is ignored
end;
$$;

-- AFTER triggers: they only run once the change itself has succeeded.
create trigger audit_bookings       after insert or update or delete on public.bookings
  for each row execute function public.audit_row_change('booking');
create trigger audit_slots          after insert or update or delete on public.slots
  for each row execute function public.audit_row_change('slot');
create trigger audit_booking_series after insert or update or delete on public.booking_series
  for each row execute function public.audit_row_change('series');
create trigger audit_profiles       after insert or update or delete on public.profiles
  for each row execute function public.audit_row_change('profile');

-- Nobody calls these directly (PostgREST would otherwise expose them as rpc endpoints).
revoke execute on function public.audit_row_change() from public, anon, authenticated;
revoke execute on function public.audit_mask_email(text) from public, anon, authenticated;
