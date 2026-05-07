-- InRange: Views and helper functions for Retool dashboard

-- ─── Views ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW scored_properties AS
SELECT
  p.id,
  p.source,
  p.parcel_id,
  p.address,
  p.city,
  p.state,
  p.zip,
  p.county,
  p.owner_name,
  p.property_type,
  p.assessed_value,
  p.market_value,
  p.distress_flags,
  ps.composite_score,
  ps.tier,
  ps.score_components,
  ps.ai_summary,
  ps.scored_at,
  p.created_at,
  p.updated_at
FROM properties p
JOIN property_scores ps ON ps.property_id = p.id;

-- Retool primary view: hottest leads first
CREATE OR REPLACE VIEW leads_dashboard AS
SELECT
  sp.*,
  CASE sp.tier
    WHEN 1 THEN 'Tier 1 — Hot'
    WHEN 2 THEN 'Tier 2 — Warm'
    WHEN 3 THEN 'Tier 3 — Cool'
    ELSE        'Tier 4 — Cold'
  END AS tier_label,
  (
    SELECT COUNT(*) FROM notifications n
    WHERE n.property_id = sp.id AND n.status = 'sent'
  ) AS notification_count
FROM scored_properties sp
ORDER BY sp.composite_score DESC;

-- Properties that haven't been scored yet
CREATE OR REPLACE VIEW unscored_properties AS
SELECT p.*
FROM properties p
LEFT JOIN property_scores ps ON ps.property_id = p.id
WHERE ps.id IS NULL;

-- Properties with scores but no AI summary (enrich-ai queue)
CREATE OR REPLACE VIEW unenriched_properties AS
SELECT sp.*
FROM scored_properties sp
WHERE sp.ai_summary IS NULL
  AND sp.tier <= 2
ORDER BY sp.composite_score DESC;

-- Summary stats for Retool dashboard header
CREATE OR REPLACE VIEW pipeline_summary AS
SELECT
  COUNT(*)                                           AS total_properties,
  COUNT(*) FILTER (WHERE source = 'nyc')             AS nyc_count,
  COUNT(*) FILTER (WHERE source = 'nj')              AS nj_count,
  COUNT(ps.id)                                       AS scored_count,
  COUNT(ps.id) FILTER (WHERE ps.tier = 1)            AS tier1_count,
  COUNT(ps.id) FILTER (WHERE ps.tier = 2)            AS tier2_count,
  COUNT(ps.id) FILTER (WHERE ps.tier = 3)            AS tier3_count,
  COUNT(ps.id) FILTER (WHERE ps.tier = 4)            AS tier4_count,
  MAX(p.updated_at)                                  AS last_ingest_at
FROM properties p
LEFT JOIN property_scores ps ON ps.property_id = p.id;

-- ─── Helper Functions ────────────────────────────────────────────────────────

-- Returns distress flag types for a property as a simple text array
CREATE OR REPLACE FUNCTION distress_types(flags JSONB)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(
    SELECT elem->>'type'
    FROM jsonb_array_elements(flags) AS elem
  );
$$;

-- Counts how many distinct distress signals a property has
CREATE OR REPLACE FUNCTION distress_count(flags JSONB)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_array_length(flags);
$$;
