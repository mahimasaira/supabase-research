-- Advanced feature 2, stage 1: an audit log written FROM THE BROWSER (to show the problem).
--
-- After each action the browser sends a second request: "this happened". For that to work,
-- every guest and host needs INSERT rights on the log, which is exactly its weakness:
-- the log only contains what clients choose to send. Stage 2 replaces this with
-- database triggers (table audit_log); this table stays so both can be compared.
--
-- What the database CAN guarantee here: WHO wrote an entry. actor_id / actor_role come
-- from the caller's JWT via column defaults, and clients get no grant on those columns.
-- WHAT the entry says (action, record, changes) is whatever the client sends.

create table public.audit_log_client (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Who: from the JWT, never from the request body. Guests: role 'anon', no id.
  actor_id   uuid default auth.uid(),
  actor_role text not null default coalesce(auth.role(), current_user),
  -- What: sent by the client.
  action     text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),          -- e.g. booking.created
  table_name text not null check (table_name in ('bookings', 'slots', 'booking_series', 'profiles')),
  record_id  uuid,                    -- null when the client doesn't know the row id (see below)
  host_id    uuid,                    -- whose slots/bookings this is about (decides who may read it)
  changes    jsonb not null default '{}'   -- only changed fields; emails masked by the client
);
-- No foreign keys on purpose: log entries must outlive the rows (and users) they describe.

create index audit_log_client_host_idx on public.audit_log_client (host_id, created_at desc);

alter table public.audit_log_client enable row level security;

-- Grants: the "what" columns are writable by everyone, the "who" columns by nobody.
revoke all on public.audit_log_client from anon, authenticated;
grant insert (action, table_name, record_id, host_id, changes) on public.audit_log_client to anon, authenticated;
grant select on public.audit_log_client to authenticated;

-- Anyone may log anything. There's no way to check that the described action really
-- happened: the action is a separate, already-committed request.
create policy "Anyone can write client audit entries"
  on public.audit_log_client for insert
  to anon, authenticated
  with check (true);

-- Hosts read entries about their own slots/bookings.
create policy "Hosts read client audit entries about them"
  on public.audit_log_client for select
  to authenticated
  using (host_id = (select auth.uid()));

-- No update/delete policies or grants: entries can't be changed or removed by clients.
