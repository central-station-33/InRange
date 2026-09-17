-- InRange: Enrichment evidence, AI signals, contact data, and human review queue
--
-- Continues the canonical data model added in
-- 20240104000000_canonical_data_model.sql (organizations, raw_records,
-- properties, parties, property_party_relationships, leads,
-- enrichment_runs — items 1-6 of the same schema spec). This migration
-- adds items 7-11: the evidence ledger, AI-derived signals, contact data
-- with encrypted values, outreach consent, and the human review queue.
--
-- Additive only — no existing table, column, view, or policy is altered.
--
-- Design rule carried over from the enrichment workflow spec: an AI model
-- may write a claim to enrichment_evidence or an indicator to ai_signals,
-- but it never writes directly to a canonical properties/parties/leads
-- column, and it never decides the compliant next action — that stays a
-- human_reviews / rule-based decision.

-- ─── 7. enrichment_evidence ─────────────────────────────────────────────────
-- Every claim (from ingestion, deterministic validation, or a model run)
-- and the source that backs it. Rows are not expected to be edited in
-- place beyond verification_status — a correction is a new row, with the
-- row it corrects moved to 'superseded', not an overwrite of claim_value.

CREATE TABLE enrichment_evidence (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID        NOT NULL REFERENCES organizations(id),
  lead_id                     UUID        REFERENCES leads(id) ON DELETE CASCADE,
  property_id                 UUID        REFERENCES properties(id) ON DELETE CASCADE,
  party_id                    UUID        REFERENCES parties(id) ON DELETE CASCADE,
  enrichment_run_id           UUID        REFERENCES enrichment_runs(id) ON DELETE SET NULL,
  -- Not part of the spec's allowed-value lists; left unconstrained since
  -- the set of claim categories (ownership, address, valuation, legal
  -- status, ...) is expected to grow with each new source integrated.
  evidence_type                TEXT        NOT NULL,
  claim_key                   TEXT        NOT NULL,
  claim_value                 JSONB       NOT NULL,
  source_name                 TEXT        NOT NULL,
  source_record_id            TEXT,
  source_url                  TEXT,
  source_document_reference   TEXT,
  source_excerpt               TEXT,
  confidence                  NUMERIC     CHECK (confidence BETWEEN 0 AND 1),
  verification_status         TEXT        NOT NULL DEFAULT 'unverified'
                               CHECK (verification_status IN (
                                 'unverified', 'source_supported', 'verified_by_agent',
                                 'rejected', 'superseded'
                               )),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                  TIMESTAMPTZ,

  -- A claim has to be about something — at least one of the three subject
  -- references must be set.
  CONSTRAINT enrichment_evidence_has_subject
    CHECK (lead_id IS NOT NULL OR property_id IS NOT NULL OR party_id IS NOT NULL)
);

COMMENT ON CONSTRAINT enrichment_evidence_has_subject ON enrichment_evidence IS
  'A piece of evidence must be attached to at least one of lead_id/property_id/party_id.';

CREATE INDEX idx_enrichment_evidence_org          ON enrichment_evidence(organization_id);
CREATE INDEX idx_enrichment_evidence_lead         ON enrichment_evidence(lead_id);
CREATE INDEX idx_enrichment_evidence_property     ON enrichment_evidence(property_id);
CREATE INDEX idx_enrichment_evidence_party        ON enrichment_evidence(party_id);
CREATE INDEX idx_enrichment_evidence_run          ON enrichment_evidence(enrichment_run_id);
CREATE INDEX idx_enrichment_evidence_claim_key    ON enrichment_evidence(claim_key);
CREATE INDEX idx_enrichment_evidence_verification ON enrichment_evidence(verification_status);
CREATE INDEX idx_enrichment_evidence_type         ON enrichment_evidence(evidence_type);
CREATE INDEX idx_enrichment_evidence_claim_gin    ON enrichment_evidence USING GIN (claim_value);

-- Audit ledger, same access pattern as raw_records/enrichment_runs — read
-- access for the authenticated (Retool) role, writes via the service role
-- key used by the enrichment pipeline.
ALTER TABLE enrichment_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read enrichment_evidence"
  ON enrichment_evidence FOR SELECT TO authenticated USING (true);

-- ─── 8. ai_signals ──────────────────────────────────────────────────────────
-- AI-derived indicators, kept separate from enrichment_evidence's
-- source-backed claims so a model's inference is never mistaken for a
-- confirmed fact.

