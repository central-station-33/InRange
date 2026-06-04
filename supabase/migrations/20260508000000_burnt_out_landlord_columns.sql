-- Add burnt-out landlord scoring columns to properties table

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS burnt_out_score    SMALLINT CHECK (burnt_out_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS burnt_out_signals  JSONB,
  ADD COLUMN IF NOT EXISTS deal_type          TEXT;

CREATE INDEX IF NOT EXISTS idx_properties_burnt_out_score ON properties(burnt_out_score DESC)
  WHERE burnt_out_score IS NOT NULL;
