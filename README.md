# InRange — Lead Generation Platform for Jet Realty Advisors

InRange is the internal operating system for Jet Realty Advisors' (JRA) real estate
business in New York and New Jersey: one shared system of record across three modules,
so a single contact can move between them (e.g. a renter later becomes a buyer) without
a duplicate record.

**InRange is the internal name only.** Nothing under `residential_sale` or
`rental_leasing` should be shown to the public as "InRange" — those modules are
consumer-facing under the **Jet Realty Advisors** brand. `distressed_investor` remains
InRange-branded (it's a wholesale/acquisitions channel, not a consumer-facing brokerage
touchpoint).

> **Status note:** this README describes the schema and functions as of the last
> migration applied through this repo. The live Supabase project has historically
> accumulated schema and Edge Function changes made directly against it (outside git) —
> see "Known gaps" below before assuming this file is exhaustive.

## The three modules

| Module | `isa_leads.module` | Who | Status |
|---|---|---|---|
| **Distressed Investor** | `distressed_investor` | Off-market acquisition targets: tax liens, foreclosures, motivated sellers | Live — the original build |
| **Residential Sale** | `residential_sale` | Buyers and sellers of single/multifamily homes (first-time buyers, relocating athletes, homeowners considering a listing, etc.) | Live — carries the platform's existing buyer/seller lead flow |
| **Rental Leasing** | `rental_leasing` | Renters, landlords needing tenant placement/leasing representation, and rental referral partners | New — schema in place, no inventory or public intake yet |

All three share:
- **`isa_leads`** — the master lead/contact row for every module. `segment` is a
  marketing-persona tag (athlete, expat_relocation, divorce, renter, ...); `module` and
  `lead_role` are the actual pipeline classifiers used for routing and dashboards.
  Dedup is by phone/email (unique partial indexes, scoped to non-dead/non-closed rows),
  matching what `respond-lead` already does in application code.
- **`team_agents`** / **`agent_routing_rules`** — the agent roster and segment/market-based
  routing rules.
- **`lead_touches`** — every contact attempt, any channel.
- **`lead_tasks`** — the agent's "next best action" queue.
- **`lead_source_events`** — granular UTM/campaign/QR/referral-partner attribution per touch.
- **`relocation_partners`** — referral partners (relocation companies, corporate HR,
  hospitals, universities, attorneys, realtors) with commission-split terms.
- **`content_queue`** + **`automation_settings`** — the social/blog content pipeline,
  with a human-approval gate before anything publishes.

Module-specific tables:
- `rental_inquiries`, `landlord_leads`, `rental_units`, `rental_matches`, `tours`,
  `rental_applications` — Rental Leasing only.

