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

-- Matches the required agent/UI-facing vocabulary exactly (see
-- docs/ai-lead-enrichment-blueprint.md §10, Fair Housing & Consumer
-- Protection) — this is the label shown next to every fact, so its
-- wording is load-bearing, not stylistic. "Missing data" is not a value
-- here: the absence of a current lead_evidence row for an expected
-- field_name (see lead_evidence_current) IS the missing-data state;
-- inventing a row to represent "we don't know this" would be worse than
-- having no row. "Human review requirement" is likewise not a confidence
-- level — see lead_evidence.needs_human_review below, which is orthogonal
-- to confidence (a source-supported signal can still be in conflict with
-- another source and need a human to resolve it).
CREATE TYPE evidence_confidence AS ENUM (
  'confirmed_fact',          -- an authoritative primary source: a recorded document or a structured public/vendor record taken at face value. No reasonable dispute.
  'source_supported_signal', -- an objective, rule-derived comparison over verified/sourced data (e.g. mailing address vs. property address, a recorded multi-property count) — real, but derived, not itself a single document
  'hypothesis',               -- AI-generated or otherwise speculative. For agent research only — NEVER a basis for scoring, targeting, exclusion, or outreach on its own, and NEVER presented to an agent as settled
  'unverified'                -- a human- or vendor-asserted claim with no structural source check performed (e.g. a raw agent note, an unconfirmed vendor claim)
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
-- confidence. This is what makes "confirmed fact" vs. "source-supported
-- signal" vs. "hypothesis" vs. "needs human review" queryable instead of
-- implicit in prose (see the evidence_confidence enum above and
-- needs_human_review below).
--
-- Rows here are append-only — no field is ever edited and no row is ever
-- deleted, enforced below by trg_lead_evidence_immutable (a BEFORE UPDATE
-- OR DELETE trigger, not just an application-code convention — it fires
-- regardless of role, including the service-role key). A verification or
-- correction is a NEW row with `supersedes_id` pointing at the row it
-- confirms/corrects; the original stays exactly as written, satisfying
-- "reversible without deleting original evidence" as a DB guarantee.
--
-- `is_current` is the one narrow, system-managed exception: it is flipped
-- true->false on the superseded row automatically, by
-- trg_lead_evidence_supersede, when a new row naming it in supersedes_id
-- is inserted — never by application code directly. This turns "what's
-- true right now for this lead" from a full-history scan-and-check
-- (every historical row, anti-joined against every other row) into a
-- direct indexed lookup (`WHERE lead_id = ? AND is_current`), which
-- matters once a field has been corrected several times over a lead's
-- life and an agent workbench is polling this table repeatedly. No fact
-- is edited or lost by this flip — is_current=false rows remain queryable
-- in full, exactly as before.
--
-- Because rows can never be updated in place otherwise, verified_by/
-- verified_at are set at INSERT time only: they describe a row that
-- itself represents a human verification action (source_type =
-- 'agent_input', confidence = 'confirmed_fact'), not a later sign-off
-- bolted onto an AI-authored row.
--
-- needs_human_review flags "data conflicts that require human review" —
-- one of the explicitly permitted signal types in
-- docs/ai-lead-enrichment-blueprint.md §10. It's set at insert time (like
-- everything else here) when a new current row disagrees with what it
-- supersedes; resolving the conflict is, as always, a further superseding
-- insert, not a mutation of this flag.
--
-- lead_evidence_field_name_not_prohibited is a defense-in-depth blocklist,
-- not a complete guarantee: it catches an engineer or a careless prompt
-- literally naming a field after a protected characteristic or a
-- prohibited inference (race, religion, disability, divorce_status,
-- financial_hardship, health_status, immigration_status,
-- family_composition, vulnerability, etc. — see §10 for the full list and
-- rationale). It cannot catch a semantic proxy smuggled into field_value
-- or free text (source_detail, lead_records.rationale,
-- ai_enrichment_runs.output) — that has to be caught at prompt design and
-- human review time, which §10 covers.
CREATE TABLE lead_evidence (
  id                 UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID                   NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  field_name         TEXT                   NOT NULL,   -- e.g. 'owner_type', 'sale_date', 'is_absentee'
  field_value        TEXT                   NOT NULL,
  confidence         evidence_confidence    NOT NULL,
  source_type        evidence_source_type   NOT NULL,
  source_detail      TEXT,                              -- dataset name, document ID, or agent note
  extracted_by       TEXT,                              -- 'gemini', 'claude', 'rule_engine', or an agent identifier — descriptive only, not the audit link
  ai_run_id          UUID                   REFERENCES ai_enrichment_runs(id),  -- REQUIRED (see CHECK below) whenever source_type = 'ai_extraction'; the actual audit link
  supersedes_id      UUID                   REFERENCES lead_evidence(id),       -- set when this row verifies or corrects an earlier row for the same field_name
  is_current         BOOLEAN                NOT NULL DEFAULT TRUE,              -- system-managed only; see trg_lead_evidence_supersede
  needs_human_review BOOLEAN                NOT NULL DEFAULT FALSE,             -- set at insert time when this row conflicts with what it supersedes
  verified_by        UUID                   REFERENCES auth.users(id),
  verified_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_evidence_must_link_to_run
    CHECK (source_type <> 'ai_extraction' OR ai_run_id IS NOT NULL),
  -- The blueprint's first design rule, DB-enforced rather than just
  -- documented: an AI model's own extraction can never be recorded as a
  -- verified fact. A human reviewer confirming an AI-inferred value still
  -- inserts a NEW row (source_type = 'agent_input', confidence =
  -- 'confirmed_fact') per the supersedes_id model above — that's a human
  -- act of verification, not the model asserting its own output as true.
  CONSTRAINT ai_extraction_never_confirmed_fact
    CHECK (source_type <> 'ai_extraction' OR confidence <> 'confirmed_fact'),
  -- Leading boundary only (^ or preceded by _/-), deliberately no trailing
  -- boundary: several of these are stems meant to catch suffixed variants
  -- (divorc -> divorced/divorce_status, disab -> disability/disabled,
  -- vulnerab -> vulnerable/vulnerability, handicap -> handicapped). A
  -- trailing boundary would silently defeat exactly those — verified
  -- against a local Postgres instance that 'divorce_status' is rejected
  -- and that leading-boundary real NJ county names sharing a substring
  -- (essex_county, middlesex_county — both in docs/data-sources.md) are
  -- NOT false-flagged, since "sex" only matches when it starts a token.
  CONSTRAINT lead_evidence_field_name_not_prohibited
    CHECK (field_name !~* '(^|[_-])(race|color|religion|creed|national[_-]?origin|nationality|citizenship|immigrat|ethnicit|sex|gender|transgender|cisgender|sexual[_-]?orientation|disab|handicap|familial[_-]?status|family[_-]?composition|marital[_-]?status|divorc|financial[_-]?hardship|hardship|health|medical|vulnerab|protected[_-]?class|intent[_-]?to[_-]?sell)')
);

