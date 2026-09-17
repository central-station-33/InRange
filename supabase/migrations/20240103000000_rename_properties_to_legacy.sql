-- InRange: Reclaim the `properties` name for the new canonical data model.
--
-- The MVP pipeline's `properties` table (NYC/NJ ingestion + scoring) is
-- renamed to `legacy_properties`. This is a pure rename: Postgres tracks
-- dependent objects (foreign keys, views, indexes, triggers) by OID, not by
-- name, so `property_scores`, `notifications`, and every view built on top
-- of `properties` (`scored_properties`, `unscored_properties`,
-- `pipeline_summary`, `leads_dashboard`, `unenriched_properties`,
-- `campaign_eligible_properties`) keep working unchanged after this
-- migration — nothing here alters their definitions.
--
-- What DOES need updating after this migration: any application code that
-- references the table by name via a `.from('properties')`-style call
-- (PostgREST resolves table names at request time, unlike SQL views). In
-- this repo that's `ingest-nyc` and `ingest-nj`, which are updated in the
-- same change that ships this migration to keep them working.

ALTER TABLE properties RENAME TO legacy_properties;

COMMENT ON TABLE legacy_properties IS
  'MVP-era property table (NYC/NJ ingest -> score -> enrich -> notify pipeline). Superseded by the canonical properties/parties/leads model — see 20240104000000_canonical_data_model.sql. Kept in place because property_scores, notifications, and their dependent views/edge functions still read and write it.';

-- Indexes and constraints keep their old, now-misleading names (e.g.
-- idx_properties_source) since renaming them is purely cosmetic and not
-- required for correctness; left as-is to keep this migration a pure,
-- low-risk rename.
