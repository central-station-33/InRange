-- BT Capital: Investor Complaint Platform — core schema
-- Implements FINRA Rule 4513/4530-style complaint handling for a
-- Reg CF funding portal (Funding Portal Rule 300(c)).
--
-- This module is independent of the property lead-gen tables above; it
-- shares only the Supabase/Make.com/Retool stack.

-- ─── Reference number sequence ──────────────────────────────────────────────
-- Human-readable reference numbers: BTC-YYYYMMDD-00001

CREATE SEQUENCE complaint_seq;

-- ─── Core Table ─────────────────────────────────────────────────────────────

CREATE TABLE complaints (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number      TEXT        NOT NULL UNIQUE DEFAULT (
                                       'BTC-' || to_char(now(), 'YYYYMMDD') || '-' ||
                                       lpad(nextval('complaint_seq')::text, 5, '0')
                                     ),

  -- Required intake fields (FINRA 4513/4530 practice)
  complainant_name      TEXT        NOT NULL,
  complainant_address   TEXT        NOT NULL,
  account_number        TEXT        NOT NULL,
  email                 TEXT        NOT NULL,
  phone                 TEXT,
  date_received         DATE        NOT NULL DEFAULT CURRENT_DATE,
  date_of_incident      DATE,
  category              TEXT        NOT NULL CHECK (category IN (
                                       'investment_dispute', 'fund_disbursement',
                                       'unauthorized_fraud', 'misrepresentation',
                                       'technical', 'other'
                                     )),
  associated_person     TEXT,
  description            TEXT        NOT NULL CHECK (char_length(description) >= 50),
  supporting_doc_url     TEXT,
  preferred_resolution   TEXT,
  consent_acknowledged   BOOLEAN     NOT NULL DEFAULT true,

  -- How the complaint reached BT Capital. Rule 4513 only treats written
  -- complaints as reportable; phone-only complaints are logged for the
  -- single system-of-record but is_written stays false until a written
  -- record (email/DM/letter) exists.
  intake_channel         TEXT        NOT NULL DEFAULT 'web_form' CHECK (intake_channel IN (
                                        'web_form', 'email', 'social_dm', 'phone', 'other'
                                      )),
  is_written              BOOLEAN     NOT NULL DEFAULT true,
  entered_by               TEXT,       -- staff member who manually logged a non-web-form complaint

  -- Escalation flags
  involves_theft_misappropriation_forgery BOOLEAN NOT NULL DEFAULT false,
  escrow_agent_responsible                 BOOLEAN NOT NULL DEFAULT false,

  -- Status / resolution
  status                 TEXT        NOT NULL DEFAULT 'open' CHECK (status IN (
                                        'open', 'under_review', 'escalated', 'resolved', 'reported_finra'
                                      )),
  resolution_summary      TEXT,
  resolved_at              TIMESTAMPTZ,

  -- FINRA Rule 4530 30-day theft/misappropriation/forgery reporting clock
  finra_report_due_date    DATE,
  finra_reported_at         TIMESTAMPTZ,

  -- Quarterly Gateway reporting bucket, e.g. 'Q3-2026'
  quarter_reported          TEXT,

  -- Retention: 4-year minimum, 2-year readily-accessible tier (Rule 4513).
  -- No hard-delete — archived_tier is the only lifecycle transition.
  archived_tier              TEXT      NOT NULL DEFAULT 'active' CHECK (archived_tier IN (
                                          'active', 'cold_storage'
                                        )),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Escalation alert log ───────────────────────────────────────────────────
-- Idempotency guard for the day 1 / 15 / 25 compliance-officer reminders so
-- a re-run of the nightly Make.com scenario never double-sends an alert.

CREATE TABLE complaint_escalation_alerts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id  UUID        NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  alert_day     INTEGER     NOT NULL CHECK (alert_day IN (1, 15, 25, 30)),
  channel       TEXT        NOT NULL DEFAULT 'webhook',
  recipient     TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (complaint_id, alert_day)
);

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX idx_complaints_status              ON complaints(status);
CREATE INDEX idx_complaints_category             ON complaints(category);
CREATE INDEX idx_complaints_date_received        ON complaints(date_received DESC);
CREATE INDEX idx_complaints_finra_due            ON complaints(finra_report_due_date)
                                                    WHERE finra_report_due_date IS NOT NULL;
CREATE INDEX idx_complaints_quarter              ON complaints(quarter_reported);
CREATE INDEX idx_complaints_archived_tier        ON complaints(archived_tier);
CREATE INDEX idx_complaint_alerts_complaint       ON complaint_escalation_alerts(complaint_id);

-- ─── Auto-set FINRA due date, quarter bucket, updated_at ───────────────────

CREATE OR REPLACE FUNCTION set_complaint_derived_fields()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Start (or re-evaluate) the 30-day clock whenever the flag is set/updated
  -- and a due date hasn't already been recorded.
  IF NEW.involves_theft_misappropriation_forgery AND NEW.finra_report_due_date IS NULL THEN
    NEW.finra_report_due_date := NEW.date_received + INTERVAL '30 days';
    IF NEW.status = 'open' THEN
      NEW.status := 'escalated';
    END IF;
  END IF;

  IF NEW.category = 'fund_disbursement' THEN
    NEW.escrow_agent_responsible := true;
  END IF;

  NEW.quarter_reported := 'Q' || to_char(NEW.date_received, 'Q-YYYY');

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_complaint_derived_fields
  BEFORE INSERT OR UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION set_complaint_derived_fields();

-- ─── Retention housekeeping ─────────────────────────────────────────────────
-- Moves complaints older than 2 years to the cold-storage tier. Never
-- deletes rows — FINRA Rule 4513 requires 4-year minimum retention.

CREATE OR REPLACE FUNCTION archive_old_complaints()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  moved INTEGER;
BEGIN
  UPDATE complaints
  SET archived_tier = 'cold_storage'
  WHERE date_received < CURRENT_DATE - INTERVAL '2 years'
    AND archived_tier = 'active';
  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END;
$$;

-- ─── Row-Level Security ─────────────────────────────────────────────────────
-- Edge functions use the service role key (bypasses RLS). RLS is enabled so
-- Retool's authenticated role is the only client-side path to this data.

ALTER TABLE complaints                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_escalation_alerts  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read/write complaints"
  ON complaints FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth read complaint_escalation_alerts"
  ON complaint_escalation_alerts FOR SELECT TO authenticated USING (true);