CREATE TABLE ai_signals (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID        NOT NULL REFERENCES organizations(id),
  lead_id            UUID        REFERENCES leads(id) ON DELETE CASCADE,
  signal_type        TEXT        NOT NULL
                      CHECK (signal_type IN (
                        'absentee_owner', 'out_of_area_owner', 'pre_foreclosure_indicator',
                        'foreclosure_indicator', 'expired_listing_indicator',
                        'investor_disposition_indicator', 'ownership_complexity',
                        'multi_property_owner', 'record_conflict', 'data_quality_issue',
                        'follow_up_recommended', 'unknown'
                      )),
  signal_value       JSONB       NOT NULL,
  rationale          TEXT,
  confidence         NUMERIC     CHECK (confidence BETWEEN 0 AND 1),
  -- References enrichment_evidence.id. Kept as a plain UUID array (Postgres
  -- has no array-of-foreign-key constraint) rather than a join table,
  -- since a signal citing zero or a handful of evidence rows is the
  -- common case; validate membership in application code before insert.
  evidence_ids       UUID[]      NOT NULL DEFAULT '{}',
  model_provider     TEXT        CHECK (model_provider IN (
                        'gemini', 'anthropic', 'internal_rules', 'skipdata', 'human'
                      )),
  model_name         TEXT,
  enrichment_run_id  UUID        REFERENCES enrichment_runs(id) ON DELETE SET NULL,
  -- Not part of the spec's allowed-value lists; a minimal lifecycle for a
  -- signal moving through human_reviews.
  review_status      TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (review_status IN ('pending', 'confirmed', 'dismissed', 'needs_review')),
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- signal_type is a closed enum by design (CHECK above) — this is what
-- keeps a protected characteristic or personal-vulnerability category
-- from ever being introduced as a signal type; widening the list requires
-- a reviewed migration, not an application-layer string.

CREATE INDEX idx_ai_signals_org           ON ai_signals(organization_id);
CREATE INDEX idx_ai_signals_lead          ON ai_signals(lead_id);
CREATE INDEX idx_ai_signals_type          ON ai_signals(signal_type);
CREATE INDEX idx_ai_signals_review_status ON ai_signals(review_status);
CREATE INDEX idx_ai_signals_run           ON ai_signals(enrichment_run_id);
CREATE INDEX idx_ai_signals_evidence_gin  ON ai_signals USING GIN (evidence_ids);

CREATE TRIGGER trg_ai_signals_updated_at
  BEFORE UPDATE ON ai_signals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE ai_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read ai_signals"
  ON ai_signals FOR SELECT TO authenticated USING (true);

-- ─── 9. contact_points ──────────────────────────────────────────────────────
-- Communications data from approved sources. The actual contact value is
-- stored only in encrypted form; normalized_contact_value_hash exists so
-- dedupe/lookup queries never need to decrypt. Never return
-- contact_value_encrypted to a model unless an approved workflow requires
-- it — application-layer concern, not something RLS alone can guarantee.

CREATE TABLE contact_points (
  id                             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                UUID        NOT NULL REFERENCES organizations(id),
  party_id                       UUID        NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  contact_type                   TEXT        NOT NULL
                                  CHECK (contact_type IN (
                                    'email', 'mobile_phone', 'landline_phone', 'mailing_address'
                                  )),
  contact_value_encrypted        TEXT        NOT NULL,
  normalized_contact_value_hash  TEXT,
  source_name                    TEXT        NOT NULL,
  source_record_id               TEXT,
  confidence                     NUMERIC     CHECK (confidence BETWEEN 0 AND 1),
  -- Reuses enrichment_evidence's verification_status vocabulary so
  -- "how sure are we this is real" reads the same way across the schema.
  verification_status            TEXT        NOT NULL DEFAULT 'unverified'
                                  CHECK (verification_status IN (
                                    'unverified', 'source_supported', 'verified_by_agent',
                                    'rejected', 'superseded'
                                  )),
  do_not_contact                 BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contact_points_org       ON contact_points(organization_id);
CREATE INDEX idx_contact_points_party     ON contact_points(party_id);
CREATE INDEX idx_contact_points_type      ON contact_points(contact_type);
CREATE INDEX idx_contact_points_dnc       ON contact_points(do_not_contact) WHERE do_not_contact = TRUE;

-- Dedupe the same contact value for the same party/channel without ever
-- comparing plaintext.
CREATE UNIQUE INDEX idx_contact_points_dedupe
  ON contact_points(party_id, contact_type, normalized_contact_value_hash)
  WHERE normalized_contact_value_hash IS NOT NULL;

CREATE TRIGGER trg_contact_points_updated_at
  BEFORE UPDATE ON contact_points
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Contact records are human-operated (agents toggle do_not_contact,
-- correct verification_status) — same access pattern as leads/subscribers.
ALTER TABLE contact_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth manage contact_points"
  ON contact_points FOR ALL TO authenticated USING (true);

-- ─── 10. contact_consent ────────────────────────────────────────────────────
-- Outreach eligibility and consent history, per channel. contact_point_id
-- is nullable: consent can be captured for a party/channel in general
-- (e.g. a signed blanket opt-in) before a specific verified contact_points
-- row exists for that channel.

CREATE TABLE contact_consent (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID        NOT NULL REFERENCES organizations(id),
  party_id                 UUID        NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  contact_point_id         UUID        REFERENCES contact_points(id) ON DELETE SET NULL,
  channel                  TEXT        NOT NULL
                            CHECK (channel IN ('email', 'sms', 'phone', 'direct_mail')),
  consent_status           TEXT        NOT NULL DEFAULT 'unknown'
                            CHECK (consent_status IN (
                              'unknown', 'consented', 'not_consented', 'revoked',
                              'exempt_review_required'
                            )),
  consent_source           TEXT,
  consent_language_version TEXT,
  captured_at              TIMESTAMPTZ,
  revoked_at               TIMESTAMPTZ,
  -- Not part of the spec's allowed-value lists; a minimal Do-Not-Call
  -- registry status separate from consent_status, since a party can be
  -- DNC-listed independent of what they've directly told this org.
  dnc_status                TEXT        NOT NULL DEFAULT 'unknown'
                            CHECK (dnc_status IN ('unknown', 'clear', 'listed')),
  dnc_checked_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT contact_consent_revoked_has_timestamp
    CHECK (consent_status != 'revoked' OR revoked_at IS NOT NULL)
);

CREATE INDEX idx_contact_consent_org           ON contact_consent(organization_id);
CREATE INDEX idx_contact_consent_party         ON contact_consent(party_id);
CREATE INDEX idx_contact_consent_contact_point ON contact_consent(contact_point_id);
CREATE INDEX idx_contact_consent_channel       ON contact_consent(channel);
CREATE INDEX idx_contact_consent_status        ON contact_consent(consent_status);
CREATE INDEX idx_contact_consent_dnc_status    ON contact_consent(dnc_status);

CREATE TRIGGER trg_contact_consent_updated_at
  BEFORE UPDATE ON contact_consent
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE contact_consent ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth manage contact_consent"
  ON contact_consent FOR ALL TO authenticated USING (true);

-- ─── 11. human_reviews ──────────────────────────────────────────────────────
-- The queue a person works: conflicts, low-confidence output, and other
-- decisions the pipeline must not make on its own.

CREATE TABLE human_reviews (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID        NOT NULL REFERENCES organizations(id),
  lead_id                  UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  review_type              TEXT        NOT NULL
                            CHECK (review_type IN (
                              'ownership_conflict', 'low_confidence', 'model_disagreement',
                              'document_extraction', 'campaign_eligibility', 'contact_data_issue',
                              'legal_or_public_record_issue', 'high_value_lead', 'data_quality_issue'
                            )),
  -- Not part of the spec's allowed-value lists; a minimal fixed priority
  -- scale for queue sorting.
  priority                 TEXT        NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  reason                   TEXT        NOT NULL,
  related_enrichment_run_id UUID       REFERENCES enrichment_runs(id) ON DELETE SET NULL,
  assigned_to              UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Not part of the spec's allowed-value lists; a minimal fixed lifecycle,
  -- mirroring ingestion_runs/enrichment_runs' status pattern.
  status                   TEXT        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),
  reviewer_decision        TEXT,
  reviewer_notes           TEXT,
  resolved_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT human_reviews_closed_has_timestamp
    CHECK (status NOT IN ('resolved', 'dismissed') OR resolved_at IS NOT NULL)
);

CREATE INDEX idx_human_reviews_org      ON human_reviews(organization_id);
CREATE INDEX idx_human_reviews_lead     ON human_reviews(lead_id);
CREATE INDEX idx_human_reviews_type     ON human_reviews(review_type);
CREATE INDEX idx_human_reviews_status   ON human_reviews(status);
CREATE INDEX idx_human_reviews_priority ON human_reviews(priority);
CREATE INDEX idx_human_reviews_assigned ON human_reviews(assigned_to);
CREATE INDEX idx_human_reviews_open     ON human_reviews(created_at) WHERE status = 'open';

CREATE TRIGGER trg_human_reviews_updated_at
  BEFORE UPDATE ON human_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The queue agents work directly — same access pattern as leads.
ALTER TABLE human_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth manage human_reviews"
  ON human_reviews FOR ALL TO authenticated USING (true);
