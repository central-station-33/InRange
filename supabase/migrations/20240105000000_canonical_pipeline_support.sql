-- InRange: Support for wiring the ingest pipeline onto the canonical model.
--
-- Two things the canonical-data-model migration didn't need yet, but the
-- actual raw_records -> properties/parties/leads pipeline does:
--
-- 1. A default organization. This app has no tenancy concept anywhere
--    else (no login/org switcher), so there is nothing for ingest-nyc/
--    ingest-nj/process-raw-records to read a "current org" from. A fixed,
--    well-known row lets single-tenant deployments work out of the box;
--    edge functions read DEFAULT_ORGANIZATION_ID from the environment and
--    fall back to this id if unset. Replace with real per-tenant
--    provisioning if/when this app grows multiple organizations.
--
-- 2. Unique indexes so `properties`, `parties`, `property_party_relationships`,
--    and `leads` can be upserted idempotently as raw_records are
--    (re)processed, instead of accumulating duplicate rows on every run.

INSERT INTO organizations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organization')
ON CONFLICT (id) DO NOTHING;

-- One canonical property per (org, source, parcel) — mirrors the
-- (source, parcel_id) uniqueness legacy_properties already relies on.
--
-- Deliberately NOT a partial index (no `WHERE parcel_id IS NOT NULL`):
-- Postgres already treats NULL as distinct from every other NULL in a
-- unique index, so multiple NULL-parcel_id rows are allowed regardless.
-- A partial predicate here would also break upserts — PostgREST-style
-- `ON CONFLICT (columns) DO UPDATE` (what supabase-js sends) can only
-- infer against a full unique index, not a partial one, since the
-- inference clause can't carry the index's WHERE predicate.
CREATE UNIQUE INDEX idx_properties_org_source_parcel
  ON properties(organization_id, canonical_source, parcel_id);

-- One canonical party per (org, normalized_name) — a deliberately coarse
-- MVP match; distinguishing same-named parties is future work. Same
-- non-partial reasoning as above.
CREATE UNIQUE INDEX idx_parties_org_normalized_name
  ON parties(organization_id, normalized_name);

-- One relationship row per (property, party, relationship_type);
-- reprocessing a newer raw_record for the same pair updates its
-- source_record_id/confidence rather than creating a duplicate.
CREATE UNIQUE INDEX idx_ppr_property_party_type
  ON property_party_relationships(property_id, party_id, relationship_type);

-- One lead per property for this MVP wiring (mirrors property_scores'
-- UNIQUE(property_id) in the legacy schema). Revisit if/when a property
-- needs multiple concurrent leads (e.g. reopened after a closed deal).
CREATE UNIQUE INDEX idx_leads_property_unique
  ON leads(property_id);
