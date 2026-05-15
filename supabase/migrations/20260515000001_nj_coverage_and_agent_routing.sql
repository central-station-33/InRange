-- Migration: NJ Coverage Expansion + Agent Routing Rules
-- Applied: 2026-05-15
-- Adds:
--   1. relocation_partners — referral partner table with split %s
--   2. NJ coverage columns (state, county, relocation_partner_id) on isa_leads
--   3. agent_routing_rules — priority-based lead assignment config per agent
--   4. RLS for new tables
--   5. Recreated views (isa_pipeline, agent_commission_summary, segment_roi)
--      with new state/county columns included in isa_pipeline

-- ─── Drop views before altering isa_leads ────────────────────────────────────

DROP VIEW IF EXISTS segment_roi;
DROP VIEW IF EXISTS agent_commission_summary;
DROP VIEW IF EXISTS isa_pipeline;

-- ─── Relocation Partners ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relocation_partners (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_name     TEXT        NOT NULL,
  your_pct         NUMERIC     NOT NULL DEFAULT 35.00,
  referral_fee_pct NUMERIC     NOT NULL DEFAULT 30.00,
  notes            TEXT,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── NJ coverage columns on isa_leads ────────────────────────────────────────

ALTER TABLE isa_leads
  ADD COLUMN IF NOT EXISTS state                CHAR(2),
  ADD COLUMN IF NOT EXISTS county               TEXT,
  ADD COLUMN IF NOT EXISTS relocation_partner_id UUID REFERENCES relocation_partners(id) ON DELETE SET NULL;

-- ─── Agent Routing Rules ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_routing_rules (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID        NOT NULL REFERENCES team_agents(id) ON DELETE CASCADE,
  segment          TEXT,
  market           TEXT,
  priority         INTEGER     NOT NULL DEFAULT 10,
  max_active_leads INTEGER     NOT NULL DEFAULT 25,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_agent   ON agent_routing_rules(agent_id);
CREATE INDEX IF NOT EXISTS idx_routing_rules_segment ON agent_routing_rules(segment);
CREATE INDEX IF NOT EXISTS idx_routing_rules_market  ON agent_routing_rules(market);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE relocation_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_routing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "auth all relocation_partners" ON relocation_partners FOR ALL TO authenticated USING (true);
CREATE POLICY IF NOT EXISTS "auth all agent_routing_rules" ON agent_routing_rules  FOR ALL TO authenticated USING (true);

-- ─── Recreate Views ───────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW isa_pipeline AS
SELECT
  l.id, l.segment, l.market, l.state, l.county, l.commission_source,
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
  COUNT(DISTINCT l.id)                                                          AS leads_total,
  COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'appointment_set')    AS appointments,
  COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'closed')             AS closed,
  ROUND(
    COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'appointment_set')::numeric
    / NULLIF(COUNT(DISTINCT l.id), 0) * 100, 1
  )                                                                             AS appt_rate_pct,
  SUM(d.your_total)                                                             AS total_revenue_to_you
FROM isa_leads l
LEFT JOIN deals d ON d.isa_lead_id = l.id AND d.status = 'closed'
GROUP BY l.segment, l.market, l.commission_source
ORDER BY total_revenue_to_you DESC NULLS LAST;
