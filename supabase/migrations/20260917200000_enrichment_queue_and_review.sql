-- InRange: Enrichment queue, raw-record staging, and human review (Phase 1)
-- See docs/ai-lead-enrichment-blueprint.md for the full design.
-- Additive to the Phase 0 schema in 20260915120000_ai_lead_enrichment.sql;
-- two of Phase 0's trigger functions are refactored in place below (see
-- "Trigger hardening" section) rather than left as-is, because adding new
-- mutable-adjacent columns to lead_evidence/ai_enrichment_runs exposed the
-- same whitelist-omission bug class already caught once in Phase 0 review.

-- ─── New enums ──────────────────────────────────────────────────────────────

CREATE TYPE enrichment_job_type AS ENUM (
  'ingestion',
  'normalization',
  'document_extraction',
  'enrichment',
  'lead_brief',
  'claude_escalation',
  'human_review_notifications',
  'outreach_draft'
);

CREATE TYPE enrichment_job_status AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed',
  'dead_letter'
);

CREATE TYPE review_action_type AS ENUM (
  'approve',
  'reject',
  'edit',
  'request_more_research'
);

CREATE TYPE review_priority_level AS ENUM (
  'low',
  'normal',
  'high',
  'urgent'
);

CREATE TYPE agent_feedback_type AS ENUM (
  'accurate',
  'inaccurate',
  'useful',
  'not_useful',
  'wrong_owner',
  'wrong_address',
  'wrong_entity_match',
  'bad_outreach_angle',
  'requires_legal_review',
  'requires_manager_review'
);

-- Extends the Phase 0 confidence taxonomy with an explicit "a human looked
-- at this and rejected it" state, distinct from just being superseded by a
-- correction. Like 'confirmed_fact', an AI model can never write this value
-- directly (see ai_extraction_never_rejected below) — a model can flag a
-- claim as dubious (needs_human_review = TRUE on a 'hypothesis' row), but
-- only a human's review action can mark it 'rejected'.
ALTER TYPE evidence_confidence ADD VALUE 'rejected';

-- ─── lead_evidence: review metadata + hardened trigger ─────────────────────

-- review_reason/review_priority are set at INSERT time, same as
-- needs_human_review — they describe *why* this specific row needs review
-- (a conflict with what it supersedes, a low-confidence extraction, etc.),
-- not a later annotation. The human's response to that review is recorded
-- separately in lead_review_actions below.
ALTER TABLE lead_evidence
  ADD COLUMN review_reason   TEXT,
  ADD COLUMN review_priority review_priority_level;

ALTER TABLE lead_evidence
  ADD CONSTRAINT ai_extraction_never_rejected
    CHECK (source_type <> 'ai_extraction' OR confidence <> 'rejected');

-- Trigger hardening: the Phase 0 version of this function enumerated every
-- protected column by name (`NEW.x IS NOT DISTINCT FROM OLD.x AND ...`).
-- That is a whitelist that has to be remembered and updated by hand every
-- time a column is added — exactly the shape of bug caught once already in
-- Phase 0 review (needs_human_review shipped without being added to that
-- list, which would have let it change silently under cover of an
-- is_current flip). Replaced with a jsonb-diff that excludes only
-- is_current, so it automatically covers review_reason/review_priority
-- here and any future column without needing to be touched again.
CREATE OR REPLACE FUNCTION prevent_lead_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.is_current IS TRUE AND NEW.is_current IS FALSE
     AND (to_jsonb(NEW) - 'is_current') = (to_jsonb(OLD) - 'is_current')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'lead_evidence is append-only except the system-managed is_current flag: % is not permitted on id=%. Insert a new row with supersedes_id set instead.',
    TG_OP, OLD.id;
END;
$$;
-- trg_lead_evidence_immutable (created in Phase 0) already points at this
-- function by name, so no trigger changes are needed here.

