-- Advanced feature 2, stage 4: remove supa_audit again.
-- It was installed in 20261012182300_audit_supa_audit.sql only to compare it with our
-- triggers (stage 3). The comparison is recorded in FRICTION_LOG.md and reproducible at
-- commit 603a771. Keeping it would log every change twice and store cancel tokens and
-- full guest emails in audit.record_version.

select audit.disable_tracking('public.bookings'::regclass);
select audit.disable_tracking('public.slots'::regclass);
select audit.disable_tracking('public.booking_series'::regclass);
select audit.disable_tracking('public.profiles'::regclass);

-- The schema holds supa_audit's table, type and functions, and nothing else.
drop schema audit cascade;
