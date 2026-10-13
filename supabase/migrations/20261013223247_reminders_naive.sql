-- Advanced feature 5 (bulk reminders), stage 1: the NAIVE version, to show the problem.
--
-- A day before each session, the guest gets a reminder email. The naive design most
-- tutorials show: a scheduled job (pg_cron) calls one Edge Function (send-reminders), which
-- finds tomorrow's bookings, sends one email each in a loop, and marks them all as reminded at
-- the end (bookings.reminder_sent_at). src/probes/reminders/naive.mjs shows how that fails.
-- Emails go to the local Mailpit inbox only (http://127.0.0.1:54324).

alter table public.bookings add column reminder_sent_at timestamptz;

-- Call an Edge Function from the database: URL from Vault (by name), the project's secret key
-- from Vault, queued with pg_net (sent after commit). Returns the pg_net request id, so a caller
-- can look up the response later in net._http_response (or null if not configured).
-- (DocuSign's docusign_queue_call does the same for its two functions; this one is general.)
create function public.invoke_edge_function(p_url_secret text, p_body jsonb, p_timeout_ms int default 30000)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = p_url_secret;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'edge_function_key';
  if v_url is null or v_key is null then
    raise warning 'Edge Function not configured (Vault: % / edge_function_key)', p_url_secret;
    return null;
  end if;
  return net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := p_body,
    timeout_milliseconds := p_timeout_ms
  );
end;
$$;

-- What the scheduled job runs. p_body: test switches for the demonstration
-- ({"hostId", "crashAfter", "delayMs"}); empty for a normal run.
create function public.run_reminders(p_body jsonb default '{}')
returns bigint
language sql
security definer
set search_path = ''
as $$
  select public.invoke_edge_function('reminders_url', p_body)
$$;

revoke execute on function public.invoke_edge_function(text, jsonb, int) from public, anon, authenticated;
revoke execute on function public.run_reminders(jsonb) from public, anon, authenticated;

-- Every hour at :05. Created SWITCHED OFF in stage 1: the demonstration script triggers runs
-- itself, so nothing sends in the background. (Switch on: select cron.alter_job(jobid, active := true) …)
select cron.schedule('send-reminders', '5 * * * *', 'select public.run_reminders()');
select cron.alter_job(jobid, active := false) from cron.job where jobname = 'send-reminders';
