# Data Sources

Rewritten 2026-09-17 by reading the dataset URLs directly out of the live
edge function source in `supabase/functions/` (pulled from production —
see the repo README). Previous versions of this doc described datasets that
are no longer referenced anywhere in the code; if you find another mismatch,
trust the source code over this file and fix this file.

## New York City (NYC Open Data / Socrata)

All calls are **unauthenticated** — no `NYC_OPEN_DATA_APP_TOKEN` is set or
read by any function, so requests run against Socrata's default (lower) rate
limit. Register an app token at
https://data.cityofnewyork.us/profile/app_tokens if ingestion starts hitting
429s.

| Dataset | Socrata ID | Used by |
|---|---|---|
| HPD Violations | `wvxf-dwi5` | `ingest-nyc`, `nyc-diag` |
| NYC Evictions | `6z8x-wfk4` | `ingest-nyc` |
| HPD Registration Contacts | `feu5-w2e2` | `ingest-nyc` |
| PLUTO (parcel/zoning reference) | `64uk-42ks` | `ingest-nyc`, `nyc-diag`, `coop-diag` |
| DOF Property Valuation | `yjxr-fw8i` | `ingest-nyc` |
| ACRIS Real Property Legals | `8h5j-fqxa` | `ingest-nyc`, `ingest-acris-investors`, `nyc-diag` |
| ACRIS Real Property Master | `bnx9-e6tj` | `ingest-nyc`, `ingest-acris-investors`, `nyc-diag` |
| ACRIS Real Property Parties | `636b-3b5g` | `ingest-acris-investors` |

**No NYC DOF Tax Lien Sale dataset is currently ingested** (previously
documented as `9rz4-mjeg` — not present anywhere in the current codebase).
The `tax_lien` scoring signal is now derived only from NJ MOD-IV
`delinquent_amount` (see `_shared/scoring.ts` in `score-property` /
`rescore-properties` / `process-raw-properties` — `tax_lien` fires when
`delinquent_amount > 5000`). If NYC tax-lien coverage matters, it needs to be
added back, not assumed to exist.

There's a dedicated `probe-acris-lis-pendens` function (5 lines) — check it
directly if you need current lis-pendens handling; it's too small to
characterize confidently here without risking going stale again.

### Property ID format (BBL)
NYC uses Borough-Block-Lot (BBL): `{1-digit borough}{5-digit block}{4-digit lot}`.
Borough 1 = Manhattan, 2 = Bronx, 3 = Brooklyn, 4 = Queens, 5 = Staten Island.

## New Jersey

**There are three different NJ ArcGIS endpoints in use across different
functions** — this looks like drift, not intentional design, and is worth
consolidating rather than treating as settled:

| Endpoint | FeatureServer | Used by |
|---|---|---|
| `services2.arcgis.com/XVOqAjTOJ5P6ngMu/.../Parcels_MODIV_NJ_WM/FeatureServer/0` | Parcels_MODIV_NJ_WM | `ingest-nj` |
| `services2.arcgis.com/XVOqAjTOJ5P6ngMu/.../Parcels_and_MOD_IV_Composite/FeatureServer/0` | Parcels_and_MOD_IV_Composite | `burnt-out-landlord-scan` |
| `data.nj.gov/resource/w9se-dmra.json` | (Socrata-style, not ArcGIS) | `ingest-nj-developer-leads` (NJ building permits) |

**Authentication:** none required for any of the three.

Sheriff sales and NJ lis pendens are not centralized/API-accessible (still
true as of this rewrite) — no automated ingestion path exists in the current
edge functions for either; if a Make.com scenario handles county-by-county
sheriff-sale scraping, it isn't reflected in this repo.

## Skip Tracing

`skip-trace-leads` calls out to **DataSkip** (`DATASKIP_API_KEY`), gated by
the `skip_trace_confirmations` table — a token issued before the call is
consumed once, preventing accidental repeat paid lookups. `anon` and
`authenticated` roles are explicitly denied all access to that table
(`deny_all_client_access` policy); only the service role can read/write it.

## ARV / Comps

`estimate-arv-comps` calls **SimplyRETS** (`SIMPLYRETS_API_KEY` /
`SIMPLYRETS_API_SECRET`) for real sold-MLS comparables. Results land in
`properties.estimated_arv` with `arv_source = 'comps'` and
`arv_comp_method` recording whether it used `price_per_sqft` or
`median_sold_price`. `arv_source = 'ai_refined'` means a Claude call
(`enrich-property`) adjusted the comps-based estimate instead — but see the
README: `enrich-property` is currently deployed empty, so treat
`ai_refined` rows with suspicion until that's resolved.

## Notes on staleness

This file reflects what the code does as of 2026-09-17. It will go stale the
same way the last version did unless changes to `supabase/functions/*/source
are accompanied by an update here in the same commit.
