-- InRange: ISA Leads Layer
-- People-centric prospect table for all 9 ISA segments

-- ─── Leads ──────────────────────────────────────────────────────────────────

CREATE TABLE leads (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Segment & market
  segment          TEXT        NOT NULL CHECK (segment IN (
                     'athlete', 'expat_relocation', 'investor', 'film_tv',
                     'motivated_seller', 'first_time_buyer', 'divorce',
                     'empty_nester', 'developer'
                   )),
  market           TEXT        NOT NULL CHECK (market IN ('nyc', 'nj')),

  -- Identity
  full_name        TEXT,
  entity_name      TEXT,                        -- LLC, agency, production co

  -- Direct contact
  email            TEXT,
  phone            TEXT,
  linkedin_url     TEXT,
  instagram_handle TEXT,

  -- Representative contact (agents, attorneys, relocation coordinators)
  rep_name         TEXT,
  rep_email        TEXT,
  rep_phone        TEXT,
  rep_agency       TEXT,

  -- ISA qualification
  bant_score       INTEGER     CHECK (bant_score BETWEEN 0 AND 12),
  motivation_score INTEGER     CHECK (motivation_score BETWEEN 1 AND 5),
  routing          TEXT        NOT NULL DEFAULT 'new'
                               CHECK (routing IN ('hot', 'warm', 'nurture', 'cold', 'new')),

  -- ISA workflow
  assigned_isa     TEXT,
  outreach_status  TEXT        NOT NULL DEFAULT 'new'
                               CHECK (outreach_status IN (
                                 'new', 'attempting', 'contacted', 'qualified',
                                 'appointment_set', 'under_contract', 'closed', 'dead'
                               )),

  -- Context
  property_address TEXT,
  motivation_signals JSONB     NOT NULL DEFAULT '[]',
  ai_summary       TEXT,
  isa_talking_points JSONB     NOT NULL DEFAULT '[]',  -- Claude-generated, 3 bullets
  source_url       TEXT,
  source_name      TEXT,

  -- Segment-specific fields
  contract_value   NUMERIC,       -- athletes: contract value; developers: deal size
  team_name        TEXT,          -- athletes
  sport            TEXT,          -- athletes
  origin_country   TEXT,          -- expats
  employer         TEXT,          -- expats / corporate relocations
  production_name  TEXT,          -- film/tv
  permit_number    TEXT,          -- film/tv (NYC MOME permit)

  raw_data         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent exact duplicates per segment+name+market
CREATE UNIQUE INDEX idx_leads_dedup
  ON leads (segment, market, COALESCE(full_name, entity_name, ''))
  WHERE outreach_status NOT IN ('dead');

-- ─── Lead Touches ────────────────────────────────────────────────────────────

CREATE TABLE lead_touches (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  touch_number INTEGER     NOT NULL,
  channel      TEXT        NOT NULL CHECK (channel IN ('call', 'sms', 'email', 'dm', 'voicemail')),
  outcome      TEXT        CHECK (outcome IN (
                 'no_answer', 'voicemail', 'callback_requested',
                 'not_interested', 'interested', 'appointment_set'
               )),
  notes        TEXT,
  isa_name     TEXT,
  touched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX idx_leads_segment        ON leads(segment);
CREATE INDEX idx_leads_market         ON leads(market);
CREATE INDEX idx_leads_routing        ON leads(routing);
CREATE INDEX idx_leads_status         ON leads(outreach_status);
CREATE INDEX idx_leads_assigned_isa   ON leads(assigned_isa);
CREATE INDEX idx_leads_created        ON leads(created_at DESC);
CREATE INDEX idx_lead_touches_lead    ON lead_touches(lead_id);
CREATE INDEX idx_leads_motivation_gin ON leads USING GIN (motivation_signals);

-- ─── Auto-update updated_at ──────────────────────────────────────────────────

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();   -- reuses function from migration 000000

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE leads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_touches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read leads"
  ON leads FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth write leads"
  ON leads FOR ALL TO authenticated USING (true);

CREATE POLICY "auth read lead_touches"
  ON lead_touches FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth write lead_touches"
  ON lead_touches FOR ALL TO authenticated USING (true);

-- ─── Views ───────────────────────────────────────────────────────────────────

-- ISA dashboard: hot + warm leads with touch count
CREATE VIEW isa_leads_dashboard AS
SELECT
  l.id,
  l.segment,
  l.market,
  l.full_name,
  l.entity_name,
  l.phone,
  l.email,
  l.rep_name,
  l.rep_phone,
  l.rep_email,
  l.rep_agency,
  l.linkedin_url,
  l.instagram_handle,
  l.routing,
  l.outreach_status,
  l.assigned_isa,
  l.bant_score,
  l.motivation_score,
  l.ai_summary,
  l.isa_talking_points,
  l.property_address,
  l.contract_value,
  l.team_name,
  l.sport,
  l.production_name,
  l.employer,
  l.origin_country,
  l.source_name,
  l.source_url,
  l.created_at,
  COUNT(t.id)::INTEGER              AS touch_count,
  MAX(t.touched_at)                 AS last_touched_at,
  MAX(t.outcome)                    AS last_outcome
FROM leads l
LEFT JOIN lead_touches t ON t.lead_id = l.id
GROUP BY l.id;

-- Segment summary for pipeline overview panel
CREATE VIEW isa_pipeline_summary AS
SELECT
  segment,
  market,
  COUNT(*)                                              AS total,
  COUNT(*) FILTER (WHERE routing = 'hot')               AS hot,
  COUNT(*) FILTER (WHERE routing = 'warm')              AS warm,
  COUNT(*) FILTER (WHERE routing = 'nurture')           AS nurture,
  COUNT(*) FILTER (WHERE outreach_status = 'new')       AS untouched,
  COUNT(*) FILTER (WHERE outreach_status = 'appointment_set') AS appointments,
  COUNT(*) FILTER (WHERE outreach_status = 'closed')    AS closed
FROM leads
GROUP BY segment, market
ORDER BY segment, market;
