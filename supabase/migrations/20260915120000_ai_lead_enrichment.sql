-- InRange: AI Lead Enrichment schema (Phase 0)
-- See docs/ai-lead-enrichment-blueprint.md for the full design.
-- Additive only: no existing table, column, view, or policy is altered.

-- ─── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE lead_category AS ENUM (
  'pre_foreclosure',
  'foreclosure',
  'reo',
  'tax_lien',
  'tax_delinquent',
  'code_violation',
  'vacant',
  'absentee_owner',
  'out_of_area_owner',
  'expired_listing',
  'llc_owned',
  'investor_owned',
  'probate_estate',
  'relocation_seller'
);

CREATE TYPE owner_type AS ENUM (
  'individual',
  'llc',
  'trust',
  'estate',
  'investor_entity',
  'government',
  'unknown'
);

CREATE TYPE evidence_confidence AS ENUM (
  'confirmed',    -- backed by a primary source (public record, vendor feed, human verification)
  'ai_inferred',  -- derived by Gemini/Claude; not yet verified against a primary source
  'unverified'    -- agent- or vendor-supplied, no source check performed
);

CREATE TYPE evidence_source_type AS ENUM (
  'public_record',
  'vendor_feed',
  'ai_extraction',
  'skip_trace',
  'agent_input'
);

CREATE TYPE lead_status AS ENUM (
  'new',
  'needs_verification',
  'assigned',
  'working',
  'closed_won',
  'closed_lost',
  'disqualified'
);

CREATE TYPE ai_run_type AS ENUM (
  'primary_extraction',
  'second_pass_review'
);

-- ─── Core tables ────────────────────────────────────────────────────────────

