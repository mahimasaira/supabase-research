-- Security review: SQL injection probe (src/probes/security/sqli-proof.mjs).
--
-- supabase-js never builds SQL: filters go to PostgREST as URL parameters and PostgREST sends
-- them to Postgres as bound parameters. The way SQL injection gets into a Supabase project is
-- your own Postgres function that glues user input into a query string and runs it with EXECUTE.
--
-- Two versions of the same feature, "a host searches their bookings by guest email":
--   sqli_search_bookings_unsafe  builds the query by string concatenation (VULNERABLE, probe only)
--   sqli_search_bookings_safe    passes the input as a parameter ($1, $2) and quotes the sort
--                                column with format('%I'), so input can never become SQL
-- Both are SECURITY DEFINER (they run as the table owner, RLS off) and filter by auth.uid()
-- themselves, so the ONLY difference is how the query is built.
--
-- The unsafe function can't be left enabled by accident. Two independent locks:
--   1. No API role may execute it (revoked below). The proof script grants it for its run only,
--      and revokes it again when it exits.
--   2. Even when granted, it refuses unless sqli_probe_switch.unsafe_enabled_until is in the
--      future. The proof script sets that to now() + 2 minutes, so a crashed run closes itself.
-- The exposure scan (npm run probe:security:scan) also fails if the API can call it.

create table public.sqli_probe_switch (
  id                   int primary key default 1 check (id = 1),
  unsafe_enabled_until timestamptz            -- null or in the past = off
);
insert into public.sqli_probe_switch default values;
alter table public.sqli_probe_switch enable row level security;
revoke all on public.sqli_probe_switch from anon, authenticated;

-- ---------------------------------------------------------------------------
-- VULNERABLE: never do this.
-- ---------------------------------------------------------------------------
create function public.sqli_search_bookings_unsafe(p_search text)
returns table (guest_name text, guest_email text, starts_at timestamptz, host_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select unsafe_enabled_until > now() from public.sqli_probe_switch where id = 1), false) is not true then
    raise exception 'The SQL injection probe is switched off.' using errcode = '42501';
  end if;

  -- The input is pasted into the SQL text. A quote in p_search ends the string and the rest
  -- of the input is read as SQL.
  return query execute
    'select b.guest_name, b.guest_email, s.starts_at, s.host_id
       from public.bookings b join public.slots s on s.id = b.slot_id
      where s.host_id = ''' || auth.uid() || ''' and b.guest_email ilike ''%' || p_search || '%'' order by 3';
end;
$$;

-- ---------------------------------------------------------------------------
-- SAFE: values as parameters, identifiers quoted with %I.
-- ---------------------------------------------------------------------------
create function public.sqli_search_bookings_safe(p_search text, p_sort text default 'starts_at')
returns table (guest_name text, guest_email text, starts_at timestamptz, host_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- $1 / $2 are sent separately from the SQL text, so they are only ever data.
  -- A column name can't be a parameter; format('%I') quotes it as an identifier, so
  -- 'starts_at; drop table x' becomes the (non-existent) column "starts_at; drop table x".
  -- (format('%L') would be the way to quote a value, if a parameter can't be used.)
  return query execute format(
    'select b.guest_name, b.guest_email, s.starts_at, s.host_id
       from public.bookings b join public.slots s on s.id = b.slot_id
      where s.host_id = $1
        and b.guest_email ilike ''%%'' || $2 || ''%%''
      order by %I', p_sort)
    using auth.uid(), p_search;
end;
$$;

revoke execute on function public.sqli_search_bookings_unsafe(text) from public, anon, authenticated;
revoke execute on function public.sqli_search_bookings_safe(text, text) from public, anon;
grant execute on function public.sqli_search_bookings_safe(text, text) to authenticated;
