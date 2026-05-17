-- Migration: Cadence tracking columns for automated follow-up sequence
-- Applied: 2026-05-15
--
-- cadence_step:    which step of the sequence this lead is on (0 = not started)
-- last_cadence_at: when the last cadence SMS was sent
-- cadence_paused:  set true when lead replies, books appt, or opts out

ALTER TABLE isa_leads
  ADD COLUMN IF NOT EXISTS cadence_step    SMALLINT    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_cadence_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cadence_paused  BOOLEAN     NOT NULL DEFAULT false;

COMMENT ON COLUMN isa_leads.cadence_step    IS '0=not started, 1=day1, 2=day3, 3=day7, 4=day14, 5=day30 (complete)';
COMMENT ON COLUMN isa_leads.last_cadence_at IS 'Timestamp of the last auto cadence SMS sent to this lead.';
COMMENT ON COLUMN isa_leads.cadence_paused  IS 'True when cadence is paused (replied, appointment set, opted out).';

-- Automatically pause cadence when a lead reaches appointment_set or dead/closed.
CREATE OR REPLACE FUNCTION pause_cadence_on_terminal_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outreach_status IN ('appointment_set', 'dead', 'closed')
     AND (OLD.outreach_status IS DISTINCT FROM NEW.outreach_status) THEN
    NEW.cadence_paused := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pause_cadence ON isa_leads;
CREATE TRIGGER trg_pause_cadence
  BEFORE UPDATE ON isa_leads
  FOR EACH ROW EXECUTE FUNCTION pause_cadence_on_terminal_status();
