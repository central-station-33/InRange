# Make.com Scenarios

Rewritten 2026-09-17. **This is an inventory, not a blueprint reference** —
it lists what's currently active in the `us2.make.com` team (org "My
Organization", team "My Team") by name and inferred purpose, pulled live via
the Make API. It does not reproduce each scenario's internal module
configuration (HTTP URLs, routers, filters) because that detail changes
independently of this repo and duplicating it here is exactly how the
previous version of this file went stale — it described a clean 5-scenario
`ingest → score → enrich → notify` pipeline that hasn't existed for months.

**If you need exact module-level config for a scenario, read it from
Make.com directly** (or via the Make MCP tools' `scenarios_get`/
`scenarios_interface`) rather than trusting a description here.

## Active scenarios (18, as of 2026-09-17)

All currently active scenarios are set to **on-demand** scheduling (triggered
by webhook or by another scenario, not cron) — nothing here is confirmed to
run on a fixed daily schedule anymore.

| Scenario | Likely calls into (by name match) |
|---|---|
| InRange – Scenario 1: Property Ingest Gateway | `ingest-raw-properties`, `process-raw-properties` |
| InRange – S1b: NYC 311 HPD Complaints Ingest | `ingest-nyc` |
| InRange – S1c: NYC HPD Violations Ingest | `ingest-nyc` |
| InRange – S1d: NYC Tax Liens Ingest | *(see `docs/data-sources.md` — no tax-lien dataset currently found in `ingest-nyc`; verify what this scenario actually posts)* |
| InRange – S1k: NJ County Distress Ingest (Bergen/Hudson/Essex/Morris/Sussex) | `ingest-nj` |
| InRange – NYC Ingest (HPD + Evictions) | `ingest-nyc` |
| InRange – Process Raw Properties | `process-raw-properties` |
| InRange – ISA S2: AI Enrich + Notify ISA (All Segments) | `enrich-leads`, `notify-isa` |
| InRange – ISA S4: Cash Investor Lead Ingest (NYC ACRIS Deed Transfers) | `ingest-acris-investors` |
| InRange – ISA S6: Motivated Seller Bridge (Properties → ISA Leads) | `bridge-homeowner-leads` or `ingest-leads` |
| InRange – ISA S7: Developer Leads (NYC DOB + NJ Building Permits) | `ingest-nj-developer-leads` |
| InRange – ISA S10: Assign + Enrich Pipeline (Daily Orchestrator) | `assign-leads`, `enrich-leads` |
| InRange – ISA S19: High-Value Homeowner Bridge (Properties → ISA Leads) | `bridge-homeowner-leads` |
| InRange – S16: Inbound Lead Fast Response (Website/SMS/Email) | `respond-lead` |
| InRange – S17: Zillow/Realtor.com Email Lead Parser | `process-inbound-email` |
| InRange – S18: Twilio Inbound SMS Handler | `respond-lead`, `log-touch` |
| InRange – Skip Trace (DataSkip, manual review) | `skip-trace-leads` |
| ISA Notify Receiver | `notify-isa` (webhook receiver side) |

⚠️ Naming is inconsistent across scenarios (e.g. two different unrelated
scenarios have both been called "ISA S19" at different points — one active,
one archived and renamed "S19 – Follow-up Cadence"). Don't assume the number
in a scenario name is a reliable version/sequence indicator.

## Inactive / archived (not deleted, just disabled)

There are **~40 additional scenarios** in the same Make team that are
disabled (`isActive: false`), including:

- Earlier iterations superseded by the active list above (e.g. `ARCHIVED –
  S1h: NYC HPD Code Violations Ingest (superseded by ingest-nyc edge
  function)` — the archive note is Make's own, not mine)
- Per-segment ISA lead-gen scenarios not currently running: athlete,
  film/TV, NJ athletes, divorce/estate, empty-nester, first-time-buyer
  (NYC + NJ), NJ film/TV production
- `InRange – S23: AI Social Content Drafting (Gemini)` — the only place
  "Gemini" appears anywhere in this project's tooling. No edge function
  references a Gemini API key, so if this scenario calls Gemini, it does so
  directly from within Make.com, not through this repo's code. **Do not
  assume Gemini is part of the lead-enrichment pipeline** based on the
  mega-spec's dual-model design — nothing currently deployed does that.
- `InRange – Lead Intake (replaces Retool workflow)` / `InRange – Re-Score
  Callback (replaces Retool workflow)` — both inactive, but their names
  confirm Retool was already being phased out before this rewrite (see
  README: the dashboard is now meant to be `nextjs-inrange` on Vercel).
- A handful of `InRange – Scenario N (Agent M)` entries (Identity
  Resolution, Distress Signal Monitor, Lead Scoring Engine, Outreach
  Drafting/Send, Feedback Loop) — all inactive. If these describe an
  earlier agent-based design, it wasn't carried forward into what's active
  today.

## Other Make projects sharing this team

The same `us2.make.com` team also runs unrelated scenarios prefixed `Silent
Legacy –` and `JRA –`, plus several `ZZ Temp –` / `ZZ Debug –` diagnostic
scenarios. None of these are InRange leads/property scenarios — don't assume
a scenario belongs to this project just because it's in the same team.

## What changed from the previous version of this doc

The old version described `ingest-nyc → ingest-nj → score-properties →
enrich-ai → notify-subscribers` as five daily-scheduled scenarios calling
edge functions that no longer exist under those names. That pipeline is
gone. If you're looking for where NYC/NJ ingestion, scoring, or enrichment
actually happen now, start from the edge function names in the table above
and the actual function source in `supabase/functions/`, not from scenario
step-by-step descriptions — those go stale the fastest.
