-- SMS opt-out tracking for isa_leads.
--
-- Twilio credentials were just configured on this project, which means
-- respond-lead and follow-up-cadence are now able to send real SMS. Neither
-- function had any way to record or honor a STOP/UNSUBSCRIBE reply before
-- this migration -- cadence_paused only ever got set on outreach_status
-- reaching appointment_set/dead/closed, never on an opt-out. This adds an
-- explicit, independent field for it so opt-out isn't inferred from an
-- overloaded status field, and enforces at the trigger level (not just in
-- application code) that an opted-out lead can never have cadence_paused
-- flip back to false.

ALTER TABLE public.isa_leads
  ADD COLUMN IF NOT EXISTS sms_opt_out    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_opt_out_at TIMESTAMPTZ;

COMMENT ON COLUMN public.isa_leads.sms_opt_out IS 'True once this lead has replied STOP/UNSUBSCRIBE/CANCEL/QUIT/END to an SMS. Must never be reset to false by anything other than a documented, explicit re-consent action.';
COMMENT ON COLUMN public.isa_leads.sms_opt_out_at IS 'When sms_opt_out was set true. Kept for audit/compliance -- do not delete rows to "clean up" opt-outs.';

CREATE INDEX IF NOT EXISTS idx_isa_leads_sms_opt_out ON public.isa_leads (sms_opt_out) WHERE sms_opt_out = true;

-- Defense in depth: enforce the invariant at the trigger level too, so a
-- future code path that updates isa_leads directly (a manual admin edit, a
-- bulk script, another function) can't silently resume cadence on an
-- opted-out lead just by forgetting this check.
CREATE OR REPLACE FUNCTION public.pause_cadence_on_terminal_status()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  IF NEW.outreach_status IN ('appointment_set', 'dead', 'closed')
     AND (OLD.outreach_status IS DISTINCT FROM NEW.outreach_status) THEN
    NEW.cadence_paused := true;
  END IF;
  IF NEW.sms_opt_out = true THEN
    NEW.cadence_paused := true;
  END IF;
  RETURN NEW;
END;
$function$;
