-- Security review: SQL injection, contrast run (src/probes/security/sqli-proof.mjs, section 3).
--
-- sqli_search_bookings_unsafe (previous migration) is SECURITY DEFINER: it runs as its owner,
-- `postgres`, which bypasses RLS and can read auth.users and Vault. This is the SAME vulnerable
-- function as SECURITY INVOKER: it runs as the caller (`authenticated`), so the injected SQL can
-- only do what that role may do: RLS on public tables, no auth.users, no Vault. But note:
-- "what the role may do" includes Supabase's default grants outside the API schemas, e.g.
-- EXECUTE on pg_net's net.http_get/http_post (the proof shows the injection making the
-- database send an HTTP request).
--
-- Same locks as the DEFINER version: no execute grant for API roles (the proof grants it for its
-- run only) and the 2-minute sqli_probe_switch. An INVOKER function can't read the switch table
-- itself (the caller has no rights on it), so a small DEFINER helper answers "is it on?".

create function public.sqli_probe_unsafe_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select unsafe_enabled_until > now() from public.sqli_probe_switch where id = 1), false)
$$;

create function public.sqli_search_bookings_unsafe_invoker(p_search text)
returns table (guest_name text, guest_email text, starts_at timestamptz, host_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.sqli_probe_unsafe_enabled() then
    raise exception 'The SQL injection probe is switched off.' using errcode = '42501';
  end if;

  -- Identical string building to the DEFINER version: still injectable.
  return query execute
    'select b.guest_name, b.guest_email, s.starts_at, s.host_id
       from public.bookings b join public.slots s on s.id = b.slot_id
      where s.host_id = ''' || auth.uid() || ''' and b.guest_email ilike ''%' || p_search || '%'' order by 3';
end;
$$;

revoke execute on function public.sqli_search_bookings_unsafe_invoker(text) from public, anon, authenticated;
-- The helper only says whether the probe is on; logged-in users need it for the INVOKER function.
revoke execute on function public.sqli_probe_unsafe_enabled() from public, anon;
grant execute on function public.sqli_probe_unsafe_enabled() to authenticated;
