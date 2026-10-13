-- Advanced feature 3 (spam protection), stage 2: limits enforced inside the database.
-- Stage 1 (src/probes/spam/flood.mjs) showed one script can book a host's whole calendar in
-- ~250 ms, 50× with one email, at ~1,000 writes/s, triggering 50 DocuSign emails.
--
-- A BEFORE INSERT trigger on bookings counts recent bookings and rejects with HTTP 429:
--   * per email per host:  max 3 ACTIVE bookings (waiting or confirmed)
--   * per host:            max 10 new bookings per 10 minutes, from everyone together
--   * per IP address:      max 30 new bookings per 10 minutes, across all hosts
-- A recurring series counts as ONE booking (its later weeks are not counted again).
-- Parallel requests are serialized per host / per IP with advisory locks (see below).
-- `raise … using errcode = 'PT429'` makes PostgREST answer with HTTP status 429.
--
-- IP addresses: only a salted hash is stored (salt in Vault), and only for 1 day (pg_cron).

-- ---------------------------------------------------------------------------
-- Settings: one row, editable by the database owner (Studio), not by clients.
-- ---------------------------------------------------------------------------
create table public.rate_limit_settings (
  id                  int primary key default 1 check (id = 1),
  max_active_per_email int not null default 3,
  max_per_host        int not null default 10,
  max_per_ip          int not null default 30,
  window_interval     interval not null default interval '10 minutes'
);
insert into public.rate_limit_settings default values;

-- One row per accepted booking (or recurring series): when, which host, which IP (hashed).
create table public.booking_rate_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  host_id    uuid not null references public.profiles (id) on delete cascade,
  ip_hash    text            -- null when there's no HTTP request (Studio, scripts, direct connections)
);
create index booking_rate_events_host_idx on public.booking_rate_events (host_id, created_at);
create index booking_rate_events_ip_idx on public.booking_rate_events (ip_hash, created_at) where ip_hash is not null;

-- Nobody reads these through the API.
alter table public.rate_limit_settings enable row level security;
alter table public.booking_rate_events enable row level security;
revoke all on public.rate_limit_settings, public.booking_rate_events from anon, authenticated;

-- Random salt for hashing IPs, kept in Vault (an unsalted hash of an IPv4 address could be
-- reversed by trying all 4 billion addresses).
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'rate_limit_ip_salt');

-- ---------------------------------------------------------------------------
-- The client's IP address, as far as the database can know it.
-- PostgREST puts the HTTP request headers into the setting request.headers.
-- X-Forwarded-For lists every hop: a client can PREPEND fake entries, while the proxy in front
-- of PostgREST APPENDS the address it actually saw. So only the LAST entry can be trusted
-- (locally: added by Kong). Behind a different proxy chain (hosted), verify this again.
-- ---------------------------------------------------------------------------
create function public.request_client_ip()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(trim(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', -1)), '')
$$;

-- ---------------------------------------------------------------------------
-- The limits.
-- ---------------------------------------------------------------------------
create function public.bookings_enforce_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg     public.rate_limit_settings;
  v_host  uuid;
  v_ip    text;
  v_hash  text;
  v_count int;
begin
  -- Weeks 2+ of a recurring series: the series was already counted with its first week.
  if new.series_id is not null and exists (select 1 from public.bookings where series_id = new.series_id) then
    return new;
  end if;

  select * into cfg from public.rate_limit_settings where id = 1;
  select host_id into v_host from public.slots where id = new.slot_id;
  v_ip := public.request_client_ip();
  if v_ip is not null then
    v_hash := encode(extensions.hmac(v_ip, (select decrypted_secret from vault.decrypted_secrets where name = 'rate_limit_ip_salt'), 'sha256'), 'hex');
  end if;

  -- Count-then-insert is a race: parallel bookings don't see each other's uncommitted rows, so
  -- they'd all count "9 so far" and all pass (the first test let 14 of max 10 through). An
  -- advisory lock per host (and per IP) makes bookings for the same host/IP wait for each
  -- other until the first commits. Released automatically at the end of the transaction.
  perform pg_advisory_xact_lock(hashtextextended('booking-limit:host:' || v_host::text, 0));
  if v_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('booking-limit:ip:' || v_hash, 0));
  end if;

  -- 1. Per email per host: active bookings (a series counts once).
  select count(distinct coalesce(b.series_id, b.id)) into v_count
    from public.bookings b join public.slots s on s.id = b.slot_id
   where s.host_id = v_host
     and lower(b.guest_email) = lower(new.guest_email)
     and b.status in ('confirmed', 'pending_signature');
  if v_count >= cfg.max_active_per_email then
    raise exception 'You already have % active bookings with this host.', v_count
      using errcode = 'PT429', detail = json_build_object('limit', 'per_email', 'max', cfg.max_active_per_email)::text;
  end if;

  -- 2. Per host, everyone together.
  select count(*) into v_count from public.booking_rate_events
   where host_id = v_host and created_at > now() - cfg.window_interval;
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

  -- Counted only if the booking itself succeeds (same transaction).
  insert into public.booking_rate_events (host_id, ip_hash) values (v_host, v_hash);
  return new;
end;
$$;

create trigger bookings_enforce_limits
  before insert on public.bookings
  for each row execute function public.bookings_enforce_limits();

revoke execute on function public.request_client_ip() from public, anon, authenticated;
revoke execute on function public.bookings_enforce_limits() from public, anon, authenticated;

-- IP hashes are personal data: keep them one day at most.
select cron.schedule('rate-limit-cleanup', '17 * * * *',
  $$delete from public.booking_rate_events where created_at < now() - interval '1 day'$$);
