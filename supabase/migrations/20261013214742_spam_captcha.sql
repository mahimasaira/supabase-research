-- Advanced feature 3 (spam protection), stage 3: CAPTCHA (Cloudflare Turnstile) via an Edge Function.
--
-- Stage 2's limits slow bots down but can't tell a human from a bot. A host can now require a
-- CAPTCHA (profiles.require_captcha). For that host, bookings must come through the Edge
-- Function `book-slot` (or `book-recurring`), which verifies the Turnstile token with Cloudflare
-- and then books inside a transaction marked `app.captcha_verified = 'true'`.
--
-- A CAPTCHA only helps if bots can't skip it: the direct API path (insert into bookings via
-- REST, book_recurring rpc) is REFUSED for those hosts (HTTP 403). The mark is a transaction
-- setting; clients can't set it through the API (PostgREST only lets them call exposed
-- functions and tables, not set_config).
-- Hosts who don't opt in: nothing changes.

alter table public.profiles add column require_captcha boolean not null default false;
grant update (require_captcha) on public.profiles to authenticated;  -- own profile only (existing RLS policy)

-- SECURITY INVOKER on purpose: current_user is then the caller's role (anon / authenticated for
-- API requests). Database-owner connections (Studio, seeds, the DocuSign functions) are not checked.
-- The slot being booked is readable for the caller (free + future), profiles are public.
create function public.bookings_check_captcha()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and coalesce(current_setting('app.captcha_verified', true), '') <> 'true'
     and exists (select 1 from public.slots s join public.profiles p on p.id = s.host_id
                  where s.id = new.slot_id and p.require_captcha)
  then
    -- PT403 makes PostgREST answer with HTTP 403.
    raise exception 'This host requires a CAPTCHA check. Please book through the booking page.'
      using errcode = 'PT403', detail = json_build_object('requirement', 'captcha')::text;
  end if;
  return new;
end;
$$;

-- Runs before bookings_enforce_limits (alphabetical order): a bot without a CAPTCHA is
-- refused before it can use up the host's or the IP's quota.
create trigger bookings_check_captcha
  before insert on public.bookings
  for each row execute function public.bookings_check_captcha();

revoke execute on function public.bookings_check_captcha() from public, anon, authenticated;
