-- Companion to retiring the enrich-property edge function (see its source
-- file for the full reasoning): update the arv_source column comment so it
-- doesn't point at a dead function as if it were still active.

COMMENT ON COLUMN public.properties.arv_source IS 'Where estimated_arv came from: comps (estimate-arv-comps, real sold MLS comps), ingest (source data normalization), ai_refined (was meant to be enrich-property''s Claude estimate -- that function was retired 2026-09-18 as dead code, never built, never wrote a single row; the value is kept in the CHECK constraint in case it gets built for real). NULL for rows written before this column existed.';
