-- Advanced feature 5 (bulk reminders), stage 3: opt-out + the email provider's sending limit.
--
-- A. Opt-out without an account. Every reminder links to /reminders/unsubscribe/<cancel token>.
--    The cancel token is the guest's existing secret (whoever has the email can already cancel the
--    booking), so it can also stop reminders, for that guest's email address only. Opt-outs are
--    stored as a hash of the lower-cased address, checked when queuing AND just before sending.
-- B. Sending limits. Real email providers allow N emails per second and answer 429 above that.
--    A small TEST provider (Edge Function test-mail-provider, in front of Mailpit) behaves like
--    that, so the worker's behaviour can be tested. The worker (process-reminders) now paces
--    itself, holds a lease so only one worker sends at a time, and on a 429 puts the message back
--    with a delay WITHOUT counting it as a failed attempt.

-- ---------------------------------------------------------------------------
-- A. Opt-out
-- ---------------------------------------------------------------------------
create table public.reminder_optouts (
  email_hash text primary key,                  -- sha256 of lower(trim(email)); no addresses stored
  created_at timestamptz not null default now()
);
alter table public.reminder_optouts enable row level security;
revoke all on public.reminder_optouts from anon, authenticated;

create function public.reminder_email_hash(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(lower(trim(p_email)), 'sha256'), 'hex')
$$;

-- Called by the unsubscribe page (rpc) and the one-click endpoint. Like cancel_booking: the
-- token proves the caller received that booking's emails. true = opted out (or already was).
create function public.unsubscribe_reminders(p_cancel_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select guest_email into v_email from public.bookings where cancel_token = p_cancel_token;
  if v_email is null then
    return false;                               -- unknown token
  end if;
  insert into public.reminder_optouts (email_hash) values (public.reminder_email_hash(v_email))
  on conflict do nothing;
  return true;
end;
$$;

create function public.reminders_opted_out(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.reminder_optouts where email_hash = public.reminder_email_hash(p_email))
$$;

-- Stage 2's enqueue, now skipping guests who opted out.
create or replace function public.enqueue_reminders(p_host_id uuid default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queued int;
begin
  with due as (
    select b.id
      from public.bookings b join public.slots s on s.id = b.slot_id
     where b.status = 'confirmed'
       and b.reminder_sent_at is null
       and b.reminder_queued_at is null
       and s.starts_at between now() + interval '23 hours' and now() + interval '25 hours'
       and (p_host_id is null or s.host_id = p_host_id)
       and not public.reminders_opted_out(b.guest_email)
       for update of b skip locked
  ), marked as (
    update public.bookings set reminder_queued_at = now() where id in (select id from due) returning id
  )
  select count(*) into v_queued from marked, lateral pgmq.send('reminders', jsonb_build_object('booking_id', marked.id));
  return v_queued;
end;
$$;

revoke execute on function public.reminder_email_hash(text) from public, anon, authenticated;
revoke execute on function public.reminders_opted_out(text) from public, anon, authenticated;
revoke execute on function public.unsubscribe_reminders(uuid) from public, anon, authenticated;
grant  execute on function public.unsubscribe_reminders(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- B. One worker at a time: a lease that expires by itself (a crashed worker can't block others).
-- ---------------------------------------------------------------------------
create table public.reminder_worker_lease (
  id         int primary key default 1 check (id = 1),
  holder     uuid,
  expires_at timestamptz not null default '-infinity'
);
insert into public.reminder_worker_lease default values;
alter table public.reminder_worker_lease enable row level security;
revoke all on public.reminder_worker_lease from anon, authenticated;

-- ---------------------------------------------------------------------------
-- B. The TEST email provider's bookkeeping (test double, used by Edge Function test-mail-provider).
-- ---------------------------------------------------------------------------
create table public.test_mail_provider_settings (
  id               int primary key default 1 check (id = 1),
  limit_per_second int not null default 20
);
insert into public.test_mail_provider_settings default values;
create table public.test_mail_provider_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default clock_timestamp(),
  accepted boolean not null
);
create index test_mail_provider_log_at_idx on public.test_mail_provider_log (at);
alter table public.test_mail_provider_settings enable row level security;
alter table public.test_mail_provider_log enable row level security;
revoke all on public.test_mail_provider_settings, public.test_mail_provider_log from anon, authenticated;
