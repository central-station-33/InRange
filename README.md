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
| 4 | `enrich-ai` | Daily 6 AM ET | Claude AI investment memo for Tier 1–2 properties |
| 5 | `notify-subscribers` | Daily 7 AM ET | Delivers leads via webhook / Make.com routing |

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
    20260915120000_ai_lead_enrichment.sql          # Lead/evidence schema (blueprint Phase 0)
    20260917200000_enrichment_queue_and_review.sql # Queue/review/outreach schema (blueprint Phase 1)
  functions/
    _shared/
      types.ts                      # Shared TypeScript types
      supabase-client.ts            # Supabase client + auth helpers
      scoring.ts                    # Scoring algorithm
      jobs.ts                       # enrichment_jobs queue helpers (Phase 1)
      gemini-client.ts               # Gemini REST client (Phase 1, not live-tested)
      claude-client.ts               # Claude JSON-response client (Phase 1)
      prompts/                       # Gemini/Claude prompt contracts (Phase 1)
    ingest-nyc/index.ts             # NYC Open Data ingestion
    ingest-nj/index.ts              # NJ NJOGIS + sheriff sale ingestion
    score-properties/index.ts       # Composite scoring engine
    enrich-ai/index.ts              # Claude API enrichment
    notify-subscribers/index.ts     # Subscriber notification delivery
    ingest-raw-record/                 # Phase 1: generic raw-record ingestion
    enrichment-queue/                  # Phase 1: enqueue a job
    enrichment-process/                # Phase 1: job dispatcher
    enrichment-retry/                  # Phase 1: manual job retry
    enrichment-gemini-normalize/       # Phase 1: Gemini extraction pass
    enrichment-gemini-brief/           # Phase 1: Gemini synthesis pass
    enrichment-claude-review/          # Phase 1: Claude second-pass review
    lead-intelligence/                 # Phase 1: GET lead intelligence panel data
    lead-request-review/               # Phase 1: request lead-level review
    lead-approve-ai-suggestion/        # Phase 1: approve an evidence row
    lead-reject-ai-suggestion/         # Phase 1: reject an evidence row
    leads-feedback/                    # Phase 1: agent feedback capture
    outreach-draft/                    # Phase 1: template-based draft (no LLM call)
    outreach-approve/                  # Phase 1: mark a draft approved
    outreach-send/                     # Phase 1: permanently refuses — see blueprint §11
docs/
  make-scenarios.md                 # Make.com scenario blueprints
  data-sources.md                   # Data source reference + field mapping
  ai-lead-enrichment-blueprint.md   # JRA CRM lead-enrichment architecture proposal
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
ANTHROPIC_API_KEY       = sk-ant-...
NYC_OPEN_DATA_APP_TOKEN = (optional, raises rate limits)
MAKE_WEBHOOK_SECRET     = (shared secret for Make.com auth)
MAKE_NOTIFY_WEBHOOK     = https://hook.us2.make.com/...
```

### 2. Make.com

See `docs/make-scenarios.md` for full scenario blueprints.

The pipeline has five scenarios that chain in order:
1. Ingest NYC → 2. Ingest NJ → 3. Score → 4. AI Enrich → 5. Notify

### 3. Retool

Connect Retool to Supabase using the built-in Supabase resource connector.
Key views to expose in Retool tables:

| Retool Table | Supabase View |
|---|---|
| Pipeline Summary | `pipeline_summary` |
| All Leads | `leads_dashboard` |
| Tier 1 Leads | `leads_dashboard` (filter: tier = 1) |
| Ingestion Logs | `ingestion_runs` |

## AI Lead Enrichment (JRA CRM) — Blueprint

`docs/ai-lead-enrichment-blueprint.md` specifies a proposed extension of this
pipeline into a source-backed, agent-facing lead system for Jet Realty
Advisors, covering pre-foreclosure/REO/absentee/LLC/probate/expired-listing
categories, a Gemini-primary/Claude-second-pass enrichment flow, and an
evidence ledger so AI-derived fields are never presented as verified facts.

Phase 0 (additive schema only — `lead_records`, `lead_evidence`,
`ai_enrichment_runs`, `lead_contacts`, `compliance_playbook`,
`lead_workbench` view) ships in
`supabase/migrations/20260915120000_ai_lead_enrichment.sql`. Phase 1 (the
enrichment job queue, human-review/outreach schema, and 15 new Edge
Functions implementing the JRA-specified API) ships in
`supabase/migrations/20260917200000_enrichment_queue_and_review.sql` and
`supabase/functions/{enrichment-*,lead-*,outreach-*,leads-feedback,ingest-raw-record}/`.
Neither phase changes any existing table, function, or Make.com scenario.

**Phase 1 is code-complete but the Gemini/Claude API calls are not
live-tested** — no `GEMINI_API_KEY` is provisioned anywhere (still
reserved-but-unset in `.env.example`), and this environment has no Deno
runtime to run either function against a real key. `outreach-send` is a
permanent refusal, not a stub — see blueprint §11 for why. SkipData wiring
and the CRM UI (Phase 3/4) still require sign-off — see "Open decisions"
in the blueprint doc before building them.

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
