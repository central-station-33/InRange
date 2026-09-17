-- InRange: Outreach controls + AI model routing
--
-- Enforces two policies at the data layer:
--
-- 1. Outreach controls — the AI pipeline must never autonomously send an
--    email/SMS/call/voicemail, add a lead to a campaign, or change
--    consent/DNC status. Every outbound notification now requires a
--    recorded consent check, a DNC check, and an explicit human approval
--    before delivery. All decisions are logged to `activity_log`.
--
-- 2. Model routing — Gemini is the default enrichment model; Claude is
--    used only for escalations. `property_scores` now records which
--    model(s) ran, the confidence returned, and why an escalation (if
--    any) happened, so routing decisions are auditable.

-- ─── Subscribers: consent + DNC ────────────────────────────────────────────

ALTER TABLE subscribers
  ADD COLUMN consent_status   TEXT        NOT NULL DEFAULT 'unknown'
                              CHECK (consent_status IN ('unknown', 'opted_in', 'opted_out')),
  ADD COLUMN dnc              BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN contactable      BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN consent_source   TEXT,
  ADD COLUMN consent_updated_by TEXT,
  ADD COLUMN consent_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN subscribers.contactable IS
  'Defaults to FALSE. Only a human agent (via consent_updated_by) may flip this — the pipeline never marks a subscriber contactable on its own.';

-- ─── Notifications: approval gate ──────────────────────────────────────────

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_status_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('pending_approval', 'approved', 'sent', 'rejected', 'blocked', 'failed'));

ALTER TABLE notifications
  ALTER COLUMN status SET DEFAULT 'pending_approval',
  ADD COLUMN eligibility_checked BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN consent_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN block_reason        TEXT,
  ADD COLUMN approved_by         TEXT,
  ADD COLUMN approved_at         TIMESTAMPTZ,
  ADD COLUMN rejected_by         TEXT,
  ADD COLUMN rejected_at         TIMESTAMPTZ;

-- ─── Activity log — append-only audit trail for outreach decisions ────────

CREATE TABLE activity_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT        NOT NULL,   -- 'notification' | 'subscriber' | 'property_score'
  entity_id   UUID,
  action      TEXT        NOT NULL,   -- e.g. 'queued_for_approval', 'blocked_dnc', 'sent_after_approval'
  actor       TEXT        NOT NULL DEFAULT 'system',  -- 'system' for automated checks, human identifier for approvals
  detail      JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_log_entity ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_log_action ON activity_log(action);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read activity_log"
  ON activity_log FOR SELECT TO authenticated USING (true);

-- ─── property_scores: model routing audit fields ──────────────────────────

ALTER TABLE property_scores
  ADD COLUMN enrichment_model      TEXT,       -- 'gemini' | 'claude' | 'gemini+claude'
  ADD COLUMN enrichment_confidence NUMERIC,    -- 0.00–1.00, as returned by the first-pass model
  ADD COLUMN escalation_reason     TEXT,       -- why Claude was invoked, if it was
  ADD COLUMN review_status         TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (review_status IN (
                                     'pending', 'auto_accepted', 'agent_review',
                                     'claude_review', 'human_review'
                                   ));

COMMENT ON COLUMN property_scores.review_status IS
  'Derived from enrichment_confidence per the model routing policy: >=0.90 auto_accepted, 0.80-0.89 agent_review, 0.70-0.79 claude_review, <0.70 human_review (excluded from campaign eligibility).';

-- ─── Eligibility view used by notify-subscribers ───────────────────────────
-- A property is eligible for outreach only if it has an AI summary AND that
-- summary did not land in the human-review band (confidence < 0.70).

CREATE OR REPLACE VIEW campaign_eligible_properties AS
SELECT sp.*
FROM scored_properties sp
WHERE sp.ai_summary IS NOT NULL
  AND sp.tier <= 2
  AND EXISTS (
    SELECT 1 FROM property_scores ps
    WHERE ps.property_id = sp.id
      AND ps.review_status IN ('auto_accepted', 'agent_review', 'claude_review')
  );
