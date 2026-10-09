-- Step 6: Realtime for slots.
-- Supabase Realtime streams changes from Postgres' write-ahead log via a *publication*
-- called supabase_realtime. Only tables added to it produce "postgres_changes" events.
-- Bookings are NOT added: guests may never see them, and the slots.is_booked flag
-- already reflects every booking/cancellation.
alter publication supabase_realtime add table public.slots;
