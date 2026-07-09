# Data Sources

---

## Property Pipeline (Distressed Investor Leads)

### New York City

All NYC sources are free via NYC Open Data (Socrata API).
Register for an app token at https://data.cityofnewyork.us/profile/app_tokens
to raise the default rate limit from 1,000 to 50,000 rows/day.

| Signal | Dataset | Socrata ID | ingest-nyc field |
|---|---|---|---|
| Tax Lien | NYC DOF Tax Lien Sale | `9rz4-mjeg` | `distress_flags[].type = "tax_lien"` |
| Code Violations | HPD Building Complaints | `uwyv-629c` | `distress_flags[].type = "code_violation"` |
| Foreclosure | ACRIS Lis Pendens | `2p6d-qhgr` | `distress_flags[].type = "foreclosure"` |

**Property ID format (BBL)**
NYC uses Borough-Block-Lot (BBL): `{1-digit borough}{5-digit block}{4-digit lot}`

**Useful additional NYC datasets (not yet implemented)**
- DOF Property Valuation (`rgy2-tti8`) — assessed vs market value trends
- HPD Violations (`wvxf-dwi5`) — more granular than complaints
- NYC Probate (Surrogate's Court) — no open API; requires NYSCEF scraping via Apify

### New Jersey

**MOD-IV (Municipal Tax Data)**
NJ statewide property tax database, published quarterly via NJOGIS ArcGIS.
- Endpoint: `https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/MOD4_Assessment_Statewide/FeatureServer/0/query`
- Key fields: `PAMS_PIN`, `OWNER`, `PROPERTY_LOCATION`, `DELINQUENT_TAXES`, `YEARS_DELINQUENT`

**NJ Sheriff Sales** — county-level, no central API.

| County | Population | Sheriff Sale URL |
|---|---|---|
| Hudson | 672k | https://www.hudsoncountysheriff.com/sheriff-sales |
| Essex | 858k | https://www.essexsheriff.com/sheriff-sales |
| Bergen | 958k | https://www.bcso.us/services/sheriff-sales |
| Middlesex | 863k | https://www.middlesexcountysheriff.com |
| Passaic | 507k | https://www.passaicsheriff.com |
| Union | 576k | https://www.ucnj.org/sheriff |

---

## ISA Lead Pipeline (People-Centric)

### Segment 1: Athletes — `crawlerbros/espn-rosters-player-stats`

| Field | Source |
|---|---|
| Player name, team, sport | ESPN Transactions API via Apify |
| Contract value | Spotrac.com (Apify RAG browser) |
| Agent name / phone / email | NFLPA.com agent search, profootballrumors.com |
| Social media handles | Instagram / Twitter direct search |

**NY/NJ teams monitored:**
NFL: Giants (NYG), Jets (NYJ)
NBA: Knicks (NY), Nets (BKN)
MLB: Yankees (NYY), Mets (NYM)
NHL: Rangers (NYR), Islanders (NYI), Devils (NJD)
MLS: NYCFC, NY Red Bulls (RBNY)
WNBA: NY Liberty

**Apify Actor:** `crawlerbros/espn-rosters-player-stats`
Input: `{ leagues: [...], teams: [...], season: YYYY }`
Cost: ~$0.00167/result

---

### Segment 2: Motivated Sellers — `sovereigntaylor/zillow-scraper`

| Filter | Signal |
|---|---|
| daysOnMarket >= 60 | Frustrated seller |
| listingStatus = "off_market" | Expired/withdrawn |
| ownerName present | Direct outreach possible |
| priceReduced = true | Motivated to deal |

**Apify Actor:** `sovereigntaylor/zillow-scraper` (FREE)
Input: `{ listingType: "for_sale", location: "New York, NY", maxResults: 100 }`

**StreetEasy (NYC):** `shahidirfan/StreetEasy-Scraper` (FREE)
Input: `{ start_url: "https://streeteasy.com/for-sale/nyc?...", listing_type: "sale" }`

**Public records supplement:**
- ACRIS (acris.nyc.gov) — lis pendens = pre-foreclosure
- NJ Courts portal — lis pendens by county
- NYC DOF tax lien lists — annual publication

---

### Segment 3: Film & TV Productions

| Source | Data |
|---|---|
| NYC MOME weekly permits | Production name, company, location, dates |
| NJ Film Commission (njfilm.org) | NJ-based productions |
| Deadline.com / Variety.com | Production announcements |

**Apify Actor:** `apify/rag-web-browser`
Query: `"NYC film permit" site:nyc.gov/mome` or fetch permit PDF directly.

**Housing coordinator search:**
Apify Actor: `powerai/linkedin-peoples-search-scraper`
Input: `{ title: "housing coordinator", company: "{{production_company}}", geocode_location: "New York" }`
Cost: ~$0.01/result + $0.09 actor start

---

### Segment 4: Expat / Corporate Relocations

| Source | Data |
|---|---|
| BusinessWire / PR Newswire | Company relocation announcements |
| LinkedIn People Search | HR / relocation coordinator contacts |
| Internations.org | Expat community events (for B2B partnerships) |

**Apify Actor:** `apify/rag-web-browser`
Query: `"relocating to New York" OR "new office" site:businesswire.com [current year]`

**LinkedIn Actor:** `powerai/linkedin-peoples-search-scraper`
Input: `{ title: "relocation coordinator", geocode_location: "New York" }`

---

### Segment 5: Investors

| Source | Data |
|---|---|
| ACRIS (NYC) | Cash buyers — deeds with no mortgage recorded same day |
| NJ county clerk portals | LLC grantees = likely investors |
| BiggerPockets.com | Active forum posters in NY/NJ threads |

**Apify Actor:** `apify/rag-web-browser`
Query: `"bought cash" OR "all cash" multifamily Brooklyn OR Queens site:therealdeal.com`

---

### Segments 6–9: Divorce, Empty Nesters, First-Time Buyers, Developers

These segments rely primarily on public court records and community signal scraping.
Use `apify/rag-web-browser` with the queries documented in `docs/isa-agents/isa-prospect-finder.md`.

No dedicated Apify actor exists for these; RAG browser + Claude extraction is the approach.

---

## Data Freshness

| Source | Frequency | Scenario |
|---|---|---|
| NYC property data | Daily | 1 |
| NJ MOD-IV | Quarterly (daily no-ops) | 2 |
| NJ sheriff sales | Weekly | 2 |
| ESPN athlete transactions | Daily | 6 |
| Zillow motivated sellers | Daily | 7, 8 |
| NYC MOME film permits | Weekly | 9 |
| Corporate relocation news | Weekly | 10 |
| Lead enrichment (Claude) | Daily | 11 |
| ISA notifications | Daily | 12, 13 |
