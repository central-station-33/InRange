-- ============================================================
-- InRange Retool Dashboard Queries
-- Resource name (Supabase): "InRange Supabase"
-- All queries use the `properties` and `inrange_leads` tables.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- Q1: get_pipeline_stats  (Stats Row at top of dashboard)
-- Bind to nothing; refresh on load + every 5 min
-- ─────────────────────────────────────────────────────────────
SELECT
  COUNT(*) FILTER (WHERE priority_tier = 'Tier 1')  AS tier1,
  COUNT(*) FILTER (WHERE priority_tier = 'Tier 2')  AS tier2,
  COUNT(*) FILTER (WHERE priority_tier = 'Tier 3')  AS tier3,
  COUNT(*) FILTER (WHERE priority_tier = 'Tier 4')  AS tier4,
  COUNT(*) FILTER (WHERE enrichment_status = 'pending')   AS pending_enrichment,
  COUNT(*) FILTER (WHERE enrichment_status = 'enriched')  AS enriched,
  COUNT(*)                                                 AS total_leads,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS new_today
FROM properties;

-- ─────────────────────────────────────────────────────────────
-- Q2: get_leads_table  (Main leadsTable component)
-- Params injected by Retool filters (use {{ }} in actual Retool)
-- ─────────────────────────────────────────────────────────────
SELECT
  id,
  address,
  city,
  state,
  zip,
  county,
  property_type,
  priority_tier,
  composite_score,
  distress_score,
  deal_quality_score,
  contact_likelihood_score,
  timeline_urgency_score,
  owner_name,
  owner_phone,
  owner_email,
  estimated_arv,
  amount_owed,
  asking_price,
  equity,
  equity_percentage,
  below_market_percentage,
  enrichment_status,
  distress_indicators,
  created_at
FROM properties
WHERE
  ({{ tierFilter.value }} = 'All' OR priority_tier = {{ tierFilter.value }})
  AND ({{ enrichFilter.value }} = 'All' OR enrichment_status = {{ enrichFilter.value }})
  AND (
    {{ searchInput.value }} = ''
    OR address ILIKE '%' || {{ searchInput.value }} || '%'
    OR owner_name ILIKE '%' || {{ searchInput.value }} || '%'
  )
ORDER BY
  CASE {{ sortField.value }}
    WHEN 'composite_score' THEN composite_score
    WHEN 'distress_score'  THEN distress_score
    WHEN 'equity'          THEN equity
    ELSE composite_score
  END DESC NULLS LAST
LIMIT  {{ pageSize.value }}
OFFSET {{ (pageNum.value - 1) * pageSize.value }};

-- ─────────────────────────────────────────────────────────────
-- Q3: get_lead_count  (for pagination label)
-- Same WHERE as Q2, just COUNT
-- ─────────────────────────────────────────────────────────────
SELECT COUNT(*) AS total
FROM properties
WHERE
  ({{ tierFilter.value }} = 'All' OR priority_tier = {{ tierFilter.value }})
  AND ({{ enrichFilter.value }} = 'All' OR enrichment_status = {{ enrichFilter.value }})
  AND (
    {{ searchInput.value }} = ''
    OR address ILIKE '%' || {{ searchInput.value }} || '%'
    OR owner_name ILIKE '%' || {{ searchInput.value }} || '%'
  );

-- ─────────────────────────────────────────────────────────────
-- Q4: get_property_detail  (Detail panel, runs on row click)
-- ─────────────────────────────────────────────────────────────
SELECT
  p.*,
  d.status          AS deal_status,
  d.deal_type,
  d.offer_price,
  d.contract_price,
  d.close_date,
  d.profit_estimate
FROM properties p
LEFT JOIN deals d ON d.property_id = p.id
WHERE p.id = {{ leadsTable.selectedRow.data.id }};

-- ─────────────────────────────────────────────────────────────
-- Q5: get_contact_history  (Detail panel – contact log tab)
-- ─────────────────────────────────────────────────────────────
SELECT
  contact_method,
  contact_date,
  outcome,
  notes,
  agent_id
FROM contact_activities
WHERE property_id = {{ leadsTable.selectedRow.data.id }}
ORDER BY contact_date DESC;

-- ─────────────────────────────────────────────────────────────
-- Q6: get_raw_pipeline  (Ingest monitoring tab)
-- Shows what Make.com has pushed but not yet scored
-- ─────────────────────────────────────────────────────────────
SELECT
  id,
  source,
  parcel_id,
  address,
  city,
  state,
  zip,
  county,
  property_type,
  distress_signals,
  created_at
FROM inrange_leads
ORDER BY created_at DESC
LIMIT 200;

-- ─────────────────────────────────────────────────────────────
-- Q7: get_source_breakdown  (Bar chart – ingest tab)
-- ─────────────────────────────────────────────────────────────
SELECT
  source,
  COUNT(*) AS count,
  MAX(created_at) AS last_seen
FROM inrange_leads
GROUP BY source
ORDER BY count DESC;

-- ─────────────────────────────────────────────────────────────
-- Q8: get_score_distribution  (Histogram data – analytics tab)
-- ─────────────────────────────────────────────────────────────
SELECT
  CASE
    WHEN composite_score >= 80 THEN '80-100'
    WHEN composite_score >= 60 THEN '60-79'
    WHEN composite_score >= 40 THEN '40-59'
    WHEN composite_score >= 20 THEN '20-39'
    ELSE '0-19'
  END AS score_bucket,
  COUNT(*) AS count
FROM properties
WHERE composite_score IS NOT NULL
GROUP BY score_bucket
ORDER BY score_bucket;

-- ─────────────────────────────────────────────────────────────
-- Q9: get_tier_trend  (Line chart – analytics tab, last 30 days)
-- ─────────────────────────────────────────────────────────────
SELECT
  DATE_TRUNC('day', created_at) AS day,
  priority_tier,
  COUNT(*) AS count
FROM properties
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY 1, 2
ORDER BY 1, 2;

-- ─────────────────────────────────────────────────────────────
-- Q10: update_deal_status  (Action from detail panel)
-- Triggered by "Update Deal" button
-- ─────────────────────────────────────────────────────────────
INSERT INTO deals (property_id, status, deal_type, offer_price, notes)
VALUES (
  {{ leadsTable.selectedRow.data.id }},
  {{ dealStatusSelect.value }},
  {{ dealTypeSelect.value }},
  {{ offerPriceInput.value }},
  {{ dealNotesInput.value }}
)
ON CONFLICT (property_id) DO UPDATE SET
  status      = EXCLUDED.status,
  deal_type   = EXCLUDED.deal_type,
  offer_price = EXCLUDED.offer_price,
  notes       = EXCLUDED.notes,
  updated_at  = NOW();

-- ─────────────────────────────────────────────────────────────
-- Q11: log_contact_activity  (Action from detail panel)
-- ─────────────────────────────────────────────────────────────
INSERT INTO contact_activities
  (property_id, contact_method, contact_date, outcome, notes)
VALUES (
  {{ leadsTable.selectedRow.data.id }},
  {{ contactMethodSelect.value }},
  NOW(),
  {{ contactOutcomeSelect.value }},
  {{ contactNotesInput.value }}
);
