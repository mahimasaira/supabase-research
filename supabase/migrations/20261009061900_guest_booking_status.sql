-- Fix: guests couldn't tell that a host cancelled their booking.
-- Guests have no SELECT on bookings (RLS), so the booking page only had its own
-- localStorage copy, which never learned about host cancellations.
--
-- This RPC returns the status of bookings *by cancel token*. A guest can only ask
-- about tokens they already hold (random uuids), so it reveals nothing about other
-- people's bookings, and it returns only the status, no names or emails.
-- Called from the browser as: supabase.rpc('get_booking_statuses', { p_cancel_tokens: [...] })
create function public.get_booking_statuses(p_cancel_tokens uuid[])
returns table (cancel_token uuid, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.cancel_token, b.status
    from public.bookings b
   where b.cancel_token = any (p_cancel_tokens[1:50]);  -- cap the batch size
$$;

revoke execute on function public.get_booking_statuses(uuid[]) from public, anon, authenticated;
grant  execute on function public.get_booking_statuses(uuid[]) to anon, authenticated;
