-- Part 3 of the review: re-running a few local findings on a hosted (free) Supabase project.
-- See HOSTED_CHECKS.md and src/probes/hosted/.
--
-- The Edge Function hosted-probe writes a heartbeat row every few seconds while it sleeps, so a
-- script can tell afterwards how long the function really kept running (e.g. after the gateway
-- already answered 504, or after pg_net gave up waiting). Only the function writes here (through
-- its direct database connection); the API can't read or write it.

create table public.hosted_probe_heartbeats (
  id      bigint generated always as identity primary key,
  run_id  text not null,
  at      timestamptz not null default now(),
  second  int not null,           -- seconds since the function started
  note    text not null           -- 'start' | 'beat' | 'done'
);
create index hosted_probe_heartbeats_run_idx on public.hosted_probe_heartbeats (run_id, at);

alter table public.hosted_probe_heartbeats enable row level security;
revoke all on public.hosted_probe_heartbeats from anon, authenticated;
