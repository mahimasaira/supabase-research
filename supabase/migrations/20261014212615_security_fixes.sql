-- Security review, fixes for what the exposure scan found (src/probes/security/exposure-scan.mjs).
--
-- 1. Empty booking series were unlimited. Guests may insert into booking_series directly (all three
--    recurring-booking stages need it), and nothing counted those inserts: one visitor created 30
--    series for a host in a row, each one a line in the host's history page.
-- 2. The booking limits could be bypassed with series. Weeks 2+ of a series skipped the limits
--    ("the series was counted with its first week"), but nothing tied a booking to its series'
--    host, weekday or time. A visitor opened 4 made-up series and booked 40 slots of one host
--    (limit: 10 per 10 minutes).
--
-- Fix: a series is counted ONCE, when it is created (same three limits as a booking), and every
-- booking that claims to belong to a series must match it (same host, weekday, time, week within
-- the series' length). Bookings of a series are then not counted again.

-- ---------------------------------------------------------------------------
-- The three limits as one function, used by both triggers below (same rules as feature 3).
-- ---------------------------------------------------------------------------
create function public.enforce_booking_limits(p_host uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg     public.rate_limit_settings;
  v_ip    text := public.request_client_ip();
  v_hash  text;
  v_count int;
begin
  select * into cfg from public.rate_limit_settings where id = 1;
  if v_ip is not null then
    v_hash := encode(extensions.hmac(v_ip, (select decrypted_secret from vault.decrypted_secrets where name = 'rate_limit_ip_salt'), 'sha256'), 'hex');
  end if;

  -- Parallel requests for the same host / IP wait for each other (see the spam limits migration).
  perform pg_advisory_xact_lock(hashtextextended('booking-limit:host:' || p_host::text, 0));
  if v_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('booking-limit:ip:' || v_hash, 0));
  end if;

  -- 1. Per email per host: active bookings (a series counts once).
  select count(distinct coalesce(b.series_id, b.id)) into v_count
    from public.bookings b join public.slots s on s.id = b.slot_id
   where s.host_id = p_host
     and lower(b.guest_email) = lower(p_email)
     and b.status in ('confirmed', 'pending_signature');
  if v_count >= cfg.max_active_per_email then
    raise exception 'You already have % active bookings with this host.', v_count
      using errcode = 'PT429', detail = json_build_object('limit', 'per_email', 'max', cfg.max_active_per_email)::text;
  end if;

  -- 2. Per host, everyone together.
  select count(*) into v_count from public.booking_rate_events
   where host_id = p_host and created_at > now() - cfg.window_interval;
  if v_count >= cfg.max_per_host then
    raise exception 'This host is receiving too many bookings right now. Please try again in a few minutes.'
      using errcode = 'PT429', detail = json_build_object('limit', 'per_host', 'max', cfg.max_per_host)::text;
  end if;

  -- 3. Per IP address (only when there is an HTTP request to take it from).
  if v_hash is not null then
    select count(*) into v_count from public.booking_rate_events
     where ip_hash = v_hash and created_at > now() - cfg.window_interval;
    if v_count >= cfg.max_per_ip then
      raise exception 'Too many bookings from your network. Please try again in a few minutes.'
        using errcode = 'PT429', detail = json_build_object('limit', 'per_ip', 'max', cfg.max_per_ip)::text;
    end if;
  end if;

  insert into public.booking_rate_events (host_id, ip_hash) values (p_host, v_hash);
end;
$$;

-- ---------------------------------------------------------------------------
-- Bookings: one-off bookings are counted; bookings of a series are not (the series was).
-- ---------------------------------------------------------------------------
create or replace function public.bookings_enforce_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.series_id is not null then
    return new;  -- counted when the series was created; bookings_check_series made sure it matches
  end if;
  perform public.enforce_booking_limits((select host_id from public.slots where id = new.slot_id), new.guest_email);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Series: counted when created.
-- ---------------------------------------------------------------------------
create function public.booking_series_enforce_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enforce_booking_limits(new.host_id, new.guest_email);
  return new;
end;
$$;

create trigger booking_series_enforce_limits
  before insert on public.booking_series
  for each row execute function public.booking_series_enforce_limits();

-- ---------------------------------------------------------------------------
-- A booking that claims to be week N of a series must fit that series.
-- Runs before bookings_enforce_limits (triggers fire in name order).
-- ---------------------------------------------------------------------------
create function public.bookings_check_series()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.series_id is not null and not exists (
    select 1 from public.booking_series bs, public.slots s
     where bs.id = new.series_id and s.id = new.slot_id
       and s.host_id = bs.host_id
       and extract(dow from s.starts_at at time zone 'UTC') = bs.weekday
       and (s.starts_at at time zone 'UTC')::time = bs.start_time
       and new.week_no <= bs.weeks
       and lower(new.guest_email) = lower(bs.guest_email)
  ) then
    raise exception 'This booking does not match its recurring series.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger bookings_check_series
  before insert on public.bookings
  for each row execute function public.bookings_check_series();

revoke execute on function public.enforce_booking_limits(uuid, text) from public, anon, authenticated;
revoke execute on function public.booking_series_enforce_limits() from public, anon, authenticated;
revoke execute on function public.bookings_check_series() from public, anon, authenticated;
