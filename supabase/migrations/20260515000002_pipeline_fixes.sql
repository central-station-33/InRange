-- Migration: Pipeline bug fixes
-- Applied: 2026-05-15
-- Fixes:
--   1. CREATE TRIGGER IF NOT EXISTS is invalid Postgres — drop + recreate
--   2. UNIQUE constraint on lead_touches(lead_id, touch_number) to prevent races
--   3. next_touch_number() RPC for atomic touch number allocation
--   4. agent_workload_counts() RPC to replace full-table-scan workload check
--   5. isa_pipeline view: fix MAX(outcome) → last by touched_at

-- ─── 1. Fix commission trigger (DROP + CREATE, no IF NOT EXISTS on trigger) ──

DROP TRIGGER IF EXISTS trg_deal_commission ON deals;
CREATE TRIGGER trg_deal_commission
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION compute_deal_commission();

-- ─── 2. Unique constraint on lead_touches ─────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_lead_touch_number'
      AND conrelid = 'lead_touches'::regclass
  ) THEN
    ALTER TABLE lead_touches ADD CONSTRAINT uq_lead_touch_number UNIQUE (lead_id, touch_number);
  END IF;
END;
$$;

-- ─── 3. Atomic touch number allocation ───────────────────────────────────────

CREATE OR REPLACE FUNCTION next_touch_number(p_lead_id uuid)
RETURNS integer
LANGUAGE sql
AS $$
  SELECT COALESCE(MAX(touch_number), 0) + 1
  FROM lead_touches
  WHERE lead_id = p_lead_id;
$$;

-- ─── 4. Agent workload count aggregate ───────────────────────────────────────

CREATE OR REPLACE FUNCTION agent_workload_counts()
RETURNS TABLE (assigned_agent_id uuid, active_leads bigint)
LANGUAGE sql
AS $$
  SELECT assigned_agent_id, COUNT(*) AS active_leads
  FROM isa_leads
  WHERE outreach_status NOT IN ('dead', 'closed')
    AND assigned_agent_id IS NOT NULL
  GROUP BY assigned_agent_id;
$$;

-- ─── 5. Fix isa_pipeline view: last_outcome by recency, not alphabetical ─────

DROP VIEW IF EXISTS segment_roi;
DROP VIEW IF EXISTS isa_pipeline;

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
  -- Subquery returns the actual most-recent outcome, not alphabetical MAX.
  (SELECT outcome FROM lead_touches
   WHERE lead_id = l.id
   ORDER BY touched_at DESC
   LIMIT 1)            AS last_outcome
FROM isa_leads l
LEFT JOIN team_agents ta ON ta.id = l.assigned_agent_id
LEFT JOIN lead_touches t  ON t.lead_id = l.id
GROUP BY l.id, ta.full_name, ta.phone;

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