Module-scoped dashboard views (`security_invoker`, so they respect the querying user's
RLS): `distressed_investor_pipeline`, `residential_sale_pipeline`,
`rental_leasing_pipeline`, `landlord_leasing_pipeline`, `leads_needing_module_triage`
(leads whose module couldn't be inferred automatically and need one-time manual triage).

## Internal UI

**There is no Retool dashboard — it was removed as unreliable.** There is currently
**no replacement UI either.** Until one is built, internal access to the tables/views
above is via the Supabase Studio table/SQL editor. The `nextjs-inrange` repo
(`central-station-33/nextjs-inrange`) is an unstarted Next.js scaffold intended to
become the real app; building it out is a separate, large piece of work, not yet done.

## Inbound lead pipeline (all three modules)

```
Web form / SMS / email / portal
  │
  ▼
Make.com webhook (e.g. "S16: Inbound Lead Fast Response")
  │
  ▼
respond-lead (Edge Function)
  │  dedupe by phone/email → find-or-create isa_leads row
  │  brand-aware (module → JRA or InRange) Claude-drafted response
  │  Twilio SMS only if sms_consent on file or the lead texted us first —
  │    otherwise creates a lead_task for manual outreach
  ▼
lead_touches, isa_leads.outreach_status = 'attempting'
  │
  ▼
notify-isa → agent_routing_rules → assigned_agent_id
```

`respond-lead` accepts `module` and `lead_role` in its payload so new intake sources
(the future JRA rental/landlord forms, for instance) can classify a lead correctly at
creation instead of relying on the segment-based backfill heuristic.

## Compliance

- `isa_leads.sms_consent` / `marketing_consent` / `consent_source` /
  `consent_captured_at` / `opted_out_at` / `opted_out_channels` track consent and
  do-not-contact status per lead. Nothing sends an unsolicited SMS without
  `sms_consent = true` on file (or the lead having texted in first).
- AI-drafted messages are explicitly instructed never to reference protected
  characteristics, schools, crime, or neighborhood demographics (fair housing).
- `rental_units` is the only source of truth for listing facts; AI must never
  state a rent, availability date, fee, or amenity that isn't in that table.

## Known gaps (read before assuming something works)

- **This repo lags production for anything not touched by a recent migration or
  listed above.** The live project has ~30 applied migrations and ~30 deployed Edge
  Functions; only the ones referenced above (and the original investor-pipeline
  functions under `supabase/functions/`) are tracked in git. Pulling the rest into
  version control is unstarted work.
- **No internal app UI** (see above).
- **No public JRA intake pages yet.** `respond-lead`'s webhook contract is ready to
  receive rental/landlord leads; no public form/page exists to call it. The actual
  public site to build against (`jetreadvisors.com` vs. an existing WordPress
  property) is still unresolved.
- **`rental_units` has zero rows.** No rental inventory has been entered anywhere in
  the system yet.
- A handful of `isa_leads` rows predating the module/lead_role split had ambiguous
  segments (`film_tv`, `expat_relocation`, `general_inquiry`) that were **not**
  auto-classified — query `leads_needing_module_triage` and assign manually.

## Legacy: original investor-pipeline docs

The original standalone scoring pipeline (tax liens, HPD violations, ACRIS
foreclosures) still runs as described below; it now corresponds to the
`distressed_investor` module.

### Pipeline Steps

| Step | Function | Trigger | Description |
|---|---|---|---|
| 1 | `ingest-nyc` | Daily 3 AM ET | Fetches NYC tax liens, HPD violations, ACRIS foreclosures |
| 2 | `ingest-nj` | Daily 3:30 AM ET | Fetches NJ MOD-IV delinquencies + Make.com sheriff sale rows |
| 3 | `score-properties` | After each ingest | Composite 0–100 score, Tier 1–4 classification |
| 4 | `enrich-ai` | Daily 6 AM ET | Claude AI investment memo for Tier 1–2 properties |
| 5 | `notify-subscribers` | Daily 7 AM ET | Delivers leads via webhook / Make.com routing |

### Scoring Model

| Signal | Points |
|---|---|
| Active foreclosure / lis pendens | 35 |
| Sheriff sale scheduled | 35 |
| Tax lien sold | 25 |
| Probate / estate | 22 |
| Tax delinquent (>1 yr) | 18 |
| HPD / code violations | 12 |
| Vacant / abandoned | 10 |
| Multi-signal bonus (3+ flags) | +10–15 |

**Tiers:**
- **Tier 1** — 70–100 pts (hottest leads, AI-enriched, immediate notification)
- **Tier 2** — 45–69 pts (warm leads, AI-enriched)
- **Tier 3** — 20–44 pts (cool leads, no AI enrichment by default)
- **Tier 4** — 0–19 pts (low signal)

## Repository Structure

```
supabase/
  config.toml
  migrations/
    20240101000000_initial_schema.sql          # original investor-pipeline tables
    20240101000001_views_and_functions.sql
    20260917120000_leasing_module_and_taxonomy.sql  # module/lead_role split + Rental Leasing module
  functions/
    _shared/                          # shared types/client/scoring for the investor pipeline
    ingest-nyc/, ingest-nj/, score-properties/, enrich-ai/, notify-subscribers/
    respond-lead/                     # shared inbound-lead intake, all three modules
docs/
  make-scenarios.md
  data-sources.md
.env.example
```

## Setup

### 1. Supabase

```bash
npm install -g supabase
supabase link --project-ref <your-project-ref>
supabase db push          # applies migrations
supabase functions deploy # deploys all edge functions
```

Required Edge Function secrets (Supabase Dashboard → Project → Edge Functions → Secrets):

```
ANTHROPIC_API_KEY       = sk-ant-...
GEMINI_API_KEY          = (leasing-module AI qualification/matching — not yet provisioned)
NYC_OPEN_DATA_APP_TOKEN = (optional, raises rate limits)
MAKE_WEBHOOK_SECRET     = (shared secret for Make.com auth — rotate this; a prior value
                           was found hardcoded in a Make scenario blueprint instead of
                           templated, and should be treated as compromised)
MAKE_NOTIFY_WEBHOOK     = https://hook.us2.make.com/...
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER
```

### 2. Make.com

See `docs/make-scenarios.md` for the original five-scenario investor pipeline. The
live Make team has additional scenarios (inbound lead routing, Twilio SMS handling,
portal email parsing, ISA enrichment/notification) not documented in this repo yet.

## Data Sources

- **NYC:** NYC Open Data — tax liens, HPD complaints, ACRIS lis pendens
- **NJ:** NJOGIS — MOD-IV assessments; county sheriff sites for sales

See `docs/data-sources.md` for full reference.

## Local Development

```bash
supabase start             # starts local Supabase stack
supabase functions serve   # serves all edge functions locally

# Test an edge function
curl -X POST http://localhost:54321/functions/v1/ingest-nyc \
  -H "Content-Type: application/json" \
  -d '{}'
```
