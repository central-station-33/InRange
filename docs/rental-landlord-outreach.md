# Rental-Landlord Outreach (ISA Segment: `landlord`)

Targets landlords with **unrepresented rental units** — self-listed (FRBO)
postings with no leasing agent — for outreach offering leasing
representation. This is a distinct segment from `renter` (tenant-side
matching, via `rental_inquiries`/`rental_matches`) and from the
`motivated_seller`/`homeowner` segments (owners looking to sell, not lease).

## Why this needed building, not just documenting

The live Supabase project (`omzugrtgwsjypekuzgtn`) already had a full data
model provisioned for this — `landlord_leads`, `rental_units`,
`rental_inquiries`, `rental_matches`, `tours`, `rental_applications` — with
**zero rows** and **no ingest, no scoring, no Make scenario** feeding any of
it. This doc describes what was added to close that gap.

## Architecture

```
Make: Apify (HotPads/StreetEasy, owner-listed filter) → run-sync-get-dataset-items
  │
  ▼
Make: HTTP POST → ingest-rental-landlord-leads (Supabase Edge Function)
  │  writes isa_leads (segment='landlord') + landlord_leads + rental_units
  │  assigned_agent_id left NULL -- see "Lead-claim mechanism" below
  ▼
Central Hub: `unclaimed_leads` view (Retool / any SQL client)
  │
  ▼
Make: Unclaimed Landlord Lead Alert (Email, every 15 min) → Gmail
  │
  ▼
Agent claims via claim-lead (Supabase Edge Function)
```

## Data sources (Apify actors, unrepresented-unit filter applied at the actor)

| Actor | Market | "Unrepresented" filter | Notes |
|---|---|---|---|
| `fatihtahta/hotpads-scraper` | NJ + NYC | `for_rent_by_owner: true` | No statewide search — must pass a city/neighborhood/ZIP. $0.00099/listing. |
| `kawsar/streeteasy-scraper-it-work` | NYC | `byOwner: true` | Not yet wired into a scenario; same ingest endpoint accepts its output. |

The Make scenario **InRange – ISA S21: Landlord Lead Ingest (Unrepresented
Rentals, HotPads FRBO Pilot)** (id 6317687, created inactive) pilots one NJ
submarket (Hoboken) via `apify:apifyApiCall` → `run-sync-get-dataset-items`,
then POSTs the raw dataset array straight through to the ingest function.
Expand to more NJ luxury submarkets (Summit, Montclair, Jersey City
Downtown, Hoboken, Weehawken) and NYC neighborhoods by duplicating the first
module with a different `location` and adding a router, or converting it to
iterate a location list.

**Exact HotPads/StreetEasy output field names were not verified live from
this environment** (no outbound network access to test-run the actor from
here). `ingest-rental-landlord-leads` reads listing fields defensively via a
`FIELD_CANDIDATES` map — the same pattern `ingest-nj-developer-leads` uses
for the same reason. After the first real run, check `raw_data` on a
resulting `isa_leads` row against `FIELD_CANDIDATES` in the function source
and correct any field names that didn't match.

## Edge Functions (deployed to `omzugrtgwsjypekuzgtn`)

### `ingest-rental-landlord-leads`
`POST /ingest-rental-landlord-leads?market=nj&source_name=hotpads_frbo`
Body: the raw Apify dataset array (top-level, not wrapped). Upserts
`isa_leads` (segment=`landlord`, module=`rental_leasing`,
`assigned_agent_id` left NULL) + `landlord_leads` + `rental_units`. Dedupes
on `source_url` when present, else on the composed address, scoped to
segment+market and excluding dead/closed leads.

### `claim-lead`
`POST /claim-lead` with `{ lead_id, agent_id }`. Atomic
`UPDATE ... WHERE assigned_agent_id IS NULL` — the whole race-safety of the
claim mechanism lives in that one WHERE clause, not in application logic.
Returns 409 if the lead was already claimed (or doesn't exist / is
dead-closed).

Both functions gate on the existing `x-make-secret` header
(`MAKE_WEBHOOK_SECRET`), consistent with every other Make-facing function in
this project.

## Lead-claim mechanism

There is no new "unclaimed" status value. Instead:

1. `ingest-rental-landlord-leads` never sets `assigned_agent_id`.
2. The `landlord` segment is **deliberately not added** to
   `agent_routing_rules`, so `assign-leads` (the existing auto-router) skips
   it entirely — auto-routing and manual claiming are mutually exclusive by
   segment, not by a status flag that could drift out of sync.
3. `unclaimed_leads` (new SQL view, segment-agnostic) is the Central Hub
   queue: any `isa_leads` row with `assigned_agent_id IS NULL` and
   `outreach_status NOT IN ('dead','closed')`, left-joined to
   `landlord_leads` for this segment's detail fields.
4. `claim-lead` is the only way a `landlord`-segment row gets an
   `assigned_agent_id`.
5. **InRange – Unclaimed Landlord Lead Alert (Email)** (Make scenario id
   6317690, created inactive, 15-min interval) queries `unclaimed_leads`
   for rows from the last 20 minutes and emails jtaffairs@gmail.com via the
   existing Gmail connection. No Slack/Twilio connection exists in this
   Make account yet — swap the last module for Slack/SMS once those
   connections are added.

If Airtable is preferred over this Supabase-based Central Hub later, the
`unclaimed_leads` view is the thing to mirror into an Airtable base (e.g.
via a Make scenario syncing on the same schedule) — nothing here is
Airtable-incompatible, there just isn't an Airtable connection in this
account today.

## Before activating either new Make scenario

Both were created via the Make API and are **inactive by default**. Review
in the Make UI before turning them on:
- Confirm the `apify:apifyApiCall` module's body reaches HotPads as
  expected (run once manually, inspect the output bundle).
- Confirm `FIELD_CANDIDATES` in `ingest-rental-landlord-leads` matches
  actual HotPads output (check `raw_data` on the first ingested lead).
- Point the alert email at a distribution list instead of one inbox once
  more than one agent needs to see new leads.

## Known issue found while building this (unrelated, pre-existing)

`ARCHIVED – S2: Apify Scraper Enrichment (Zillow + Realtor.com)` (scenario
id 4744373) has a Supabase bearer token hardcoded directly in an HTTP
module header instead of referencing `{{env.MAKE_WEBHOOK_SECRET}}` (which a
sibling module in the *same* blueprint correctly uses). It's an archived/
inactive scenario, but the token is live-looking and sitting in blueprint
JSON. Worth rotating and deleting the archived scenario rather than leaving
a credential at rest with no operational purpose.