-- Allows only one narrow UPDATE: is_current flipping TRUE -> FALSE with
-- every other column unchanged (the automatic supersede flip below).
-- Everything else — any other column change, is_current flipping the
-- other direction, and every DELETE — is rejected.
CREATE OR REPLACE FUNCTION prevent_lead_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.is_current IS TRUE AND NEW.is_current IS FALSE
     AND NEW.lead_id       IS NOT DISTINCT FROM OLD.lead_id
     AND NEW.field_name    IS NOT DISTINCT FROM OLD.field_name
     AND NEW.field_value   IS NOT DISTINCT FROM OLD.field_value
     AND NEW.confidence    IS NOT DISTINCT FROM OLD.confidence
     AND NEW.source_type   IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_detail IS NOT DISTINCT FROM OLD.source_detail
     AND NEW.extracted_by  IS NOT DISTINCT FROM OLD.extracted_by
     AND NEW.ai_run_id     IS NOT DISTINCT FROM OLD.ai_run_id
     AND NEW.supersedes_id      IS NOT DISTINCT FROM OLD.supersedes_id
     AND NEW.needs_human_review IS NOT DISTINCT FROM OLD.needs_human_review
     AND NEW.verified_by        IS NOT DISTINCT FROM OLD.verified_by
     AND NEW.verified_at        IS NOT DISTINCT FROM OLD.verified_at
     AND NEW.created_at         IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'lead_evidence is append-only except the system-managed is_current flag: % is not permitted on id=%. Insert a new row with supersedes_id set instead.',
    TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER trg_lead_evidence_immutable
  BEFORE UPDATE OR DELETE ON lead_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_lead_evidence_mutation();

-- Auto-retires the row being superseded. Runs BEFORE INSERT so the old
-- row is already flipped to is_current=FALSE before the new row's own
-- insert is evaluated against idx_lead_evidence_one_current_per_field —
-- otherwise both rows would briefly be "current" for the same field and
-- the unique index would reject the insert.
CREATE OR REPLACE FUNCTION lead_evidence_supersede()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    UPDATE lead_evidence
    SET is_current = FALSE
    WHERE id = NEW.supersedes_id AND is_current = TRUE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lead_evidence_supersede
  BEFORE INSERT ON lead_evidence
  FOR EACH ROW EXECUTE FUNCTION lead_evidence_supersede();