-- ─── ai_enrichment_runs: prompt_version + hardened trigger ─────────────────

-- Tracks which version of the Gemini/Claude prompt contract produced this
-- run — required for "Model/provider and prompt version" in the lead
-- intelligence panel, and for evaluating prompt changes against historical
-- outcomes. See supabase/functions/_shared/prompts/.
ALTER TABLE ai_enrichment_runs
  ADD COLUMN prompt_version TEXT;

-- Same hardening as above, same underlying bug class: prompt_version would
-- otherwise be silently mutable under cover of a reviewed_by/
-- flagged_for_review update, since the Phase 0 version only checked the
-- columns it happened to name.
CREATE OR REPLACE FUNCTION prevent_ai_run_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai_enrichment_runs is an audit log: DELETE is not permitted on id=%.', OLD.id;
  END IF;

  IF (to_jsonb(NEW) - 'reviewed_by' - 'flagged_for_review')
     <> (to_jsonb(OLD) - 'reviewed_by' - 'flagged_for_review')
  THEN
    RAISE EXCEPTION
      'ai_enrichment_runs is an audit log: only reviewed_by and flagged_for_review may change on id=%.', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;
-- trg_ai_enrichment_runs_guard (created in Phase 0) already points at this
-- function by name, so no trigger changes are needed here.

-- ─── Raw record staging ─────────────────────────────────────────────────────

-- Landing zone for POST /ingest/raw-record — any source not already
-- covered by ingest-nyc/ingest-nj (a probate feed, an expired-listing
-- vendor feed, etc.). Distinct from `properties`: a raw record hasn't been
-- normalized/matched to a property yet, and may never be (bad data, a
-- duplicate, out of market). Processing it is an 'ingestion' or
-- 'normalization' job below.
CREATE TABLE raw_records (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT         NOT NULL,  -- free-text feed identifier, e.g. 'ny_surrogates_probate', 'mls_expired_feed'
  raw_payload       JSONB        NOT NULL,
  property_id       UUID         REFERENCES properties(id),
  processed         BOOLEAN      NOT NULL DEFAULT FALSE,
  processing_error  TEXT,
  received_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ
);

-- ─── Enrichment job queue ───────────────────────────────────────────────────

-- One row per unit of work across all 8 queue types in the blueprint.
-- Deliberately a single polymorphic table (job_type discriminates) rather
-- than 8 separate tables — Postgres-native, no new vendor (pg_cron or the
-- existing Make.com scenarios can poll `status = 'queued'`), and every job
-- type needs the exact same lifecycle columns.
--
-- Unlike lead_evidence/ai_enrichment_runs, this is working/operational
-- state, not a permanent evidence record — rows are meant to be updated in
-- place as a job progresses, so there is no immutability trigger here.
CREATE TABLE enrichment_jobs (
  id                     UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type               enrichment_job_type    NOT NULL,
  idempotency_key        TEXT,
  lead_id                UUID                   REFERENCES lead_records(id) ON DELETE CASCADE,
  raw_record_id          UUID                   REFERENCES raw_records(id) ON DELETE CASCADE,
  payload                JSONB                  NOT NULL DEFAULT '{}',
  result                 JSONB,
  status                 enrichment_job_status  NOT NULL DEFAULT 'queued',
  retry_count            INTEGER                NOT NULL DEFAULT 0,
  max_retries            INTEGER                NOT NULL DEFAULT 3,
  retry_backoff_seconds  INTEGER                NOT NULL DEFAULT 30,
  next_retry_at          TIMESTAMPTZ,
  error_details          JSONB,
  created_at             TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  CONSTRAINT enrichment_jobs_max_retries_nonnegative CHECK (max_retries >= 0),
  CONSTRAINT enrichment_jobs_retry_count_nonnegative CHECK (retry_count >= 0)
);

