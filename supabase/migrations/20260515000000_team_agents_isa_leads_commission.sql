-- Migration: Team Agents, ISA Leads Pipeline, Commission Tracking
-- Applied: 2026-05-15
-- This migration adds the people-centric ISA prospect layer on top of the
-- existing property pipeline. Key additions:
--   1. team_agents — roster of agents with commission split structure
--   2. isa_leads   — 9-segment ISA prospect pipeline (athlete, film/TV, investor, etc.)
--   3. lead_touches — ISA touch log (call, SMS, email, DM)
--   4. deals updates — adds agent FK, commission source, and auto-computed split math
--   5. Views: isa_pipeline, agent_commission_summary, segment_roi

-- ─── Team Agents ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_agents (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT        NOT NULL,
  email           TEXT        UNIQUE,
  phone           TEXT,
  license_number  TEXT,
  market          TEXT        NOT NULL CHECK (market IN ('nyc', 'nj', 'both')),
  brokerage       TEXT        NOT NULL CHECK (brokerage IN ('highline', 'jet_realty')),
  status          TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'inactive', 'probation')),
  self_sourced_pct  NUMERIC(5,2) NOT NULL DEFAULT 85.00,
  team_lead_pct     NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  override_pct      NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  ytd_volume        NUMERIC      DEFAULT 0,
  ytd_gci           NUMERIC      DEFAULT 0,
  ytd_deals         INTEGER      DEFAULT 0,
  last_deal_date    DATE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── ISA Leads (People-Centric, 9 Segments) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS isa_leads (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  segment          TEXT        NOT NULL CHECK (segment IN (
                     'athlete', 'expat_relocation', 'investor', 'film_tv',
                     'motivated_seller', 'first_time_buyer', 'divorce',
                     'empty_nester', 'developer'
                   )),
  market           TEXT        NOT NULL CHECK (market IN ('nyc', 'nj')),
  commission_source TEXT       NOT NULL DEFAULT 'inrange_generated'
                               CHECK (commission_source IN (
                                 'self_sourced', 'relocation_partner',
                                 'inrange_generated', 'brokerage_provided', 'agent_sourced'
                               )),
  full_name        TEXT,
  entity_name      TEXT,
  email            TEXT,
  phone            TEXT,
  linkedin_url     TEXT,
  instagram_handle TEXT,
  rep_name         TEXT,
  rep_email        TEXT,
  rep_phone        TEXT,
  rep_agency       TEXT,
  bant_score       INTEGER     CHECK (bant_score BETWEEN 0 AND 12),
  motivation_score INTEGER     CHECK (motivation_score BETWEEN 1 AND 5),
  routing          TEXT        NOT NULL DEFAULT 'new'
                               CHECK (routing IN ('hot', 'warm', 'nurture', 'cold', 'new')),
  assigned_agent_id UUID       REFERENCES team_agents(id) ON DELETE SET NULL,
  assigned_isa     TEXT,
  outreach_status  TEXT        NOT NULL DEFAULT 'new'
                               CHECK (outreach_status IN (
                                 'new', 'attempting', 'contacted', 'qualified',
                                 'appointment_set', 'showing_scheduled', 'under_contract',
                                 'closed', 'dead'
                               )),
  property_address TEXT,
  motivation_signals JSONB     NOT NULL DEFAULT '[]',
  ai_summary       TEXT,
  isa_talking_points JSONB     NOT NULL DEFAULT '[]',
  source_url       TEXT,
  source_name      TEXT,
  contract_value   NUMERIC,
  team_name        TEXT,
  sport            TEXT,
  origin_country   TEXT,
  employer         TEXT,
  production_name  TEXT,
  permit_number    TEXT,
  price_range_min  NUMERIC,
  price_range_max  NUMERIC,
  timeline_months  INTEGER,
  raw_data         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_isa_leads_dedup
  ON isa_leads (segment, market, COALESCE(full_name, entity_name, ''))
  WHERE outreach_status NOT IN ('dead', 'closed');

CREATE INDEX IF NOT EXISTS idx_isa_leads_segment  ON isa_leads(segment);
CREATE INDEX IF NOT EXISTS idx_isa_leads_market   ON isa_leads(market);
CREATE INDEX IF NOT EXISTS idx_isa_leads_routing  ON isa_leads(routing);
CREATE INDEX IF NOT EXISTS idx_isa_leads_status   ON isa_leads(outreach_status);
CREATE INDEX IF NOT EXISTS idx_isa_leads_agent    ON isa_leads(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_isa_leads_source   ON isa_leads(commission_source);
CREATE INDEX IF NOT EXISTS idx_isa_leads_created  ON isa_leads(created_at DESC);

-- ─── Lead Touches ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_touches (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID        NOT NULL REFERENCES isa_leads(id) ON DELETE CASCADE,
  touch_number INTEGER     NOT NULL,
  channel      TEXT        NOT NULL CHECK (channel IN ('call', 'sms', 'email', 'dm', 'voicemail', 'mailer')),
  outcome      TEXT        CHECK (outcome IN (
                 'no_answer', 'voicemail', 'callback_requested',
                 'not_interested', 'interested', 'appointment_set', 'wrong_number'
               )),
  notes        TEXT,
  isa_name     TEXT,
  touched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_touches_lead ON lead_touches(lead_id);

-- ─── Update deals table with commission tracking ──────────────────────────────

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS assigned_agent_id    UUID REFERENCES team_agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS isa_lead_id          UUID REFERENCES isa_leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_source    TEXT CHECK (commission_source IN (
                                                  'self_sourced', 'relocation_partner',
                                                  'inrange_generated', 'brokerage_provided', 'agent_sourced'
                                                )),
  ADD COLUMN IF NOT EXISTS sale_price           NUMERIC,
  ADD COLUMN IF NOT EXISTS commission_rate_pct  NUMERIC(5,3) DEFAULT 2.500,
  ADD COLUMN IF NOT EXISTS gross_commission     NUMERIC,
  ADD COLUMN IF NOT EXISTS your_split_pct       NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS agent_split_pct      NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS override_pct         NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS your_gross           NUMERIC,
  ADD COLUMN IF NOT EXISTS agent_gross          NUMERIC,
  ADD COLUMN IF NOT EXISTS your_override        NUMERIC,
  ADD COLUMN IF NOT EXISTS your_total           NUMERIC;

-- Commission auto-compute trigger
CREATE OR REPLACE FUNCTION compute_deal_commission()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sale_price IS NOT NULL AND NEW.commission_rate_pct IS NOT NULL THEN
    NEW.gross_commission := ROUND(NEW.sale_price * NEW.commission_rate_pct / 100, 2);
  END IF;

  IF NEW.commission_source IN ('self_sourced', 'inrange_generated') THEN
    NEW.your_split_pct  := 85.00;
    NEW.agent_split_pct := 0;
    NEW.override_pct    := 0;
  ELSIF NEW.commission_source = 'brokerage_provided' THEN
    NEW.your_split_pct  := 50.00;
    NEW.agent_split_pct := 50.00;
  ELSIF NEW.commission_source = 'agent_sourced' THEN
    SELECT
      COALESCE(ta.self_sourced_pct, 85),
      100 - COALESCE(ta.self_sourced_pct, 85),
      COALESCE(ta.override_pct, 0)
    INTO NEW.agent_split_pct, NEW.your_split_pct, NEW.override_pct
    FROM team_agents ta
    WHERE ta.id = NEW.assigned_agent_id;
  END IF;

  IF NEW.gross_commission IS NOT NULL THEN
    NEW.your_gross    := ROUND(NEW.gross_commission * COALESCE(NEW.your_split_pct, 85) / 100, 2);
    NEW.agent_gross   := ROUND(NEW.gross_commission * COALESCE(NEW.agent_split_pct, 0) / 100, 2);
    NEW.your_override := ROUND(COALESCE(NEW.agent_gross, 0) * COALESCE(NEW.override_pct, 0) / 100, 2);
    NEW.your_total    := COALESCE(NEW.your_gross, 0) + COALESCE(NEW.your_override, 0);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER IF NOT EXISTS trg_deal_commission
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION compute_deal_commission();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE team_agents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE isa_leads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_touches ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "auth all team_agents"  ON team_agents  FOR ALL TO authenticated USING (true);
CREATE POLICY IF NOT EXISTS "auth all isa_leads"    ON isa_leads    FOR ALL TO authenticated USING (true);
CREATE POLICY IF NOT EXISTS "auth all lead_touches" ON lead_touches FOR ALL TO authenticated USING (true);

-- ─── Views ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW isa_pipeline AS
SELECT
  l.id, l.segment, l.market, l.commission_source,
  l.full_name, l.entity_name, l.phone, l.email,
  l.rep_name, l.rep_phone, l.rep_email, l.linkedin_url,
  l.routing, l.outreach_status, l.bant_score, l.motivation_score,
  l.ai_summary, l.isa_talking_points, l.property_address,
  l.price_range_min, l.price_range_max, l.timeline_months,
  l.contract_value, l.team_name, l.sport, l.production_name,
  l.employer, l.origin_country, l.source_name, l.source_url,
  ta.full_name  AS agent_name,
  ta.phone      AS agent_phone,
  l.assigned_isa,
  l.created_at,
  COUNT(t.id)::INTEGER AS touch_count,
  MAX(t.touched_at)    AS last_touched_at,
  MAX(t.outcome)       AS last_outcome
FROM isa_leads l
LEFT JOIN team_agents ta ON ta.id = l.assigned_agent_id
LEFT JOIN lead_touches t  ON t.lead_id = l.id
GROUP BY l.id, ta.full_name, ta.phone;

CREATE OR REPLACE VIEW agent_commission_summary AS
SELECT
  ta.id           AS agent_id,
  ta.full_name,
  ta.brokerage,
  ta.market,
  COUNT(d.id)             AS deals_closed,
  SUM(d.sale_price)       AS total_volume,
  SUM(d.gross_commission) AS total_gci,
  SUM(d.your_total)       AS total_to_you,
  SUM(d.your_override)    AS total_overrides,
  SUM(d.agent_gross)      AS total_to_agent
FROM team_agents ta
LEFT JOIN deals d ON d.assigned_agent_id = ta.id
  AND d.status = 'closed'
  AND EXTRACT(YEAR FROM d.close_date) = EXTRACT(YEAR FROM CURRENT_DATE)
GROUP BY ta.id, ta.full_name, ta.brokerage, ta.market;

CREATE OR REPLACE VIEW segment_roi AS
SELECT
  l.segment,
  l.market,
  l.commission_source,
  COUNT(DISTINCT l.id)                                                         AS leads_total,
  COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'appointment_set')   AS appointments,
  COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'closed')            AS closed,
  ROUND(
    COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'appointment_set')::numeric
    / NULLIF(COUNT(DISTINCT l.id), 0) * 100, 1
  )                                                                            AS appt_rate_pct,
  SUM(d.your_total)                                                            AS total_revenue_to_you
FROM isa_leads l
LEFT JOIN deals d ON d.isa_lead_id = l.id AND d.status = 'closed'
GROUP BY l.segment, l.market, l.commission_source
ORDER BY total_revenue_to_you DESC NULLS LAST;
