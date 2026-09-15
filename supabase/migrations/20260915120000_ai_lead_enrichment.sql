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

-- Audit log of every Gemini/Claude enrichment call. Kept even when a
-- second-pass review supersedes a primary extraction — the reviewer's
-- verdict wins for display, but the original run stays for auditing.
-- Created before lead_evidence so evidence rows can hold a real FK back to
-- the run that produced them, not just a free-text model-name label.
--
-- input_ref/output must never contain lead_contacts values (phone, email,
-- mailing address) or any other raw consumer contact data — only what was
-- actually necessary for classification (property + score + public raw_data).
-- See docs/ai-lead-enrichment-blueprint.md §9 (Security & Data Handling).
CREATE TABLE ai_enrichment_runs (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID         NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  model              TEXT         NOT NULL,   -- e.g. 'gemini-2.5-pro', 'claude-sonnet-4-6'
  run_type           ai_run_type  NOT NULL,
  input_ref          JSONB        NOT NULL DEFAULT '{}',  -- pointer to what the model saw (property_id, raw_data snapshot ref, etc.) — never contact data
  output             JSONB        NOT NULL DEFAULT '{}',  -- raw model output
  confidence_score   NUMERIC      CHECK (confidence_score BETWEEN 0 AND 1),
  flagged_for_review BOOLEAN      NOT NULL DEFAULT FALSE,
  reviewed_by        UUID         REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Audit-log guard: DELETE is never permitted. UPDATE is permitted only to
-- record a human review sign-off (reviewed_by, flagged_for_review) — every
-- other column, including the model output itself, is immutable once
-- written. Fires regardless of role, including the service-role key.
CREATE OR REPLACE FUNCTION prevent_ai_run_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai_enrichment_runs is an audit log: DELETE is not permitted on id=%.', OLD.id;
  END IF;

  IF NEW.lead_id            IS DISTINCT FROM OLD.lead_id
     OR NEW.model            IS DISTINCT FROM OLD.model
     OR NEW.run_type         IS DISTINCT FROM OLD.run_type
     OR NEW.input_ref        IS DISTINCT FROM OLD.input_ref
     OR NEW.output           IS DISTINCT FROM OLD.output
     OR NEW.confidence_score IS DISTINCT FROM OLD.confidence_score
     OR NEW.created_at       IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'ai_enrichment_runs is an audit log: only reviewed_by and flagged_for_review may change on id=%.', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_enrichment_runs_guard
  BEFORE UPDATE OR DELETE ON ai_enrichment_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_run_mutation();

-- Provenance ledger: every fact attached to a lead, with its own source and
-- confidence. This is what makes "confirmed" vs. "needs verification"
-- queryable instead of implicit in prose.
--
-- Rows here are append-only, enforced below by trg_lead_evidence_immutable
-- (a BEFORE UPDATE OR DELETE trigger, not just an application-code
-- convention — it fires regardless of role, including the service-role
-- key, so a bug in Edge Function code cannot mutate or delete a row). A
-- verification or correction is a NEW row with `supersedes_id` pointing at
-- the row it confirms/corrects; the original stays exactly as written,
-- satisfying "reversible without deleting original evidence" as a DB
-- guarantee rather than a documented convention.
--
-- Because rows can never be updated in place, verified_by/verified_at are
-- set at INSERT time only: they describe a row that itself represents a
-- human verification action (source_type = 'agent_input', confidence =
-- 'confirmed'), not a later sign-off bolted onto an AI-authored row.
CREATE TABLE lead_evidence (
  id             UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID                   NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  field_name     TEXT                   NOT NULL,   -- e.g. 'owner_type', 'sale_date', 'is_absentee'
  field_value    TEXT                   NOT NULL,
  confidence     evidence_confidence    NOT NULL,
  source_type    evidence_source_type   NOT NULL,
  source_detail  TEXT,                              -- dataset name, document ID, or agent note
  extracted_by   TEXT,                              -- 'gemini', 'claude', 'rule_engine', or an agent identifier — descriptive only, not the audit link
  ai_run_id      UUID                   REFERENCES ai_enrichment_runs(id),  -- REQUIRED (see CHECK below) whenever source_type = 'ai_extraction'; the actual audit link
  supersedes_id  UUID                   REFERENCES lead_evidence(id),       -- set when this row verifies or corrects an earlier row for the same field_name
  verified_by    UUID                   REFERENCES auth.users(id),
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_evidence_must_link_to_run
    CHECK (source_type <> 'ai_extraction' OR ai_run_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION prevent_lead_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'lead_evidence is append-only: % is not permitted on id=%. Insert a new row with supersedes_id set instead.',
    TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER trg_lead_evidence_immutable
  BEFORE UPDATE OR DELETE ON lead_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_lead_evidence_mutation();

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
CREATE INDEX idx_lead_evidence_ai_run         ON lead_evidence(ai_run_id) WHERE ai_run_id IS NOT NULL;
CREATE INDEX idx_lead_evidence_supersedes     ON lead_evidence(supersedes_id) WHERE supersedes_id IS NOT NULL;
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
--
-- Fact counts below only count "current" evidence — rows that are not
-- referenced by some later row's supersedes_id. Because lead_evidence is
-- append-only (see trg_lead_evidence_immutable), a verified or corrected
-- fact exists as two rows (the original plus the row that supersedes it);
-- counting both would double-count and misrepresent how much of a lead is
-- actually still unverified.
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
      AND NOT EXISTS (SELECT 1 FROM lead_evidence le2 WHERE le2.supersedes_id = le.id)
  ) AS confirmed_fact_count,
  (
    SELECT COUNT(*) FROM lead_evidence le
    WHERE le.lead_id = lr.id AND le.confidence IN ('ai_inferred', 'unverified')
      AND NOT EXISTS (SELECT 1 FROM lead_evidence le2 WHERE le2.supersedes_id = le.id)
  ) AS unverified_fact_count,
  lr.created_at,
  lr.updated_at
FROM lead_records lr
JOIN properties p ON p.id = lr.property_id
LEFT JOIN compliance_playbook cp
  ON cp.category = lr.category AND cp.jurisdiction = p.state
ORDER BY lr.tier NULLS LAST, lr.updated_at DESC;
