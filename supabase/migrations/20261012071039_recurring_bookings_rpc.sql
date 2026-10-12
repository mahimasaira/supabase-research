-- Advanced feature 1, stage 2: recurring booking as ONE Postgres function, called from
-- the browser with supabase.rpc('book_recurring', {...}).
--
-- Why this fixes stage 1: an rpc call is a single HTTP request, and PostgREST runs the
-- whole function inside one transaction. If anything fails (we RAISE an exception),
-- Postgres undoes every write the function already made: series, weeks 1-3, slot flags.
--
-- SECURITY INVOKER (the default, spelled out here): the function runs with the CALLER's
-- rights. For an anonymous guest that's the `anon` role, so the same grants and RLS
-- policies as in stage 1 apply inside the function: it only sees free future slots, and
-- the "Anyone can book a free future slot" policy still checks every booking.
-- (SECURITY DEFINER would run as the function owner and skip RLS entirely.)
--
-- Errors the client can recognise (custom SQLSTATE codes, passed through by PostgREST):
--   RB001  a week is not available   detail = {"week": 4, "starts_at": "..."}
--   RB002  host offers fewer weeks   detail = {"requested": 6, "available": 2}
-- Both are raised, never returned: a normal RETURN would COMMIT the writes made so far.

create function public.book_recurring(
  p_host_id         uuid,
  p_first_starts_at timestamptz,
  p_weeks           int,
  p_guest_name      text,
  p_guest_email     text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- One week = exactly 168 hours on the UTC timeline, the same as WEEK_MS in split.js.
  -- (interval '7 days' would follow the session time zone's DST rules.)
  c_week      constant interval := interval '168 hours';
  v_series_id uuid := gen_random_uuid();
  v_offered   int;
  v_starts_at timestamptz;
  v_slot_id   uuid;
  v_token     uuid;
  v_weeks     jsonb := '[]';
begin
  -- 1. Enough weeks offered from this date? Read-only, before any write.
  --    Counts the last visible slot at the same weekday + time. As anon, "visible" means
  --    free (RLS), so a booked LAST week counts one less, the same as in stage 1.
  select coalesce(max(floor(extract(epoch from s.starts_at - p_first_starts_at) / 604800)), 0)::int + 1
    into v_offered
    from public.slots s
   where s.host_id = p_host_id
     and s.starts_at >= p_first_starts_at
     and extract(epoch from s.starts_at - p_first_starts_at)::bigint % 604800 = 0;

  if v_offered < p_weeks then
    raise exception 'Only % week(s) available from this date', v_offered
      using errcode = 'RB002',
            detail  = jsonb_build_object('requested', p_weeks, 'available', v_offered)::text;
  end if;

  -- 2. The series. The id is made here, not returned by INSERT ... RETURNING:
  --    RETURNING needs SELECT rights on the row, which guests don't have.
  insert into public.booking_series (id, host_id, guest_name, guest_email, weekday, start_time, weeks)
  values (
    v_series_id, p_host_id, p_guest_name, p_guest_email,
    extract(dow from p_first_starts_at at time zone 'UTC'),
    (p_first_starts_at at time zone 'UTC')::time,
    p_weeks
  );

  -- 3. One booking per week. The slot trigger marks each slot taken in the same transaction.
  for w in 1 .. p_weeks loop
    v_starts_at := p_first_starts_at + (w - 1) * c_week;

    select s.id into v_slot_id
      from public.slots s
     where s.host_id = p_host_id
       and s.starts_at = v_starts_at
       and not s.is_booked;

    if v_slot_id is null then
      raise exception 'Week % is not available', w
        using errcode = 'RB001',
              detail  = jsonb_build_object('week', w, 'starts_at', v_starts_at, 'reason', 'not available')::text;
    end if;

    v_token := gen_random_uuid();
    begin
      insert into public.bookings (slot_id, guest_name, guest_email, cancel_token, series_id, week_no)
      values (v_slot_id, p_guest_name, p_guest_email, v_token, v_series_id, w);
    exception
      -- Someone else booked this slot between our lookup and our insert (a race).
      -- 23505 = unique index "one confirmed booking per slot", 42501 = insert policy.
      -- Re-raise as RB001 so the guest learns WHICH week; it still aborts everything.
      when unique_violation or insufficient_privilege then
        raise exception 'Week % is not available', w
          using errcode = 'RB001',
                detail  = jsonb_build_object('week', w, 'starts_at', v_starts_at, 'reason', 'just taken')::text;
    end;

    v_weeks := v_weeks || jsonb_build_object('week', w, 'startsAt', v_starts_at, 'cancelToken', v_token);
  end loop;

  return jsonb_build_object('seriesId', v_series_id, 'weeks', v_weeks);
end;
$$;

-- Same lock-down as the core RPCs: nobody by default, then guests and hosts.
revoke execute on function public.book_recurring(uuid, timestamptz, int, text, text) from public, anon, authenticated;
grant  execute on function public.book_recurring(uuid, timestamptz, int, text, text) to anon, authenticated;
