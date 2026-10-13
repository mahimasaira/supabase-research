-- Advanced feature 4 (DocuSign), stage 3: receiving the result.
--
-- Two ways the result arrives, both ending in the function below:
--   * docusign-webhook: DocuSign Connect calls us (needs a public URL: hosted project or tunnel)
--   * docusign-sync:    the host clicks "Check signature status"; we ask DocuSign (works locally)
-- One function = one set of rules, so the two paths can't disagree.
--
--   DocuSign envelope status   booking.status       booking.signature_status
--   completed (signed)         pending → confirmed  completed
--   declined                   pending → cancelled  declined   (slot free again)
--   voided                     pending → cancelled  voided     (slot free again)
--   anything else (sent, delivered, …): no change
--
-- Only bookings that are still pending_signature change. That makes every message safe to
-- repeat (DocuSign retries) and to arrive late or out of order: a booking the guest already
-- cancelled stays cancelled even if they sign afterwards.
-- Called by the Edge Functions over their direct database connection; no client may call it.

create function public.docusign_apply_envelope_status(p_envelope_id text, p_status text)
returns int   -- number of bookings changed (0 = nothing to do)
language plpgsql
set search_path = ''
as $$
declare
  v_changed int;
begin
  if p_status not in ('completed', 'declined', 'voided') then
    return 0;
  end if;

  update public.bookings
     set status = case when p_status = 'completed' then 'confirmed' else 'cancelled' end,
         signature_status = p_status,
         signature_error = null,
         signature_updated_at = now()
   where envelope_id = p_envelope_id
     and status = 'pending_signature';
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke execute on function public.docusign_apply_envelope_status(text, text) from public, anon, authenticated;
