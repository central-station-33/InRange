# Data Sources

## New York City

All NYC sources are free via NYC Open Data (Socrata API).
Register for an app token at https://data.cityofnewyork.us/profile/app_tokens
to raise the default rate limit from 1,000 to 50,000 rows/day.

| Signal | Dataset | Socrata ID | ingest-nyc field |
|---|---|---|---|
| Tax Lien | NYC DOF Tax Lien Sale | `9rz4-mjeg` | `distress_flags[].type = "tax_lien"` |
| Code Violations | HPD Building Complaints | `uwyv-629c` | `distress_flags[].type = "code_violation"` |
| Foreclosure | ACRIS Lis Pendens | `2p6d-qhgr` | `distress_flags[].type = "foreclosure"` |

### Property ID format (BBL)
NYC uses Borough-Block-Lot (BBL): `{1-digit borough}{5-digit block}{4-digit lot}`
- Borough 1 = Manhattan, 2 = Bronx, 3 = Brooklyn, 4 = Queens, 5 = Staten Island
- This is stored as `properties.parcel_id` for NYC records.

### Useful additional NYC datasets (not yet implemented)
- **DOF Property Valuation** (`rgy2-tti8`) — assessed vs market value trends
- **HPD Violations** (`wvxf-dwi5`) — more granular than complaints
- **NYC Probate (Surrogate's Court)** — no open API; would require scraping NYSCEF

---

## New Jersey

### MOD-IV (Municipal Tax Data)
New Jersey's statewide property tax database. Published quarterly by the
NJ Division of Taxation and exposed through NJOGIS as an ArcGIS Feature Service.

- **NJOGIS ArcGIS REST endpoint:**
  `https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/MOD4_Assessment_Statewide/FeatureServer/0/query`
- **Authentication:** None (public)
- **Key fields:** `PAMS_PIN`, `OWNER`, `PROPERTY_LOCATION`, `MUN_NAME`,
  `TOTAL_ASSESS`, `DELINQUENT_TAXES`, `YEARS_DELINQUENT`

Currently `ingest-nj` fetches only properties with `DELINQUENT_TAXES > 0`.
To expand coverage, remove that filter and apply scoring post-ingest.

### Sheriff Sales
NJ sheriff sales are conducted at the county level with no centralised API.

**Recommended approach (Make.com):**
Build one HTTP module per county that fetches the county sheriff's sale list,
parses the HTML/CSV, and POSTs the rows in the `sheriff_sales` array to `ingest-nj`.

Priority counties and their sheriff sale pages:

| County | Population | Sheriff Sale URL |
|---|---|---|
| Hudson | 672k | https://www.hudsoncountysheriff.com/sheriff-sales |
| Essex | 858k | https://www.essexsheriff.com/sheriff-sales |
| Bergen | 958k | https://www.bcso.us/services/sheriff-sales |
| Middlesex | 863k | https://www.middlesexcountysheriff.com |
| Passaic | 507k | https://www.passaicsheriff.com |
| Union | 576k | https://www.ucnj.org/sheriff |
| Mercer | 377k | https://www.mercercountysheriff.org |
| Camden | 523k | https://www.camdencounty.com/service/sheriff |

### NJ Lis Pendens
NJ lis pendens are filed with the county clerk and are not centralised.
The NJ Courts ACMS public portal has a case search at:
https://portal.njcourts.gov/webe4/ExternalPaperSearchWebPortal/pages/

This would require browser automation (Make.com + Apify or a custom scraper).
Not implemented in the current version.

---

## Data Freshness

| Source | Update Frequency | ingest-nyc trigger |
|---|---|---|
| NYC Tax Lien | Annual (spring) | Daily — new liens appear incrementally |
| NYC HPD Complaints | Real-time | Daily |
| ACRIS Lis Pendens | Real-time | Daily |
| NJ MOD-IV | Quarterly | Daily (no-ops when unchanged) |
| NJ Sheriff Sales | Weekly (county sites) | Daily |
