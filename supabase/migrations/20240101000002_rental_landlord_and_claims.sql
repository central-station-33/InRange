-- InRange: Rental-landlord segment + lead-claim mechanism
--
-- Adds:
--   1. `segment` — separates the original distressed-seller pipeline from a
--      new rental_landlord segment (landlords with unrepresented rental
--      units), without touching the existing `source` (nyc/nj market) column.
--   2. Claim columns on `properties` — an "unclaimed until an agent claims
--      it" queue, with an atomic claim function to avoid two agents grabbing
--      the same lead.

-- ─── Segment column ─────────────────────────────────────────────────────────

ALTER TABLE properties
  ADD COLUMN segment TEXT NOT NULL DEFAULT 'distressed_seller'
    CHECK (segment IN ('distressed_seller', 'rental_landlord'));

CREATE INDEX idx_properties_segment ON properties(segment);

-- ─── Lead-claim columns ─────────────────────────────────────────────────────

ALTER TABLE properties
  ADD COLUMN claim_status TEXT NOT NULL DEFAULT 'unclaimed'
    CHECK (claim_status IN ('unclaimed', 'claimed')),
  ADD COLUMN claimed_by   TEXT,
  ADD COLUMN claimed_at   TIMESTAMPTZ,
  -- Set once notify-unclaimed has alerted an agent, so re-running the
  -- function doesn't re-alert on the same lead.
  ADD COLUMN claim_alert_sent_at TIMESTAMPTZ;

CREATE INDEX idx_properties_claim_status ON properties(claim_status);

-- Atomic claim — the WHERE clause on claim_status makes this safe against two
-- agents claiming the same lead at the same time; only the first UPDATE wins
-- and returns a row, the second returns nothing.
CREATE OR REPLACE FUNCTION claim_property(p_id UUID, p_agent TEXT)
RETURNS SETOF properties LANGUAGE sql AS $$
  UPDATE properties
  SET claim_status = 'claimed',
      claimed_by   = p_agent,
      claimed_at   = NOW()
  WHERE id = p_id
    AND claim_status = 'unclaimed'
  RETURNING *;
$$;

-- ─── View updates ───────────────────────────────────────────────────────────

-- Recreate scored_properties to surface the new columns (CREATE OR REPLACE
-- can append columns to a view without dropping it, since nothing here
-- removes or reorders the original column list).
CREATE OR REPLACE VIEW scored_properties AS
SELECT
  p.id,
  p.source,
  p.segment,
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
  p.updated_at,
  p.claim_status,
  p.claimed_by,
  p.claimed_at
FROM properties p
JOIN property_scores ps ON ps.property_id = p.id;

-- Unclaimed leads, hottest first — the view backing the "claim a lead" queue.
CREATE OR REPLACE VIEW unclaimed_leads AS
SELECT sp.*
FROM scored_properties sp
WHERE sp.claim_status = 'unclaimed'
ORDER BY sp.composite_score DESC;

-- Pipeline summary: add segment + claim breakdowns
CREATE OR REPLACE VIEW pipeline_summary AS
SELECT
  COUNT(*)                                                AS total_properties,
  COUNT(*) FILTER (WHERE source = 'nyc')                  AS nyc_count,
  COUNT(*) FILTER (WHERE source = 'nj')                   AS nj_count,
  COUNT(*) FILTER (WHERE segment = 'rental_landlord')     AS rental_landlord_count,
  COUNT(*) FILTER (WHERE claim_status = 'unclaimed')      AS unclaimed_count,
  COUNT(ps.id)                                            AS scored_count,
  COUNT(ps.id) FILTER (WHERE ps.tier = 1)                 AS tier1_count,
  COUNT(ps.id) FILTER (WHERE ps.tier = 2)                 AS tier2_count,
  COUNT(ps.id) FILTER (WHERE ps.tier = 3)                 AS tier3_count,
  COUNT(ps.id) FILTER (WHERE ps.tier = 4)                 AS tier4_count,
  MAX(p.updated_at)                                       AS last_ingest_at
FROM properties p
LEFT JOIN property_scores ps ON ps.property_id = p.id;
