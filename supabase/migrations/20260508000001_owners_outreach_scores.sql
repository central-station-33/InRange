-- Owners, Outreach, Outcomes, and Scores tables
-- Required by Scenario 7a (Outreach Drafting) and Scenario 7b (Outreach Send)

-- ─── owners ──────────────────────────────────────────────────────────────────

CREATE TABLE owners (
  owner_id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  resolved_name        TEXT,
  owner_type           TEXT,                        -- 'individual', 'llc', 'trust', 'estate'
  email                TEXT,
  phone                TEXT,
  mailing_address      TEXT,
  contact_strategy_note TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_owners_email ON owners(email) WHERE email IS NOT NULL;
CREATE INDEX idx_owners_phone ON owners(phone) WHERE phone IS NOT NULL;

-- ─── Link properties → owners ────────────────────────────────────────────────

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES owners(owner_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_properties_owner_id ON properties(owner_id)
  WHERE owner_id IS NOT NULL;

-- ─── scores ──────────────────────────────────────────────────────────────────
-- Separate from property_scores — stores per-run scoring history with narrative

CREATE TABLE scores (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id        TEXT        NOT NULL,
  property_id      UUID        REFERENCES properties(id) ON DELETE CASCADE,
  score            INTEGER     NOT NULL CHECK (score BETWEEN 0 AND 100),
  final_tier       INTEGER     NOT NULL CHECK (final_tier BETWEEN 1 AND 4),
  score_narrative  TEXT,
  scored_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scores_parcel_id ON scores(parcel_id);
CREATE INDEX idx_scores_scored_at ON scores(parcel_id, scored_at DESC);

-- ─── outreach ────────────────────────────────────────────────────────────────

CREATE TABLE outreach (
  outreach_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id                  TEXT        NOT NULL,
  property_id                UUID        REFERENCES properties(id) ON DELETE SET NULL,
  owner_id                   UUID        REFERENCES owners(owner_id) ON DELETE SET NULL,
  channel                    TEXT        NOT NULL DEFAULT 'multi'
                                         CHECK (channel IN ('sms', 'email', 'mailer', 'multi')),
  status                     TEXT        NOT NULL DEFAULT 'pending_review'
                                         CHECK (status IN ('pending_review', 'approved', 'sent', 'failed', 'skipped')),
  sms_copy                   TEXT,
  email_subject              TEXT,
  email_body                 TEXT,
  mailer_copy                TEXT,
  personalization_confidence INTEGER     CHECK (personalization_confidence BETWEEN 0 AND 100),
  tone_rationale             TEXT,
  agent_id                   TEXT,
  sent_at                    TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outreach_parcel_id ON outreach(parcel_id);
CREATE INDEX idx_outreach_owner_id  ON outreach(owner_id);
CREATE INDEX idx_outreach_status    ON outreach(status);

-- ─── outcomes ────────────────────────────────────────────────────────────────

CREATE TABLE outcomes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  outreach_id  UUID        NOT NULL REFERENCES outreach(outreach_id) ON DELETE CASCADE,
  outcome_type TEXT        NOT NULL,   -- 'no_answer', 'callback', 'interested', 'not_interested', 'dnc', 'deal'
  notes        TEXT,
  recorded_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outcomes_outreach_id ON outcomes(outreach_id);

-- ─── Auto-update updated_at ──────────────────────────────────────────────────

CREATE TRIGGER trg_owners_updated_at
  BEFORE UPDATE ON owners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_outreach_updated_at
  BEFORE UPDATE ON outreach
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Row-Level Security ──────────────────────────────────────────────────────

ALTER TABLE owners   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read owners"   ON owners   FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth read scores"   ON scores   FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth read outreach" ON outreach FOR ALL    TO authenticated USING (true);
CREATE POLICY "auth read outcomes" ON outcomes FOR SELECT TO authenticated USING (true);
