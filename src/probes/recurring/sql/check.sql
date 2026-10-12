-- Paste into Supabase Studio → SQL Editor (http://127.0.0.1:54323) after a probe run.
-- Studio runs as the database owner, so you see everything (RLS doesn't hide rows here).

-- 1. Every series and how many of its weeks were actually saved.
--    All-or-nothing means: weeks_saved is either 0 rows (no series at all) or = weeks_requested.
--    A row with weeks_saved < weeks_requested is a half-finished recurring booking.
select s.created_at,
       s.guest_name,
       s.weeks                                              as weeks_requested,
       count(b.id)                                          as weeks_saved,
       string_agg(b.week_no::text, ', ' order by b.week_no) as saved_weeks,
       s.id                                                 as series_id
  from public.booking_series s
  left join public.bookings b on b.series_id = s.id
 where s.host_id = '11111111-1111-4111-8111-111111111111'
 group by s.id
 order by s.created_at desc;

-- 2. The test host's 6 Mondays: who holds each slot.
select row_number() over (order by sl.starts_at) as week,
       sl.starts_at,
       sl.is_booked,
       b.guest_name,
       b.series_id,
       b.week_no
  from public.slots sl
  left join public.bookings b on b.slot_id = sl.id and b.status = 'confirmed'
 where sl.host_id = '11111111-1111-4111-8111-111111111111'
 order by sl.starts_at;
