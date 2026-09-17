# Rental-Landlord Outreach (Segment: `rental_landlord`)

## What this is, and what it isn't

This is **not** a repurpose of an existing enrichment engine — nothing in this
repo, or in the live Make.com org, previously targeted landlords. It's a new
segment that reuses the *pattern* (ingest → score → enrich → notify) already
established for distressed sellers, pointed at a different signal: landlords
renting units themselves, with no brokerage involved.

## Why "unrepresented" is the whole point

A landlord actively self-listing a rental is a directly reachable
decision-maker — no buyer's agent, no listing agent, no gatekeeper. That's why
`frbo_unrepresented` (for-rent-by-owner) is weighted at 30 points in
`scoring.ts` — higher than everything except foreclosure/sheriff-sale in the
distressed-seller segment. The lead isn't "distressed," it's just reachable,
which for an agent's purposes is close to as valuable.

## Signals (see `supabase/functions/_shared/scoring.ts`)

| Signal | Points | What it means |
|---|---|---|
| `frbo_unrepresented` | 30 | Listed as a rental with no agent/brokerage attached |
| `portfolio_landlord` | 20 | Same owner contact has 2+ unrepresented listings |
| `long_dom_rental` | 15 | Listed 30+ days — priced wrong, or tired of self-managing |

## Data source: this has to be scraped, not pulled from an open API

NYC/NJ distressed-property data comes from free government APIs (Socrata,
NJOGIS). There is no equivalent free, structured API for rental listings —
this segment depends on a scraper.

**What I could and couldn't verify:** the Apify connection this Make team
already uses (4 separate Apify credentials are wired in) makes this feasible,
but I could not pin a specific, verified actor here — the actor-search tool
available in this session returned the same generic top-actors list
regardless of query (Instagram/TikTok/Google Maps scrapers) rather than
rental-specific results, so I'm not going to assert a specific actor ID I
haven't actually confirmed. Search the Apify Store directly for a maintained
Zillow-rentals or Craigslist rental-listings scraper before wiring this up —
check review count and last-updated date, since scraper actors break when
target sites change markup.

## How it plugs in

1. A Make scenario runs the chosen Apify actor (rental listings for NY/NJ),
   waits for the run to finish, and POSTs `dataset.items` to
   `ingest-rentals` (new function, `supabase/functions/ingest-rentals/`) as
   `{ "listings": [...] }`.
2. `score-properties` (existing function) scores `rental_landlord` rows the
   same way it scores everything else — no changes needed there, since
   scoring reads `distress_flags` generically.
3. `enrich-ai` and the claim/alert mechanism (see
   `docs/lead-claim-mechanism.md`) work unchanged — segment is just another
   filterable column.

## What's genuinely new vs. what's reused

| Reused as-is | New |
|---|---|
| `score-properties`, `enrich-ai`, `properties` table, `ingestion_runs` | `ingest-rentals` function, `segment` column, 3 scoring signals |
