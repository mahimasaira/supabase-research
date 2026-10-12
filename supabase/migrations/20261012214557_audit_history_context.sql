-- Advanced feature 2, stage 4: context for the host's history page.
--
-- A booking entry only stored slot_id. Once that slot is moved or deleted, the history
-- can't say WHICH time was booked anymore. Audit practice: record the context at the
-- moment the entry is written, not by looking it up later. So entries get a `context`
-- column, kept apart from `changes` ("what was this about" vs "what changed"):
--   booking  {slot_starts_at, slot_ends_at, guest_name}   (+ series_id, week_no if recurring)
--   slot     {starts_at, ends_at}                          (the slot's current/last time)
--   series   {weeks, weekday, start_time}
--   profile  {}
-- Older entries keep context = '{}'; the page falls back to what's in `changes`.

alter table public.audit_log add column context jsonb not null default '{}';

-- Same function as in 20261012160421_audit_log_triggers.sql, plus step 5 collecting context.
create or replace function public.audit_row_change()
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
  v_context jsonb := '{}';
  v_action  text;
  v_host    uuid;
  v_slot    record;
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

  -- 5. Whose page is this about, and the context to show it later.
  if v_entity = 'booking' then
    -- (If the slot was deleted in the same statement, e.g. a cascade, it can't be found:
    --  host_id stays null and the context has no slot time.)
    select s.host_id, s.starts_at, s.ends_at into v_slot
      from public.slots s where s.id = (v_row ->> 'slot_id')::uuid;
    v_host := v_slot.host_id;
    v_context := jsonb_strip_nulls(jsonb_build_object(
      'slot_starts_at', v_slot.starts_at,
      'slot_ends_at',   v_slot.ends_at,
      'guest_name',     v_row ->> 'guest_name',
      'series_id',      v_row ->> 'series_id',
      'week_no',        (v_row ->> 'week_no')::int));
  elsif v_entity = 'slot' then
    v_host := (v_row ->> 'host_id')::uuid;
    v_context := jsonb_build_object('starts_at', v_row -> 'starts_at', 'ends_at', v_row -> 'ends_at');
  elsif v_entity = 'series' then
    v_host := (v_row ->> 'host_id')::uuid;
    v_context := jsonb_build_object('weeks', v_row -> 'weeks', 'weekday', v_row -> 'weekday', 'start_time', v_row -> 'start_time');
  elsif v_entity = 'profile' then
    v_host := (v_row ->> 'id')::uuid;
  end if;

  insert into public.audit_log (actor_id, actor_role, action, table_name, record_id, host_id, changes, context)
  values (auth.uid(), coalesce(auth.role(), session_user), v_action, tg_table_name,
          (v_row ->> 'id')::uuid, v_host, v_changes, v_context);

  return null; -- AFTER trigger: the return value is ignored
end;
$$;

revoke execute on function public.audit_row_change() from public, anon, authenticated;
