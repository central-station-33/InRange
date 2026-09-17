-- InRange: Canonical data model
--
-- Introduces the canonical CRM schema: immutable raw ingestion storage,
-- canonical properties/parties, source-backed relationships between them,
-- an operational leads table, and an auditable enrichment-run ledger.
--
-- This is additive only — it does not touch legacy_properties,
-- property_scores, subscribers, notifications, or activity_log from prior
-- migrations, and no existing edge function is rewired to use these tables
-- in this migration. Wiring the ingest/score/enrich pipeline onto this
-- model is a separate, follow-up change.
--
-- Multi-tenancy: every table below carries `organization_id`. This repo
-- had no tenancy concept before now, so a minimal `organizations` table is
-- introduced here purely to give `organization_id` a real foreign key
-- target — it is not part of the requested table list and can be replaced
-- with an existing org/account table if one is introduced elsewhere.

-- ─── Organizations (tenancy root) ──────────────────────────────────────────

CREATE TABLE organizations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 1. raw_records ─────────────────────────────────────────────────────────
-- Immutable ingestion storage for vendor imports, public-record imports,
-- agent uploads, webhook payloads, and CSV rows.

CREATE TABLE raw_records (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID        NOT NULL REFERENCES organizations(id),
  source_name                 TEXT        NOT NULL,
  source_record_id            TEXT,
  source_type                 TEXT        NOT NULL,
  ingestion_batch_id          UUID,
  raw_payload_json            JSONB       NOT NULL,
  raw_file_path                TEXT,
  source_url                  TEXT,
  source_document_reference   TEXT,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                  TEXT        NOT NULL DEFAULT 'system',
  checksum                    TEXT,
  -- Not part of the spec's allowed-value lists; a small fixed lifecycle is
  -- assumed here for basic pipeline bookkeeping and is easy to widen later.
  processing_status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (processing_status IN (
                                 'pending', 'processing', 'processed', 'failed', 'duplicate', 'skipped'
                               )),
  processing_error            TEXT
);

-- Rule: deduplicate by source_name + source_record_id + checksum where
-- applicable — i.e. only when both fields that make the tuple meaningful
-- are actually present.
CREATE UNIQUE INDEX idx_raw_records_dedupe
  ON raw_records (source_name, source_record_id, checksum)
  WHERE source_record_id IS NOT NULL AND checksum IS NOT NULL;

CREATE INDEX idx_raw_records_org            ON raw_records(organization_id);
CREATE INDEX idx_raw_records_batch          ON raw_records(ingestion_batch_id);
CREATE INDEX idx_raw_records_status         ON raw_records(processing_status);
CREATE INDEX idx_raw_records_source         ON raw_records(source_name);
CREATE INDEX idx_raw_records_payload_gin    ON raw_records USING GIN (raw_payload_json);

-- Rule: do not update raw_payload_json after insertion.
CREATE OR REPLACE FUNCTION prevent_raw_payload_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.raw_payload_json IS DISTINCT FROM OLD.raw_payload_json THEN
    RAISE EXCEPTION 'raw_records.raw_payload_json is immutable and cannot be modified after insertion (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_raw_records_immutable_payload
  BEFORE UPDATE ON raw_records
  FOR EACH ROW EXECUTE FUNCTION prevent_raw_payload_update();

-- Rule: raw records are not directly editable in the CRM UI — read-only
-- for the authenticated (Retool) role; only the service role (edge
-- functions) can insert/update processing_status/processing_error.
ALTER TABLE raw_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read raw_records"
  ON raw_records FOR SELECT TO authenticated USING (true);

-- ─── 2. properties (canonical) ─────────────────────────────────────────────

