-- InRange: Initial Schema
-- Properties, scores, subscribers, notifications, and ingestion run logs

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Core Tables ────────────────────────────────────────────────────────────

CREATE TABLE properties (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT        NOT NULL CHECK (source IN ('nyc', 'nj')),
  parcel_id      TEXT        NOT NULL,
  address        TEXT        NOT NULL,
  city           TEXT        NOT NULL,
  state          TEXT        NOT NULL,
  zip            TEXT,
  county         TEXT,
  owner_name     TEXT,
  property_type  TEXT,
  assessed_value NUMERIC,
  market_value   NUMERIC,
  distress_flags JSONB       NOT NULL DEFAULT '[]',
  raw_data       JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, parcel_id)
);

CREATE TABLE property_scores (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID        NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  composite_score  INTEGER     NOT NULL CHECK (composite_score BETWEEN 0 AND 100),
  tier             INTEGER     NOT NULL CHECK (tier BETWEEN 1 AND 4),
  score_components JSONB       NOT NULL DEFAULT '[]',
  ai_summary       TEXT,
  scored_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_id)
);

CREATE TABLE subscribers (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT,
  email           TEXT,
  phone           TEXT,
  webhook_url     TEXT,
  target_markets  TEXT[]      NOT NULL DEFAULT '{}',
  min_tier        INTEGER     NOT NULL DEFAULT 2 CHECK (min_tier BETWEEN 1 AND 4),
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contact_required CHECK (
    email IS NOT NULL OR phone IS NOT NULL OR webhook_url IS NOT NULL
  )
);

CREATE TABLE notifications (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id  UUID        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  property_id    UUID        NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  channel        TEXT        NOT NULL CHECK (channel IN ('email', 'sms', 'webhook')),
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'sent', 'failed')),
  payload        JSONB,
  sent_at        TIMESTAMPTZ,
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscriber_id, property_id, channel)
);

-- Tracks each Make.com-triggered ingestion run
CREATE TABLE ingestion_runs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source           TEXT        NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  records_fetched  INTEGER     NOT NULL DEFAULT 0,
  records_upserted INTEGER     NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running', 'completed', 'failed')),
  error_message    TEXT
);

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX idx_properties_source       ON properties(source);
CREATE INDEX idx_properties_updated      ON properties(updated_at DESC);
CREATE INDEX idx_properties_county       ON properties(county);
CREATE INDEX idx_properties_zip          ON properties(zip);
CREATE INDEX idx_property_scores_tier    ON property_scores(tier);
CREATE INDEX idx_property_scores_score   ON property_scores(composite_score DESC);
CREATE INDEX idx_notifications_status    ON notifications(status);
CREATE INDEX idx_notifications_property  ON notifications(property_id);

-- GIN index for querying distress_flags array contents
CREATE INDEX idx_properties_distress_gin ON properties USING GIN (distress_flags);

-- ─── Auto-update updated_at ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Row-Level Security ─────────────────────────────────────────────────────
-- Edge functions use service role key (bypasses RLS).
-- Enable RLS so Retool anon/user roles can't access raw data without grants.

ALTER TABLE properties       ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_scores  ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscribers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_runs   ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users read access (Retool uses authenticated role)
CREATE POLICY "auth read properties"
  ON properties FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read scores"
  ON property_scores FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read subscribers"
  ON subscribers FOR ALL TO authenticated USING (true);

CREATE POLICY "auth read notifications"
  ON notifications FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read ingestion_runs"
  ON ingestion_runs FOR SELECT TO authenticated USING (true);
