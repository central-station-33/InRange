# InRange — Real Estate Lead Intelligence

Finds, scores, and routes distressed-property and buyer/seller leads in New York
and New Jersey. Real estate data comes from public sources; lead intake spans
inbound web/SMS/email, skip-tracing, and segment-specific bridges (motivated
sellers, investors, developers, high-value homeowners, etc.) that feed an ISA
(inside sales agent) pipeline with agent assignment and commission tracking.

> **This file was rewritten on 2026-09-17 after discovering the previous
> version described a 5-function architecture that no longer exists.** See
> "How this repo stayed in sync" below before trusting anything in here for
> more than a few months.

## Architecture

```
Make.com (us2.make.com)                      ~18 active scenarios: scheduled/
  scenario orchestration + inbound webhooks    on-demand ingestion, ISA lead
  (Twilio SMS, email parsing, website forms)   bridges, notifications
        │
        ▼
Supabase Edge Functions (Deno/TypeScript)     34 deployed functions — ingest,
  supabase/functions/<slug>/                  process, score, enrich, notify,
                                               skip-trace, respond, diagnostics
        │
        ▼
Supabase PostgreSQL                           18 tables — properties, owners,
  supabase/migrations/                        isa_leads, deals, outreach,
                                               scores, team_agents, etc.
        │
        ▼
Vercel / Next.js dashboard                    github.com/central-station-33/
  (nextjs-inrange repo, separate from this)    nextjs-inrange — currently an
                                                UNBUILT create-next-app scaffold
```

Supabase project: **InRange** (`omzugrtgwsjypekuzgtn`, us-west-2).

### How this repo stayed in sync (read this before editing infra)

As of 2026-09-17, this repo's `supabase/migrations/` and `supabase/functions/`
were reconstructed by introspecting the **live** Supabase project — 30
migrations and 34 edge functions had been applied/deployed directly against
production over several months with nothing committed here. If you change the
database schema or an edge function, **commit it to this repo in the same
sitting you deploy it.** The single biggest risk to this project isn't a bug —
it's this file (and the schema) going stale again the same way it did before.

The Make.com scenario layer is *not* mirrored in this repo at all. The 3
`InRange-*.json` files at the repo root and `docs/make-scenarios.md` are
partial/manual exports and may not reflect the ~18 currently-active scenarios
in the `us2.make.com` team. Treat Make.com itself as the source of truth for
scenario logic; this repo only tracks the edge functions those scenarios call.

## Access roles: broker / agent

`team_agents` now has `role` (`agent` | `broker`, defaults to `agent`) and
`auth_user_id` (links a row to a Supabase Auth login). RLS on
`isa_leads`/`deals`/`lead_touches`/`team_agents`/`agent_routing_rules`/
`relocation_partners` is scoped accordingly — brokers see everything,
agents see only rows where `assigned_agent_id` matches their own
`team_agents.id`. See `supabase/migrations/20260918030000_broker_agent_roles.sql`
for exactly what's scoped and what's deliberately left broad (shared
property inventory).

**James Thompson (`8d459409-696f-4c17-a78e-2acd28f9ac54`) is linked as
`broker`**, tied to the `team@joinjra.com` Supabase Auth login (his
`team_agents.email` was updated to match — confirmed 2026-09-18). Verified
directly: under that login, `current_team_agent_id()` resolves to his
agent id and `is_broker()` returns `true`.

To add another agent later: create their Supabase Auth login, then

```sql
UPDATE team_agents
SET auth_user_id = '<their auth.users.id>'   -- role defaults to 'agent'; leave it unless they're also a broker
WHERE id = '<their team_agents.id>';
```

Until a `team_agents` row is linked this way, that login resolves to no
agent/broker identity — `current_team_agent_id()`/`is_broker()` return
null/false, so it sees none of the scoped tables. Doesn't affect the live
pipeline either way: every edge function writes with the service-role key,
which bypasses RLS entirely.

## What's actually in the database

18 tables (see `supabase/migrations/20260917120000_baseline_snapshot_from_production.sql`
for full DDL):