-- Safety net: at most one current row per (lead, field). If application
-- code inserts a new current fact for a field without pointing
-- supersedes_id at the row it replaces, this rejects the insert instead
-- of silently leaving two "current" facts that disagree.
CREATE UNIQUE INDEX idx_lead_evidence_one_current_per_field
  ON lead_evidence(lead_id, field_name) WHERE is_current;

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
-- (idx_lead_evidence_one_current_per_field is defined above, next to the
-- trigger it backs, since it's an invariant rather than a plain perf index)

CREATE INDEX idx_lead_records_property        ON lead_records(property_id);
CREATE INDEX idx_lead_records_status          ON lead_records(status);
CREATE INDEX idx_lead_records_category        ON lead_records(category);
CREATE INDEX idx_lead_records_assigned_agent  ON lead_records(assigned_agent_id);
CREATE INDEX idx_lead_evidence_lead           ON lead_evidence(lead_id);
CREATE INDEX idx_lead_evidence_ai_run         ON lead_evidence(ai_run_id) WHERE ai_run_id IS NOT NULL;
CREATE INDEX idx_lead_evidence_supersedes     ON lead_evidence(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX idx_lead_evidence_confidence     ON lead_evidence(confidence);
CREATE INDEX idx_lead_evidence_needs_review   ON lead_evidence(lead_id) WHERE needs_human_review;
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

-- ─── Agent-facing views ─────────────────────────────────────────────────────

-- The current fact set: exactly one row per (lead, field_name) — the tip
-- of each field's supersession chain. A direct filter on the system-
-- managed is_current flag (backed by idx_lead_evidence_one_current_per_field),
-- not a full-history scan-and-anti-join. This is what agent-facing code
-- should query to answer "what's true right now" for a lead; lead_evidence
-- itself stays the full append-only history for auditing.
CREATE OR REPLACE VIEW lead_evidence_current AS
SELECT *
FROM lead_evidence
WHERE is_current;

-- Joins a lead to its property, its resolved compliance action, and one
-- aggregate pass over its current evidence — one column per required
-- distinction (see docs/ai-lead-enrichment-blueprint.md §10): confirmed
-- fact, source-supported signal, hypothesis, unverified, and needs-review.
-- "Missing data" isn't a count here — it's whatever expected field_name
-- has no row at all, which agent-facing code checks for directly. This is
-- the read model an agent workbench (Retool or CRM UI) should query —
-- never lead_evidence directly, so these stay visually distinct at the
-- source rather than collapsed into one ambiguous label.
--
-- The evidence-count aggregation is a single GROUP BY joined once per
-- lead, not five separate correlated subqueries re-scanning
-- lead_evidence_current per lead — the count columns are cheap to add to
-- because they're FILTER clauses over the same one pass, not five passes.
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
  cp.action_label                   AS next_action_label,
  cp.compliance_note,
  cp.counsel_reviewed,
  COALESCE(ec.confirmed_fact_count, 0)          AS confirmed_fact_count,
  COALESCE(ec.source_supported_count, 0)        AS source_supported_count,
  COALESCE(ec.hypothesis_count, 0)              AS hypothesis_count,
  COALESCE(ec.unverified_count, 0)              AS unverified_count,
  COALESCE(ec.needs_review_count, 0)            AS needs_review_count,
  lr.created_at,
  lr.updated_at
FROM lead_records lr
JOIN properties p ON p.id = lr.property_id
LEFT JOIN compliance_playbook cp
  ON cp.category = lr.category AND cp.jurisdiction = p.state
LEFT JOIN (
  SELECT
    lead_id,
    COUNT(*) FILTER (WHERE confidence = 'confirmed_fact')          AS confirmed_fact_count,
    COUNT(*) FILTER (WHERE confidence = 'source_supported_signal') AS source_supported_count,
    COUNT(*) FILTER (WHERE confidence = 'hypothesis')              AS hypothesis_count,
    COUNT(*) FILTER (WHERE confidence = 'unverified')               AS unverified_count,
    COUNT(*) FILTER (WHERE needs_human_review)                      AS needs_review_count
  FROM lead_evidence_current
  GROUP BY lead_id
) ec ON ec.lead_id = lr.id
ORDER BY lr.tier NULLS LAST, lr.updated_at DESC;