-- Idempotency is scoped per job_type: the same idempotency_key is fine
-- across different job types (e.g. an 'ingestion' job and its downstream
-- 'normalization' job can share a natural key derived from the same source
-- record) but must be unique within one job_type.
CREATE UNIQUE INDEX idx_enrichment_jobs_idempotency
  ON enrichment_jobs(job_type, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Atomically claims one due job of the given type: either freshly queued,
-- or a previously failed job whose next_retry_at has arrived and hasn't
-- exhausted max_retries. FOR UPDATE SKIP LOCKED so concurrent worker
-- invocations (e.g. two overlapping Make.com-triggered enrichment-process
-- runs) never claim the same row — a naive "SELECT then UPDATE" from the
-- Edge Function would race under exactly that condition. Called via
-- supabase.rpc('claim_enrichment_job', ...) rather than a plain
-- select+update from application code.
CREATE OR REPLACE FUNCTION claim_enrichment_job(p_job_type enrichment_job_type)
RETURNS enrichment_jobs LANGUAGE plpgsql AS $$
DECLARE
  claimed enrichment_jobs;
BEGIN
  SELECT * INTO claimed
  FROM enrichment_jobs
  WHERE job_type = p_job_type
    AND (
      status = 'queued'
      OR (status = 'failed' AND retry_count < max_retries AND next_retry_at <= NOW())
    )
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF claimed.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE enrichment_jobs
  SET status = 'running', started_at = NOW()
  WHERE id = claimed.id
  RETURNING * INTO claimed;

  RETURN claimed;
END;
$$;

-- ─── Human review action log ────────────────────────────────────────────────

-- A record of what a human (or a rule) DID about a piece of AI output or a
-- flagged conflict — separate from lead_evidence's review_reason (why
-- something entered review) and from the evidence rows themselves (the
-- facts). "Approve" and "edit" typically also produce a new lead_evidence
-- row (via the normal supersede path); resulting_evidence_id links to it
-- when that happens, so the audit trail connects the decision to its
-- effect without lead_review_actions itself needing to be immutable in the
-- same way lead_evidence is — a reviewer's own action log can reasonably
-- gain a correction/note later, unlike a fact ledger.
CREATE TABLE lead_review_actions (
  id                     UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                UUID            NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  evidence_id            UUID            REFERENCES lead_evidence(id),
  ai_run_id              UUID            REFERENCES ai_enrichment_runs(id),
  action                 review_action_type NOT NULL,
  notes                  TEXT,
  reviewer_id            UUID            NOT NULL REFERENCES auth.users(id),
  resulting_evidence_id  UUID            REFERENCES lead_evidence(id),
  created_at             TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ─── Outreach drafts ─────────────────────────────────────────────────────────

-- Backs POST /outreach/:leadId/draft and /approve. Deliberately no 'sent'
-- status and no sent_at column: per the API/queue spec ("Do not implement
-- actual send behavior unless existing consent and approval controls are
-- verified"), nothing in this schema or the outreach-send Edge Function
-- performs a send — that endpoint exists but hard-refuses. Drafting never
-- calls an LLM with contact data or with any prompt contract not
-- explicitly specified — see supabase/functions/outreach-draft/index.ts.
CREATE TYPE outreach_draft_status AS ENUM ('draft', 'approved', 'rejected');

CREATE TABLE outreach_drafts (
  id              UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID                    NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  channel         TEXT                    NOT NULL CHECK (channel IN ('phone', 'email', 'sms')),
  draft_text      TEXT                    NOT NULL,
  status          outreach_draft_status   NOT NULL DEFAULT 'draft',
  based_on_run_id UUID                    REFERENCES ai_enrichment_runs(id),
  approved_by     UUID                    REFERENCES auth.users(id),
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ             NOT NULL DEFAULT NOW()
);

-- ─── Agent feedback ──────────────────────────────────────────────────────────

-- "Store feedback for later prompt and rule evaluation" per the CRM UI
-- spec. No endpoint was named for this in the API list, so
-- POST /leads/:id/feedback is added alongside it (see
-- supabase/functions/leads-feedback/index.ts) to give it somewhere to land.
CREATE TABLE lead_feedback (
  id          UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID                 NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
  evidence_id UUID                 REFERENCES lead_evidence(id),
  ai_run_id   UUID                 REFERENCES ai_enrichment_runs(id),
  feedback    agent_feedback_type  NOT NULL,
  note        TEXT,
  agent_id    UUID                 NOT NULL REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX idx_raw_records_processed        ON raw_records(processed) WHERE NOT processed;
CREATE INDEX idx_raw_records_property         ON raw_records(property_id);

CREATE INDEX idx_enrichment_jobs_status_type  ON enrichment_jobs(status, job_type);
CREATE INDEX idx_enrichment_jobs_next_retry   ON enrichment_jobs(next_retry_at) WHERE status = 'failed';
CREATE INDEX idx_enrichment_jobs_lead         ON enrichment_jobs(lead_id);
CREATE INDEX idx_enrichment_jobs_raw_record   ON enrichment_jobs(raw_record_id);
CREATE INDEX idx_enrichment_jobs_dead_letter  ON enrichment_jobs(created_at) WHERE status = 'dead_letter';

CREATE INDEX idx_lead_review_actions_lead     ON lead_review_actions(lead_id);
CREATE INDEX idx_lead_review_actions_evidence ON lead_review_actions(evidence_id);

CREATE INDEX idx_lead_feedback_lead           ON lead_feedback(lead_id);
CREATE INDEX idx_lead_feedback_evidence       ON lead_feedback(evidence_id);

CREATE INDEX idx_lead_evidence_review_priority
  ON lead_evidence(review_priority) WHERE is_current AND needs_human_review;

CREATE INDEX idx_outreach_drafts_lead ON outreach_drafts(lead_id);

-- ─── Row-Level Security ─────────────────────────────────────────────────────

ALTER TABLE raw_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_review_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_feedback       ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_drafts     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read raw_records"
  ON raw_records FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read enrichment_jobs"
  ON enrichment_jobs FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read lead_review_actions"
  ON lead_review_actions FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read lead_feedback"
  ON lead_feedback FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read outreach_drafts"
  ON outreach_drafts FOR SELECT TO authenticated USING (true);

-- ─── Review queue view ──────────────────────────────────────────────────────

-- Backs the Human Review Screen directly: lead/property, reason, priority,
-- the conflicting values (this row's proposed value vs. the prior current
-- value it would supersede), and pointers to the evidence/run rows for
-- excerpts and raw Gemini/Claude output. Only current, flagged rows —
-- once a review action resolves one (a new row supersedes it, flipping
-- is_current off), it drops out of the queue automatically.
CREATE OR REPLACE VIEW review_queue AS
SELECT
  le.id                AS evidence_id,
  le.lead_id,
  p.address,
  p.city,
  p.state,
  le.field_name,
  le.field_value        AS proposed_value,
  prior.field_value      AS prior_value,
  le.review_reason,
  le.review_priority,
  le.confidence,
  le.source_type,
  le.ai_run_id,
  ar.model              AS ai_model,
  ar.prompt_version,
  ar.output             AS ai_output,
  le.created_at          AS flagged_at
FROM lead_evidence le
JOIN lead_records lr ON lr.id = le.lead_id
JOIN properties p    ON p.id = lr.property_id
LEFT JOIN lead_evidence prior      ON prior.id = le.supersedes_id
LEFT JOIN ai_enrichment_runs ar    ON ar.id = le.ai_run_id
WHERE le.is_current AND le.needs_human_review
ORDER BY
  CASE le.review_priority
    WHEN 'urgent' THEN 1
    WHEN 'high'   THEN 2
    WHEN 'normal' THEN 3
    WHEN 'low'    THEN 4
    ELSE 3
  END,
  le.created_at ASC;