CREATE TABLE properties (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID        NOT NULL REFERENCES organizations(id),
  normalized_address TEXT,
  address_line_1     TEXT,
  address_line_2     TEXT,
  city               TEXT,
  state              TEXT,
  postal_code        TEXT,
  county             TEXT,
  parcel_id          TEXT,
  property_type      TEXT,
  unit_count         INTEGER,
  year_built         INTEGER,
  living_area_sqft   NUMERIC,
  lot_size           NUMERIC,
  latitude           NUMERIC,
  longitude          NUMERIC,
  canonical_source   TEXT,
  source_confidence  NUMERIC    CHECK (source_confidence BETWEEN 0 AND 1),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Note: index names don't follow `ALTER TABLE ... RENAME TO`, so
-- `idx_properties_county` etc. from the pre-rename schema still exist
-- (now bound to legacy_properties) — these new indexes use distinct names
-- to avoid colliding with them.
CREATE INDEX idx_properties_org                 ON properties(organization_id);
CREATE INDEX idx_properties_normalized_address  ON properties(normalized_address);
CREATE INDEX idx_properties_parcel              ON properties(parcel_id);
CREATE INDEX idx_properties_canonical_county    ON properties(county);
CREATE INDEX idx_properties_postal_code         ON properties(postal_code);

CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read properties_canonical"
  ON properties FOR SELECT TO authenticated USING (true);

-- ─── 3. parties ─────────────────────────────────────────────────────────────

CREATE TABLE parties (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID        NOT NULL REFERENCES organizations(id),
  party_type                  TEXT        NOT NULL DEFAULT 'unknown'
                               CHECK (party_type IN (
                                 'individual', 'llc', 'corporation', 'trust', 'estate',
                                 'bank', 'government', 'nonprofit', 'unknown'
                               )),
  legal_name                  TEXT,
  normalized_name              TEXT,
  first_name                  TEXT,
  middle_name                 TEXT,
  last_name                   TEXT,
  entity_name                 TEXT,
  entity_state                TEXT,
  entity_registration_number  TEXT,
  canonical_source            TEXT,
  source_confidence           NUMERIC     CHECK (source_confidence BETWEEN 0 AND 1),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_parties_org               ON parties(organization_id);
CREATE INDEX idx_parties_normalized_name   ON parties(normalized_name);
CREATE INDEX idx_parties_entity_reg_number ON parties(entity_registration_number);
CREATE INDEX idx_parties_type              ON parties(party_type);

CREATE TRIGGER trg_parties_updated_at
  BEFORE UPDATE ON parties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read parties"
  ON parties FOR SELECT TO authenticated USING (true);

-- ─── 4. property_party_relationships ───────────────────────────────────────

CREATE TABLE property_party_relationships (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID        NOT NULL REFERENCES organizations(id),
  property_id           UUID        NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  party_id              UUID        NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  relationship_type     TEXT        NOT NULL DEFAULT 'unknown'
                        CHECK (relationship_type IN (
                          'owner', 'former_owner', 'mailing_contact', 'trustee', 'beneficiary',
                          'borrower', 'lender', 'plaintiff', 'defendant', 'manager', 'member',
                          'authorized_contact', 'agent', 'unknown'
                        )),
  ownership_percentage  NUMERIC     CHECK (ownership_percentage BETWEEN 0 AND 100),
  start_date            DATE,
  end_date              DATE,
  -- The specific raw record that evidences this relationship, if any.
  source_record_id      UUID        REFERENCES raw_records(id) ON DELETE SET NULL,
  source_reference      TEXT,
  -- Not part of the spec's allowed-value lists; assumed lifecycle for a
  -- "source-backed" relationship, easy to widen later.
  verification_status   TEXT        NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN (
                          'unverified', 'source_backed', 'human_verified', 'disputed'
                        )),
  confidence            NUMERIC     CHECK (confidence BETWEEN 0 AND 1),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ppr_org               ON property_party_relationships(organization_id);
CREATE INDEX idx_ppr_property          ON property_party_relationships(property_id);
CREATE INDEX idx_ppr_party             ON property_party_relationships(party_id);
CREATE INDEX idx_ppr_relationship_type ON property_party_relationships(relationship_type);
CREATE INDEX idx_ppr_source_record     ON property_party_relationships(source_record_id);

CREATE TRIGGER trg_ppr_updated_at
  BEFORE UPDATE ON property_party_relationships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE property_party_relationships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read property_party_relationships"
  ON property_party_relationships FOR SELECT TO authenticated USING (true);

-- ─── 5. leads ───────────────────────────────────────────────────────────────

CREATE TABLE leads (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID        NOT NULL REFERENCES organizations(id),
  property_id            UUID        NOT NULL REFERENCES properties(id),
  primary_party_id       UUID        REFERENCES parties(id) ON DELETE SET NULL,
  -- Not part of the spec's allowed-value lists; org-specific pipeline
  -- stages are expected to vary, so these are left unconstrained.
  lead_status            TEXT        NOT NULL DEFAULT 'new',
  lead_stage             TEXT,
  lead_source            TEXT,
  assigned_agent_id      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  priority_tier          TEXT        NOT NULL DEFAULT 'hold'
                         CHECK (priority_tier IN ('A', 'B', 'C', 'D', 'hold')),
  deterministic_score    NUMERIC,
  ai_signal_score        NUMERIC,
  final_priority_score   NUMERIC,
  campaign_eligible      BOOLEAN     NOT NULL DEFAULT FALSE,
  human_review_required  BOOLEAN     NOT NULL DEFAULT FALSE,
  next_action            TEXT,
  next_action_due_at     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Rule: do not calculate final_priority_score solely from AI output.
  -- Enforced literally: a final score can only be recorded alongside a
  -- deterministic (rules-based) score it can be blended with.
  CONSTRAINT final_score_requires_deterministic_input
    CHECK (final_priority_score IS NULL OR deterministic_score IS NOT NULL)
);

COMMENT ON CONSTRAINT final_score_requires_deterministic_input ON leads IS
  'Enforces "do not calculate final_priority_score solely from AI output" — final_priority_score cannot be set without a deterministic_score also present.';

CREATE INDEX idx_leads_org               ON leads(organization_id);
CREATE INDEX idx_leads_property          ON leads(property_id);
CREATE INDEX idx_leads_status            ON leads(lead_status);
CREATE INDEX idx_leads_priority_tier     ON leads(priority_tier);
CREATE INDEX idx_leads_assigned_agent    ON leads(assigned_agent_id);
CREATE INDEX idx_leads_next_action_due   ON leads(next_action_due_at);
CREATE INDEX idx_leads_campaign_eligible ON leads(campaign_eligible) WHERE campaign_eligible = TRUE;

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Leads are actively managed by human agents (status, assignment, next
-- action) — same access pattern as `subscribers`, the other
-- human-operated table in this schema.
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth manage leads"
  ON leads FOR ALL TO authenticated USING (true);

-- ─── 6. enrichment_runs ─────────────────────────────────────────────────────

CREATE TABLE enrichment_runs (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID        NOT NULL REFERENCES organizations(id),
  lead_id                UUID        REFERENCES leads(id) ON DELETE SET NULL,
  raw_record_id          UUID        REFERENCES raw_records(id) ON DELETE SET NULL,
  provider               TEXT        NOT NULL
                         CHECK (provider IN ('gemini', 'anthropic', 'internal_rules', 'skipdata', 'human')),
  model_name             TEXT,
  task_type              TEXT        NOT NULL
                         CHECK (task_type IN (
                           'normalize_record', 'classify_party', 'extract_document',
                           'create_lead_brief', 'identify_data_conflicts', 'create_call_plan',
                           'draft_outreach', 'claude_escalation_review', 'qa_review'
                         )),
  prompt_version         TEXT,
  input_hash             TEXT,
  output_json            JSONB,
  output_schema_version  TEXT,
  -- Not part of the spec's allowed-value lists; mirrors the run-lifecycle
  -- pattern already used by `ingestion_runs` in this schema.
  status                 TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  estimated_cost         NUMERIC,
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  error_message          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_enrichment_runs_org         ON enrichment_runs(organization_id);
CREATE INDEX idx_enrichment_runs_lead        ON enrichment_runs(lead_id);
CREATE INDEX idx_enrichment_runs_raw_record  ON enrichment_runs(raw_record_id);
CREATE INDEX idx_enrichment_runs_provider    ON enrichment_runs(provider);
CREATE INDEX idx_enrichment_runs_task_type   ON enrichment_runs(task_type);
CREATE INDEX idx_enrichment_runs_status      ON enrichment_runs(status);
CREATE INDEX idx_enrichment_runs_output_gin  ON enrichment_runs USING GIN (output_json);

-- Audit ledger — append-only from the CRM UI's perspective, same as
-- activity_log.
ALTER TABLE enrichment_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read enrichment_runs"
  ON enrichment_runs FOR SELECT TO authenticated USING (true);
