# Canonical Data Model

Schema: `supabase/migrations/20240104000000_canonical_data_model.sql` (tables)
and `20240105000000_canonical_pipeline_support.sql` (default org + upsert
indexes). Renaming context: `20240103000000_rename_properties_to_legacy.sql`.

## Why two "properties" tables exist

The MVP pipeline's `properties` table (NYC/NJ tax-lien ingest → score →
enrich → notify) was renamed to `legacy_properties` so the canonical model
could use the plain `properties` name. `legacy_properties`,
`property_scores`, `notifications`, and their dependent views are
untouched and keep working — the rename doesn't break them, since Postgres
tracks foreign keys and views by object identity, not by name.

The two schemas are not (yet) the same data: `legacy_properties` is still
the source of truth for `score-properties`/`enrich-ai`/`notify-subscribers`/
`approve-notification`. The canonical tables are fed by a separate,
additive pipeline described below.

## Pipeline: raw_records → properties/parties/leads

```
ingest-nyc / ingest-nj
  │  fetch external data, upsert legacy_properties (unchanged)
  │  ALSO: insert one raw_records row per parcel (dual-write, additive)
  ▼
raw_records (processing_status='pending')
  │
  ▼
process-raw-records
  │  deterministic only — no AI model calls (model routing policy step 1:
  │  "deterministic source validation first")
  │  - upserts properties (canonical) by (organization_id, canonical_source, parcel_id)
  │  - classifies + upserts the owner as a party by (organization_id, normalized_name)
  │  - upserts a property_party_relationships row (relationship_type='owner')
  │  - scores distress_flags with the same scoreProperty() used by score-properties
  │  - upserts a leads row: deterministic_score, priority_tier (tier 1→A … 4→D)
  │  - logs an enrichment_runs row (provider='internal_rules', task_type='normalize_record')
  │  - marks the raw_records row 'processed' (or 'failed' + processing_error)
  ▼
leads (deterministic_score/priority_tier set; lead_status/assigned_agent_id/
       next_action/campaign_eligible/human_review_required left at their
       defaults for a human or a future AI-enrichment step to fill in)
```

Reprocessing is idempotent: re-running `process-raw-records` over the same
property (e.g. because a new raw_record arrived with an extra distress
signal) updates the existing `properties`/`parties`/`leads` rows in place
rather than creating duplicates, and only ever touches the deterministic
columns on `leads` — `lead_status`, `assigned_agent_id`, `next_action`, and
any AI-written fields are never overwritten by this function once a human
or another process has set them.

## What's NOT wired yet

- **AI enrichment of leads.** `enrich-ai` still only writes
  `property_scores.ai_summary` on `legacy_properties`. It does not yet
  write `leads.ai_signal_score`/`final_priority_score` or log
  `enrichment_runs` with `provider IN ('gemini','anthropic')`. Note
  `leads.final_priority_score` is constrained to require a
  `deterministic_score` alongside it (see `docs/model-routing.md`'s "do
  not calculate final_priority_score solely from AI output" rule) — any
  future wiring must set both together.
- **Outreach on leads.** `notify-subscribers`/`approve-notification`
  still operate on `legacy_properties`/`property_scores`/`subscribers`.
  `leads.campaign_eligible`/`human_review_required` exist for this
  purpose but nothing sets or reads them yet.
- **Multi-tenancy.** `organization_id` has a real FK target
  (`organizations`) but only one row exists — a seeded "Default
  Organization" (`00000000-0000-0000-0000-000000000001`), overridable via
  `DEFAULT_ORGANIZATION_ID`. There's no per-tenant provisioning, login, or
  org switcher anywhere in this app.
- **Only `Property`-shaped raw records are understood.**
  `process-raw-records` assumes `raw_payload_json` matches the shape
  `ingest-nyc`/`ingest-nj` already produce (source, parcel_id, address,
  city, state, zip, county, owner_name, property_type, assessed_value,
  market_value, distress_flags). Agent uploads, vendor imports, or
  webhook payloads with a different shape would need their own
  normalization logic before `process-raw-records` (or a variant of it)
  could process them.
- **`InRange-pipeline.json` / `InRange-seller-intake.json`** (the two
  Make.com blueprint files at the repo root) reference edge functions —
  `ingest-raw-properties`, `process-raw-properties`, `enrich-pending` —
  that don't exist in `supabase/functions/`. That gap predates this
  change and is unrelated to `process-raw-records`; left alone here.

## Party classification

`process-raw-records` classifies each owner name into a `party_type`
deterministically (regex match on LLC/INC/CORP/TRUST/ESTATE/BANK/
government keywords, default `individual`) — no AI model involved. This
is intentionally coarse; it's a first-pass classification, not a
verified one (`property_party_relationships.verification_status` is set
to `'source_backed'`, not `'human_verified'`).
