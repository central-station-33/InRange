# InRange — Investor Lead Generator

Finds, scores, and delivers distressed real estate leads in **New York** and **New Jersey**
using only free/open data sources and the existing InRange infrastructure stack.

## Architecture

```
Make.com Scenarios (us2.make.com)
  │  scheduled triggers + orchestration
  ▼
Supabase Edge Functions (Deno/TypeScript)
  │  ingest → score → enrich → notify
  ▼
Supabase PostgreSQL
  │  properties, scores, subscribers, notifications
  ▼
Retool Dashboard
     live tables, filters, lead management
```

## Pipeline Steps

| Step | Function | Trigger | Description |
|---|---|---|---|
| 1 | `ingest-nyc` | Daily 3 AM ET | Fetches NYC tax liens, HPD violations, ACRIS foreclosures |
| 2 | `ingest-nj` | Daily 3:30 AM ET | Fetches NJ MOD-IV delinquencies + Make.com sheriff sale rows |
| 3 | `score-properties` | After each ingest | Composite 0–100 score, Tier 1–4 classification |
| 4 | `enrich-ai` | Daily 6 AM ET | Gemini first-pass memo for Tier 1–2 properties; Claude only on escalation |
| 5 | `notify-subscribers` | Daily 7 AM ET | Checks campaign eligibility + consent/DNC, **queues** notifications for human approval |
| 6 | `approve-notification` | Human-triggered | The only function that actually sends — requires a human agent identifier |
| 7 | `process-opt-out` | Inbound STOP/unsubscribe | Records a contact's own opt-out (consent/DNC), never AI-initiated |

AI-driven enrichment and notification delivery are governed by two policies:
`docs/model-routing.md` (Gemini-first, Claude-on-escalation) and
`docs/outreach-controls.md` (no autonomous sends, consent/DNC checks, human
approval, activity logging). Both are enforced in code, not just documented
— see those files for the implementation mapping.

## Scoring Model

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
- **Tier 4** — 0–19 pts (low signal, visible in Retool only)

## Repository Structure

```
supabase/
  config.toml                       # Supabase CLI config
  migrations/
    20240101000000_initial_schema.sql        # Tables + RLS + indexes
    20240101000001_views_and_functions.sql   # Views + SQL helpers
  functions/
    _shared/
      types.ts                      # Shared TypeScript types
      supabase-client.ts            # Supabase client + auth helpers
      scoring.ts                    # Scoring algorithm
    ingest-nyc/index.ts             # NYC Open Data ingestion
    ingest-nj/index.ts              # NJ NJOGIS + sheriff sale ingestion
    score-properties/index.ts       # Composite scoring engine
    enrich-ai/index.ts              # Gemini-first / Claude-escalation enrichment
    notify-subscribers/index.ts     # Eligibility + consent/DNC checks, queues for approval
    approve-notification/index.ts   # Human-gated send (the only function that dispatches)
    process-opt-out/index.ts        # Records a contact's own opt-out signal
docs/
  make-scenarios.md                 # Make.com scenario blueprints
  data-sources.md                   # Data source reference + field mapping
  model-routing.md                  # Gemini/Claude routing policy + implementation
  outreach-controls.md              # Consent/DNC/approval policy + implementation
.env.example                        # Required environment variables
```

## Setup

### 1. Supabase

```bash
npm install -g supabase
supabase link --project-ref <your-project-ref>
supabase db push          # applies migrations
supabase functions deploy # deploys all edge functions
```

Set Edge Function secrets in Supabase Dashboard → Project → Edge Functions → Secrets:

```
GEMINI_API_KEY                          = (required — primary enrichment model)
ANTHROPIC_API_KEY                       = sk-ant-... (required — escalation only)
CLAUDE_ESCALATION_DEAL_VALUE_THRESHOLD  = 400000 (optional)
NYC_OPEN_DATA_APP_TOKEN                 = (optional, raises rate limits)
MAKE_WEBHOOK_SECRET                     = (shared secret for Make.com auth)
MAKE_NOTIFY_WEBHOOK                     = https://hook.us2.make.com/...
```

### 2. Make.com

See `docs/make-scenarios.md` for full scenario blueprints.

The pipeline has five scenarios that chain in order:
1. Ingest NYC → 2. Ingest NJ → 3. Score → 4. AI Enrich → 5. Notify

### 3. Retool

Connect Retool to Supabase using the built-in Supabase resource connector.
Key views to expose in Retool tables:

| Retool Table | Supabase View / Table |
|---|---|
| Pipeline Summary | `pipeline_summary` |
| All Leads | `leads_dashboard` |
| Tier 1 Leads | `leads_dashboard` (filter: tier = 1) |
| Ingestion Logs | `ingestion_runs` |
| Approval Queue (human agents act here) | `notifications` (filter: status = 'pending_approval') |
| Outreach Audit Log | `activity_log` |

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
