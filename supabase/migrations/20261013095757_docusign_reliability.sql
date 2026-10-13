-- Advanced feature 4 (DocuSign), stage 4: when things go wrong.
-- src/probes/docusign/proof-failures.mjs showed, before this migration (11 failing checks):
--   * a send request that pg_net couldn't deliver is lost: no retry, the booking waits forever
--   * a send that crashed half-way stays 'sending' forever
--   * a booking that's never signed holds the slot forever
--   * cancelling a booking leaves the agreement signable in DocuSign
-- Supabase has no job queue. The fixes are built from what Postgres offers:
--   * pg_cron (scheduled jobs inside Postgres): retry sends every minute, expire unsigned bookings
--   * a trigger + pg_net + a new Edge Function (docusign-void) to withdraw agreements
-- Jobs label their writes with JWT claims {"role":"scheduler"}, so the audit log / History
-- shows "Scheduler" instead of "Database admin".

create extension if not exists pg_cron;

alter table public.bookings add column signature_attempts int not null default 0;  -- retries queued so far

alter table public.bookings drop constraint bookings_signature_status_check;
alter table public.bookings add constraint bookings_signature_status_check
  check (signature_status in ('pending', 'sending', 'sent', 'completed', 'declined', 'voided', 'failed', 'expired'));

-- ---------------------------------------------------------------------------
-- One helper to call an Edge Function: URL from Vault (by name), the project's secret key
-- from Vault, queued with pg_net (sent after commit). Returns false if not configured.
-- ---------------------------------------------------------------------------
create function public.docusign_queue_call(p_url_secret text, p_body jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = p_url_secret;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'docusign_send_key';
  if v_url is null or v_key is null then
    raise warning 'DocuSign not configured (Vault: % / docusign_send_key)', p_url_secret;
    return false;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := p_body,
    timeout_milliseconds := 30000  -- cold starts can exceed pg_net's 5 s default
  );
  return true;
end;
$$;

-- Stage 2's trigger function, now using the helper.
create or replace function public.bookings_queue_signature_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.docusign_queue_call('docusign_send_url', jsonb_build_object('booking_id', new.id));
  return null;
exception when others then
  -- Never let the integration break the booking itself; the retry job picks it up.
  raise warning 'Could not queue DocuSign send for booking %: %', new.id, sqlerrm;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retry. Every minute (pg_cron). Re-queues sends for waiting bookings that:
--   * were never sent ('pending' for longer than p_min_age: the request got lost), or
--   * failed, once their backoff has passed (1, 2, 4, 8 … minutes), up to p_max_attempts, or
--   * crashed half-way ('sending' for over 5 minutes: marked failed first).
-- One request per booking or per recurring series. docusign-send's claim makes duplicates harmless.
-- ---------------------------------------------------------------------------
create function public.docusign_retry_sends(p_min_age interval default interval '2 minutes', p_max_attempts int default 5)
returns int  -- requests queued
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking record;
  v_queued int := 0;
begin
  perform set_config('request.jwt.claims', '{"role":"scheduler"}', true);

  -- Crashed half-way: keep signature_updated_at, so the retry below can pick it up right away.
  update public.bookings
     set signature_status = 'failed', signature_error = 'timed out while sending'
   where status = 'pending_signature' and signature_status = 'sending'
     and signature_updated_at < now() - interval '5 minutes';

  for v_booking in
    select distinct on (coalesce(b.series_id, b.id)) b.id, b.series_id
      from public.bookings b
     where b.status = 'pending_signature'
       and b.signature_attempts < p_max_attempts
       and b.signature_updated_at < now() - greatest(
             p_min_age,
             case when b.signature_status = 'failed'
                  then interval '1 minute' * power(2, greatest(b.signature_attempts, 1) - 1)
                  else interval '0' end)
       and b.signature_status in ('pending', 'failed')
     order by coalesce(b.series_id, b.id), b.week_no nulls first
  loop
    if public.docusign_queue_call('docusign_send_url', jsonb_build_object('booking_id', v_booking.id)) then
      update public.bookings
         set signature_attempts = signature_attempts + 1, signature_updated_at = now()
       where id = v_booking.id or (v_booking.series_id is not null and series_id = v_booking.series_id);
      v_queued := v_queued + 1;
    end if;
  end loop;
  return v_queued;
end;
$$;

-- ---------------------------------------------------------------------------
-- Expiry. Every 5 minutes (pg_cron). A booking still waiting after p_after, or whose session
-- starts within the hour, is cancelled ('expired') and its slot freed. Its agreement is then
-- withdrawn by the trigger below.
-- ---------------------------------------------------------------------------
create function public.docusign_expire_unsigned(p_after interval default interval '48 hours')
returns int  -- bookings expired
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired int;
begin
  perform set_config('request.jwt.claims', '{"role":"scheduler"}', true);
  update public.bookings b
     set status = 'cancelled', signature_status = 'expired', signature_updated_at = now()
    from public.slots s
   where s.id = b.slot_id
     and b.status = 'pending_signature'
     and (b.created_at < now() - p_after or s.starts_at < now() + interval '1 hour');
  get diagnostics v_expired = row_count;
  return v_expired;
end;
$$;

-- ---------------------------------------------------------------------------
-- Withdraw the agreement when its booking is cancelled (by the guest, the host or expiry),
-- unless DocuSign already ended it (declined / voided / signed). A recurring series shares one
-- agreement: it's only withdrawn once NO booking of the series is still active.
-- ---------------------------------------------------------------------------
create function public.bookings_queue_signature_void()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.bookings
     where envelope_id = new.envelope_id and status in ('pending_signature', 'confirmed')
  ) then
    perform public.docusign_queue_call('docusign_void_url', jsonb_build_object('envelope_id', new.envelope_id));
  end if;
  return null;
exception when others then
  raise warning 'Could not queue DocuSign void for envelope %: %', new.envelope_id, sqlerrm;
  return null;
end;
$$;

create trigger bookings_queue_signature_void
  after update of status on public.bookings
  for each row
  when (old.status = 'pending_signature' and new.status = 'cancelled' and new.envelope_id is not null
        and coalesce(new.signature_status, '') not in ('declined', 'voided', 'completed'))
  execute function public.bookings_queue_signature_void();

revoke execute on function public.docusign_queue_call(text, jsonb) from public, anon, authenticated;
revoke execute on function public.docusign_retry_sends(interval, int) from public, anon, authenticated;
revoke execute on function public.docusign_expire_unsigned(interval) from public, anon, authenticated;
revoke execute on function public.bookings_queue_signature_void() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedules (pg_cron, in UTC). See them in Studio: select * from cron.job / cron.job_run_details.
-- ---------------------------------------------------------------------------
select cron.schedule('docusign-retry-sends', '* * * * *', 'select public.docusign_retry_sends()');
select cron.schedule('docusign-expire-unsigned', '*/5 * * * *', 'select public.docusign_expire_unsigned()');
