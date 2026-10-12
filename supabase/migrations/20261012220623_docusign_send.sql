-- Advanced feature 4 (DocuSign), stage 2: sending the agreement.
--
-- When a booking starts as 'pending_signature', the database asks the Edge Function
-- `docusign-send` to create the DocuSign envelope. It does that with pg_net, an HTTP client
-- inside Postgres (what the Supabase dashboard calls "Database Webhooks"):
--   * net.http_post() only QUEUES the request; pg_net's background worker sends it after the
--     transaction has committed. A booking that rolls back (e.g. a recurring booking that
--     clashes in week 4) never sends an agreement. The queue acts as an "outbox".
--   * The function's URL and the key it expects are environment-specific and the key is a
--     secret, so they live in Vault, not in this migration. Set them locally with
--     `npm run probe:docusign:setup`. Without them, bookings still work and simply stay
--     signature_status = 'pending' (stage 4 will retry those).
--
-- The Edge Function itself (supabase/functions/docusign-send) loads the booking from the
-- database and only sends for bookings that are really waiting, so the request body
-- carries nothing but an id.

create extension if not exists pg_net;

-- 'sending' = an Edge Function has claimed the booking and is talking to DocuSign.
alter table public.bookings drop constraint bookings_signature_status_check;
alter table public.bookings add constraint bookings_signature_status_check
  check (signature_status in ('pending', 'sending', 'sent', 'completed', 'declined', 'voided', 'failed'));

-- A recurring booking gets ONE envelope listing all its weeks (not one email per week),
-- so several bookings share an envelope_id.
alter table public.bookings drop constraint bookings_envelope_id_key;
create index bookings_envelope_idx on public.bookings (envelope_id) where envelope_id is not null;

-- ---------------------------------------------------------------------------
-- Queue the send request. AFTER INSERT, once per booking, or once per recurring series
-- (its first week; the function sends the whole series in one envelope).
-- ---------------------------------------------------------------------------
create function public.bookings_queue_signature_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'docusign_send_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'docusign_send_key';
  if v_url is null or v_key is null then
    raise warning 'DocuSign send not configured (Vault secrets docusign_send_url / docusign_send_key); booking % stays pending', new.id;
    return null;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('booking_id', new.id),
    -- pg_net's default is 5 s; an Edge Function's first request after a pause (cold start)
    -- can take longer, and the request is then dropped as a timeout.
    timeout_milliseconds := 30000
  );
  return null;
exception when others then
  -- Never let the integration break the booking itself.
  raise warning 'Could not queue DocuSign send for booking %: %', new.id, sqlerrm;
  return null;
end;
$$;

revoke execute on function public.bookings_queue_signature_request() from public, anon, authenticated;

create trigger bookings_queue_signature_request
  after insert on public.bookings
  for each row
  when (new.status = 'pending_signature' and (new.week_no is null or new.week_no = 1))
  execute function public.bookings_queue_signature_request();
