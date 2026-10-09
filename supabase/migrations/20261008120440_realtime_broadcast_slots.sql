-- Step 6 (take 2): Realtime via "Broadcast from Database" instead of postgres_changes.
--
-- Why the previous migration wasn't enough: postgres_changes checks every change against
-- the subscriber's RLS SELECT policy on the *new* row. When a slot gets booked,
-- is_booked becomes true, the "Anyone can read free future slots" policy no longer
-- matches, and Realtime silently drops the event for guests. So the one event the
-- booking page needs ("this slot is gone") never arrives. Deletes aren't delivered either.
--
-- Broadcast from Database: a trigger pushes a message we build ourselves to a channel
-- ("topic"). Who may receive it is decided by RLS on realtime.messages, not on slots.

-- postgres_changes on slots is no longer used; stop streaming it.
alter publication supabase_realtime drop table public.slots;

-- One topic per host: "slots:<host_id>". Each booking page listens only to its host.
-- The payload has no guest data; it's the same info a guest could already read
-- (plus "this slot is no longer available").
create function public.broadcast_slot_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec public.slots := coalesce(new, old);
begin
  perform realtime.send(
    jsonb_build_object(
      'id',        rec.id,
      'starts_at', rec.starts_at,
      'ends_at',   rec.ends_at,
      -- false for: booked, deleted, or already started.
      'available', tg_op <> 'DELETE' and not rec.is_booked and rec.starts_at > now()
    ),
    'slot_changed',              -- event name the client listens for
    'slots:' || rec.host_id,     -- topic
    true                         -- private channel: access controlled by the policies below
  );
  return null;
end;
$$;

revoke execute on function public.broadcast_slot_change() from public, anon, authenticated;

create trigger slots_broadcast
  after insert or update or delete on public.slots
  for each row execute function public.broadcast_slot_change();

-- Realtime authorization: RLS on realtime.messages.
-- SELECT policy = may *receive* broadcasts on matching topics.
-- No INSERT policy = no client may *send* on them, so a malicious browser can't
-- broadcast fake "slot booked" messages to other viewers. Only the trigger
-- above (running as the database owner) can.
create policy "Anyone can receive slot broadcasts"
  on realtime.messages for select
  to anon, authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'slots:%'
  );