-- One row per active lead. Built on top of an existing `properties` row;
-- a property may have more than one lead over time (e.g. re-enters
-- foreclosure after a prior lead was closed).
CREATE TABLE lead_records (
  id                 UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        UUID           NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category           lead_category  NOT NULL,
  owner_type         owner_type     NOT NULL DEFAULT 'unknown',
  status             lead_status    NOT NULL DEFAULT 'new',
  tier               INTEGER        CHECK (tier BETWEEN 1 AND 4),
  rationale          TEXT,          -- "why might this be worth investigating" — always paired with lead_evidence rows
  assigned_agent_id  UUID           REFERENCES auth.users(id),
  assignment_reason  TEXT,
  next_action_code   TEXT,          -- resolved from compliance_playbook; never written directly by AI models
  created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_lead_records_updated_at
  BEFORE UPDATE ON lead_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Provenance ledger: every fact attached to a lead, with its own source and
-- confidence. This is what makes "confirmed" vs. "needs verification"
-- queryable instead of implicit in prose.
CREATE TABLE lead_evidence (
  id             UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID                   NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  field_name     TEXT                   NOT NULL,   -- e.g. 'owner_type', 'sale_date', 'is_absentee'
  field_value    TEXT                   NOT NULL,
  confidence     evidence_confidence    NOT NULL,
  source_type    evidence_source_type   NOT NULL,
  source_detail  TEXT,                              -- dataset name, document ID, or agent note
  extracted_by   TEXT,                              -- 'gemini', 'claude', 'rule_engine', or an agent identifier
  verified_by    UUID                   REFERENCES auth.users(id),
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ            NOT NULL DEFAULT NOW()
);

-- Audit log of every Gemini/Claude enrichment call. Kept even when a
-- second-pass review supersedes a primary extraction — the reviewer's
-- verdict wins for display, but the original run stays for auditing.
CREATE TABLE ai_enrichment_runs (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID         NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  model              TEXT         NOT NULL,   -- e.g. 'gemini-2.5-pro', 'claude-sonnet-4-6'
  run_type           ai_run_type  NOT NULL,
  input_ref          JSONB        NOT NULL DEFAULT '{}',  -- pointer to what the model saw (property_id, raw_data snapshot ref, etc.)
  output             JSONB        NOT NULL DEFAULT '{}',  -- raw model output
  confidence_score   NUMERIC      CHECK (confidence_score BETWEEN 0 AND 1),
  flagged_for_review BOOLEAN      NOT NULL DEFAULT FALSE,
  reviewed_by        UUID         REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Skip-traced or agent-supplied contact info. Kept separate from
-- lead_evidence because contacts carry their own compliance flags.
CREATE TABLE lead_contacts (
  id            UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID                  NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  contact_type  TEXT                  NOT NULL CHECK (contact_type IN ('phone', 'email', 'mailing_address')),
  value         TEXT                  NOT NULL,
  source        TEXT                  NOT NULL DEFAULT 'skip_trace',
  confidence    evidence_confidence   NOT NULL DEFAULT 'unverified',
  dnc_flag      BOOLEAN               NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);

-- Compliance lookup: (category, jurisdiction) -> recommended next action.
-- AI models resolve against this table; they never generate next_action_code
-- text directly. Seed rows below are placeholders pending counsel review —
-- see docs/ai-lead-enrichment-blueprint.md §5.
CREATE TABLE compliance_playbook (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  category          lead_category  NOT NULL,
  jurisdiction      TEXT           NOT NULL,  -- e.g. 'NY', 'NJ'
  next_action_code  TEXT           NOT NULL,
  action_label      TEXT           NOT NULL,
  compliance_note   TEXT,                     -- plain-language flag, not legal advice
  counsel_reviewed  BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (category, jurisdiction)
);

INSERT INTO compliance_playbook (category, jurisdiction, next_action_code, action_label, compliance_note, counsel_reviewed) VALUES
  ('pre_foreclosure', 'NY', 'ny_pre_foreclosure_review',  'Route to compliance review before contact', 'NY imposes homeowner-protection notice and solicitation timing restrictions on pre-foreclosure outreach. Do not contact until counsel confirms current requirements.', FALSE),
  ('pre_foreclosure', 'NJ', 'nj_pre_foreclosure_review',  'Route to compliance review before contact', 'NJ Fair Foreclosure Act imposes notice and timing requirements on pre-foreclosure outreach. Do not contact until counsel confirms current requirements.', FALSE),
  ('probate_estate',  'NY', 'ny_probate_review',          'Route to compliance review before contact', 'Confirm source feed is a permitted probate source and that outreach to an estate/heir complies with applicable rules before contact.', FALSE),
  ('probate_estate',  'NJ', 'nj_probate_review',          'Route to compliance review before contact', 'Confirm source feed is a permitted probate source and that outreach to an estate/heir complies with applicable rules before contact.', FALSE)
ON CONFLICT DO NOTHING;

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX idx_lead_records_property        ON lead_records(property_id);
CREATE INDEX idx_lead_records_status          ON lead_records(status);
CREATE INDEX idx_lead_records_category        ON lead_records(category);
CREATE INDEX idx_lead_records_assigned_agent  ON lead_records(assigned_agent_id);
CREATE INDEX idx_lead_evidence_lead           ON lead_evidence(lead_id);
CREATE INDEX idx_lead_evidence_confidence     ON lead_evidence(confidence);
CREATE INDEX idx_ai_enrichment_runs_lead      ON ai_enrichment_runs(lead_id);
CREATE INDEX idx_ai_enrichment_runs_flagged   ON ai_enrichment_runs(flagged_for_review) WHERE flagged_for_review;
CREATE INDEX idx_lead_contacts_lead           ON lead_contacts(lead_id);

-- ─── Row-Level Security ─────────────────────────────────────────────────────
-- Same pattern as 20240101000000_initial_schema.sql: Edge Functions use the
-- service role key (bypasses RLS); `authenticated` gets read access, plus
-- the update access an agent needs to work a lead.

ALTER TABLE lead_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_evidence        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_enrichment_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_contacts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_playbook  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read lead_records"
  ON lead_records FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth update lead_records"
  ON lead_records FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth read lead_evidence"
  ON lead_evidence FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read ai_enrichment_runs"
  ON ai_enrichment_runs FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read lead_contacts"
  ON lead_contacts FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth update lead_contacts"
  ON lead_contacts FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth read compliance_playbook"
  ON compliance_playbook FOR SELECT TO authenticated USING (true);

-- ─── Agent-facing view ──────────────────────────────────────────────────────

-- Joins a lead to its property, its latest confirmed evidence per field,
-- and its resolved compliance action. This is the read model an agent
-- workbench (Retool or CRM UI) should query — never lead_evidence directly,
-- so confirmed/unverified stays visually distinct at the source.
CREATE OR REPLACE VIEW lead_workbench AS
SELECT
  lr.id                    AS lead_id,
  lr.category,
  lr.owner_type,
  lr.status,
  lr.tier,
  lr.rationale,
  lr.assigned_agent_id,
  lr.assignment_reason,
  p.address,
  p.city,
  p.state,
  p.zip,
  p.county,
  p.owner_name,
  cp.next_action_code,
  cp.action_label          AS next_action_label,
  cp.compliance_note,
  cp.counsel_reviewed,
  (
    SELECT COUNT(*) FROM lead_evidence le
    WHERE le.lead_id = lr.id AND le.confidence = 'confirmed'
  ) AS confirmed_fact_count,
  (
    SELECT COUNT(*) FROM lead_evidence le
    WHERE le.lead_id = lr.id AND le.confidence IN ('ai_inferred', 'unverified')
  ) AS unverified_fact_count,
  lr.created_at,
  lr.updated_at
FROM lead_records lr
JOIN properties p ON p.id = lr.property_id
LEFT JOIN compliance_playbook cp
  ON cp.category = lr.category AND cp.jurisdiction = p.state
ORDER BY lr.tier NULLS LAST, lr.updated_at DESC;