| Table | Purpose |
|---|---|
| `properties` | Distressed/off-market property records — scoring, ownership, ARV, quarantine flags |
| `raw_properties` | Pre-normalization landing zone, deduped by `property_hash` |
| `owners` | Resolved property-owner identities (name, contact, mailing address) |
| `scores` | Historical score snapshots per parcel (separate from `properties`' inline score columns) |
| `isa_leads` | Buyer/seller/investor leads by segment (athlete, investor, motivated_seller, divorce, developer, homeowner, renter, etc.) with BANT + AI scoring |
| `lead_touches` | Per-lead contact history, numbered per lead |
| `team_agents` | Licensed agents (brokerages: `highline`, `jet_realty`) with commission-split config |
| `agent_routing_rules` | Segment/market → agent routing priority |
| `relocation_partners` | Referral partners and their fee splits |
| `deals` | Closed deals with a commission-split trigger (`compute_deal_commission()`) that branches on `commission_source` |
| `outreach` | Draft SMS/email/mailer copy, gated `pending_review → approved → sent` |
| `outcomes` | Outcomes recorded against an `outreach` row |
| `contact_activities`, `notification_log` | Legacy-ish contact/notification logging (0 rows as of last check — may be superseded by `lead_touches`/`outreach`) |
| `skip_trace_confirmations` | Token-gated confirmation gate before paid skip-trace spend — `deny_all_client_access` policy, service-role only |
| `inrange_leads` | 0 rows as of last check — unclear if still written to |
| `content_queue`, `automation_settings` | Belong to a separate blog/social auto-publishing feature sharing this database — not part of the lead pipeline |

Three views (`isa_pipeline`, `segment_roi`, `agent_commission_summary`) roll up
the ISA/deals/commission data for reporting.

RLS is enabled on every table. An `ensure_rls` event trigger auto-enables RLS
on any new table created in `public`, so a migration that forgets it won't
leave a table exposed. Current policies are broad (`FOR ALL TO authenticated
USING (true)` on most tables) — there is no per-role (agent/broker/admin)
access model yet.

## Edge Functions

34 functions in `supabase/functions/`. Grouped by what they do (inferred from
name/content — verify against Make.com for exact call sites):

**Ingestion:** `ingest-raw-properties`, `ingest-nyc`, `ingest-nj`,
`ingest-nj-developer-leads`, `ingest-acris-investors`, `ingest-leads`,
`process-raw-properties`, `process-inbound-email`

**Scoring/enrichment:** `score-property`, `rescore-properties`, `seed-scores`,
`enrich-property` (⚠️ **currently deployed with a 0-byte source file** — check
whether anything still calls it), `enrich-leads`, `enrich-pending`,
`burnt-out-landlord-scan`, `estimate-arv-comps`, `backfill-nj-zip`

**ISA lead pipeline:** `assign-leads`, `log-touch`, `respond-lead`,
`follow-up-cadence`, `notify-isa`, `bridge-homeowner-leads`

**Skip trace:** `skip-trace-leads` (gated by the `skip_trace_confirmations`
table — see below)

**Fetch/notify:** `fetch-properties`, `notification-status-`

**Diagnostics (probably safe to ignore / candidates for cleanup):**
`nyc-diag`, `coop-diag`, `secret-diag`, `rest-diag`, `test-api-keys`,
`health`, `health-check`, `probe-acris-lis-pendens`

Every function that writes reads `MAKE_WEBHOOK_SECRET` from an
`x-make-secret` header (or similar) for auth. Most use the
`SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS by design — these functions
are the only path that should ever write to protected tables.

## Environment Variables

Set as Supabase Edge Function secrets (Dashboard → Edge Functions → Secrets),
**not** committed anywhere:

```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   # auto-injected by Supabase
MAKE_WEBHOOK_SECRET                        # shared secret, checked by most functions
ANTHROPIC_API_KEY                          # Claude — enrich-leads, enrich-pending, respond-lead, follow-up-cadence, health
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER   # respond-lead, follow-up-cadence
DATASKIP_API_KEY                           # skip-trace-leads
SIMPLYRETS_API_KEY, SIMPLYRETS_API_SECRET  # estimate-arv-comps (real sold MLS comps)
SLACK_WEBHOOK_URL                          # health-check alerts
MAKE_ISA_WEBHOOK                           # notify-isa → routes into Make.com
```

`NYC_OPEN_DATA_APP_TOKEN` and `MAKE_NOTIFY_WEBHOOK` from earlier versions of
this doc are **no longer referenced by any function** — NYC Open Data calls
are unauthenticated (lower rate limit) and `MAKE_ISA_WEBHOOK` replaced the old
notify webhook.

## Data Sources

See `docs/data-sources.md` — rewritten from the actual dataset URLs in the
live ingestion functions, not from memory.

## Local Development

```bash
supabase start             # starts local Supabase stack
supabase functions serve   # serves all edge functions locally

curl -X POST http://localhost:54321/functions/v1/ingest-nyc \
  -H "Content-Type: application/json" -H "x-make-secret: <secret>" -d '{}'
```

Applying `supabase/migrations/` to a **fresh** project should produce the
current live schema. Every statement in the baseline migration is
`IF NOT EXISTS` / `CREATE OR REPLACE`, so it is also safe to run against the
live project (no-op) if you're ever unsure whether it's already applied.

## Known Gaps (as of 2026-09-17)

- No per-role RLS (agent/broker_manager/admin) — everyone with an
  `authenticated` session can read/write most tables.
- `nextjs-inrange` has no application code yet — there is no dashboard UI to
  extend, only a Next.js scaffold.
- Make.com scenario logic isn't version-controlled anywhere; this repo only
  has the edge functions those scenarios call into.
- `enrich-property` is deployed with an empty source file — status unknown.
- `contact_activities`, `notification_log`, `inrange_leads` have 0 rows and
  unclear write paths — may be dead tables kept for compatibility.
