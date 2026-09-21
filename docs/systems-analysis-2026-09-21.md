# InRange Systems Analysis — 2026-09-21

Front-to-back review of the live system: this repository, the 14 open pull
requests, the Supabase project `omzugrtgwsjypekuzgtn` (schema, RLS, edge
functions, logs, advisors), the Make.com team (66 scenarios, 47 webhooks,
execution history), and the separate `nextjs-inrange` repository.

Every finding carries a confidence level. **Verified** means observed directly
in live data, logs, or source. **Likely** means inferred from code reading
with no live confirmation. **Unverified** means it could not be checked from
this session.

---

## 1. Bottom line

The pipeline ingests, but nothing downstream of ingestion works today.

| Stage | Status | Evidence |
|---|---|---|
| Property ingestion (NYC HPD, evictions, NJ MOD-IV) | Working, last run 2026-09-14 | 879 raw rows, 915 properties, 0 unprocessed |
| ISA lead ingestion (ACRIS divorce, empty-nester, developer) | Working, but producing duplicates | 534 leads created today, only 149 distinct addresses across the table |
| AI enrichment, Anthropic path (`enrich-leads`, `enrich-pending`) | **Broken** | Every call returns `Anthropic 401` (50 of 50 leads on the 16:17 UTC run). Key is set (108 chars) but rejected. On 2026-09-15 the error was "credit balance too low". |
| AI enrichment, Gemini path (S2 via `list-pending-enrichment` → `write-enrichment`) | **Broken** | Make runs today: `[402] prepayment credits depleted` at 14:54, `[404] gemini-2.5-flash no longer available` at 15:56, then repeated `[503]`. Zero leads carry a Gemini model tag. |
| Lead assignment (`assign-leads`) | Working for 5 of 8 active segments | 195 leads assigned, all to the one agent. `divorce`, `empty_nester`, `homeowner`, `landlord` have no routing rule, so 432 leads sit unassigned. |
| ISA notification (`notify-isa` → Make receiver) | Idle, not proven | Every run today ends `no_leads_matched` because no lead has both `ai_summary` and `outreach_status='new'`. The receiver scenario only logs a touch; it sends no SMS or email. |
| Inbound lead fast response (S16 → `respond-lead`) | **Broken** | Last two real inbound events (2026-09-17) failed with `BundleValidationError` before reaching the edge function. |
| Inbound SMS (S18) and email parser (S17) | Never executed | Both active since 2026-09-06 with zero runs. |
| Follow-up cadence (`follow-up-cadence`) | Not scheduled | The only scenario that calls it (ISA S19) is inactive and marked invalid. |
| Skip trace (DataSkip) | Wired, spend gated | 2 confirmations issued, 2 leads matched, 18 no-match. Two-step approval gate works as designed. |
| Dashboard / login | **Does not exist in production** | See section 6. |

Confidence: Verified for every row except cadence scheduling (Likely; the
scenario is inactive but a manual trigger path was not ruled out).

---

## 2. Redundancy and drift

### 2.1 Three different systems are described in three places

- **`main` branch** (8 commits) describes a 5-function pipeline
  (`ingest-nyc → ingest-nj → score-properties → enrich-ai → notify-subscribers`)
  with tables `property_scores`, `subscribers`, `notifications`,
  `ingestion_runs`. None of those four tables exist in production, and three
  of the five functions (`score-properties`, `enrich-ai`, `notify-subscribers`)
  are not deployed. **Verified.**
- **The three `InRange-*.json` blueprints at the repo root** call
  `ingest-raw-properties`, `process-raw-properties`, `enrich-pending`,
  `fetch-properties`, `burnt-out-landlord-scan`. Those exist in production but
  the blueprints are not what runs in Make today (they use placeholder
  service-role keys and a 4-hour schedule that no active scenario has).
  **Verified.**
- **Production** runs 43 deployed edge functions and 18 active Make scenarios.
  PR #13 (`claude/lead-intelligence-system-0gc8wh`) reconstructs this from the
  live project, but it is already stale: 7 functions deployed after it
  (`ingest-acris-life-event`, `ingest-acris-empty-nester`, `invite-agent`,
  `invite-agent-form`, `list-pending-enrichment`, `write-enrichment`,
  `temp-force-password-reset`) and 3 migrations
  (`add_landlord_segment_and_unclaimed_leads_view`,
  `fix_unclaimed_leads_security_definer`, the live `isa_leads_sms_opt_out`)
  are missing from it. **Verified.**

Nothing has been merged to `main` since May. 14 PRs are open, several of
which conflict with each other conceptually (PR #2 wires a Retool dashboard;
PR #15, closed, removes Retool; PR #4 adds a Next.js dashboard inside this
repo; the README in PR #13 says the dashboard lives in a different repo).

### 2.2 Duplicate and dead edge functions

| Function | Status | Note |
|---|---|---|
| `health` and `health-check` | Two functions, different purposes, same intent | `health` is a JWT-gated stub; `health-check` is the real Slack alerter and nothing calls it. |
| `score-property` and `process-raw-properties` | Both score and upsert properties | Same shared scoring module, two entry points, two copies of `_shared/`. |
| `ingest-raw-properties` | Live, `verify_jwt=true`, **no Make-secret check** | Anyone holding the anon key can insert arbitrary rows into `raw_properties`. **Verified in source.** |
| `enrich-property`, `secret-diag`, `test-api-keys`, `temp-force-password-reset` | Retired 410 stubs still deployed | Harmless but clutter. |
| `nyc-diag`, `coop-diag`, `rest-diag`, `probe-acris-lis-pendens`, `clever-handler` | Diagnostic leftovers | Four `ZZ Temp` Make scenarios that call them are still **active**. |
| `_shared/` directories | Copied into 15 function folders | Each function carries its own copy of `supabase-client.ts`, `scoring.ts`, `cors.ts`. Fixes do not propagate. |

### 2.3 Make.com

- 66 scenarios in the team; 18 active for InRange; 22 explicitly archived or
  superseded but not deleted; 4 `ZZ Temp` diagnostics still active; 8
  scenarios belong to other projects (Silent Legacy, JRA) in the same team.
- 47 webhooks, of which 21 are flagged `gone` (their scenario was deleted) but
  still enabled and still accepting POSTs. **Verified.**
- Scenario 1 (Property Ingest Gateway, active) POSTs to
  `/functions/v1/score-properties`, which is not deployed, with
  `handleErrors:false`, so it reports success while doing nothing. It also
  uses a **different, older shared secret** than every other scenario, so it
  would 401 even if the path were right. **Verified.**
- Two secrets, one anon JWT, and one publishable key are pasted in plaintext
  into module headers across at least 6 scenarios (S2, S10, S16, Notify
  Receiver, Scenario 1). The S2 description says this was done because
  `{{env.MAKE_WEBHOOK_SECRET}}` "was not resolving". Blueprint exports (like
  the three JSON files in this repo) will carry those secrets. **Verified.**

---

## 3. Vulnerable areas

### 3.1 Security (ordered by severity)

1. **`ingest-raw-properties` accepts writes with only the public anon key.**
   No `x-make-secret` check. Any browser bundle holding the anon key can
   inject properties. **Verified.**
2. **SQL built by string interpolation in Make Scenario 1.** The
   `postgres:Query` modules concatenate webhook fields into `INSERT`/`UPDATE`
   statements. `parcel_id`, `address`, `city`, `county` get single-quote
   escaping; `state`, `zip`, `property_type`, `source` do not. The webhook
   has API-key auth, so exploitation requires that key, but the pattern is a
   SQL-injection hole. **Verified.**
3. **`properties` RLS is `FOR ALL TO authenticated USING (true)`.** Any
   logged-in agent can update or delete every property, including owner PII.
   Same for `landlord_leads`, `rental_*`, `tours`, `content_queue`,
   `lead_tasks`, `lead_source_events`, `contact_activities`, `outreach`.
   The broker/agent split only covers `isa_leads`, `deals`, `lead_touches`,
   `team_agents`, `agent_routing_rules`, `relocation_partners`. **Verified
   from `pg_policies`.**
4. **Leaked-password protection is off** in Supabase Auth (advisor warning).
   **Verified.**
5. **`current_team_agent_id()` and `is_broker()` are SECURITY DEFINER and
   executable by `anon`.** They return null/false for anon, so exposure is
   low, but the advisor flags it and `EXECUTE` should be revoked. **Verified.**
6. **`pg_net` is installed in `public`.** Advisor warning. A migration named
   `pg_net_recreate_in_net_schema_2` exists, but the extension is still in
   `public`. **Verified.**
7. **Secrets in Make blueprints** (section 2.3). Rotate the shared secret and
   move it back to a Make environment variable once the resolution issue is
   understood.
8. **`fetch-properties` and `invite-agent` rely on `verify_jwt` plus an
   in-function `auth.getUser()` check.** That is correct. But
   `assign-leads`, `notify-isa`, `ingest-leads` use `if (MAKE_SECRET && …)`,
   which silently disables auth if the secret env var is ever unset. Most
   newer functions fail closed with a 500; these three fail open. **Verified
   in source.**
9. **Git history is clean of API keys.** One branch commits an anon JWT
   (`ANON = "eyJ…"`) in a diagnostic function; the anon key is public by
   design, so this is low risk. No Anthropic, Twilio, or service-role keys
   found in any branch. **Verified.**

### 3.2 Compliance

- **`sms_consent` is false on every lead.** 627 rows, zero with SMS consent,
  zero with `marketing_consent`. `respond-lead` and `follow-up-cadence` send
  Twilio SMS to any lead with a phone number and `sms_opt_out=false`. The
  opt-out logic is careful, but there is no opt-in gate at all. Cold SMS to
  skip-traced homeowners without prior consent is a TCPA exposure. **Verified
  in data and source.**
- **No DNC scrub** before calling. `skip-trace-leads` drops DNC-flagged
  numbers from DataSkip, which is the only DNC handling anywhere.
- Property PII (owner name, phone, email, mailing address) is readable by
  every authenticated user with no audit trail.

### 3.3 Operational fragility

- **No scheduling.** All 18 active scenarios are `on-demand`. The
  "Daily Orchestrator" (S10) has no schedule. The last automatic property
  ingestion was 2026-09-14. Every run this month was triggered by hand.
  **Verified.**
- **Make discards edge-function response bodies**, so every function writes
  a diagnostic row into `raw_properties` with `source='diagnostic'`. That
  works, but it means the only observability is 12 JSON blobs in a data
  table. `health-check` exists and would alert to Slack, and nothing calls
  it.
- **`enrich-leads` runs sequentially with a 90-second Make timeout.** At
  roughly 2 seconds per Anthropic call, a batch of 50 will time out (the
  2026-09-08 run did: "exceeded the allotted timeout" after 280 s). When that
  happens Make records an error while the function keeps running and
  writing.
- **Socrata calls run without an app token.** The README on `main` says to
  set `NYC_OPEN_DATA_APP_TOKEN`; no live function reads it. Unauthenticated
  Socrata is rate-limited and the ACRIS 3-way join in the new ingest
  functions makes 3 to 5 calls per run.
- **`ingest-nj` does a SELECT-then-INSERT per row** instead of the batched
  `ON CONFLICT` upsert `ingest-nyc` uses. Slow but not wrong.

---

## 4. API and enrichment errors (last 24 hours, plus history)

### 4.1 Anthropic

| When | Function | Error |
|---|---|---|
| 2026-09-15 00:19 | `enrich-pending` | `400 … Your credit balance is too low to access the Anthropic API` |
| 2026-09-19 to now | `enrich-leads` | `Anthropic 401` on every lead, every run (9 runs today) |

The key is present (`anthropic_key_present: true`, 108 chars). A 401 with a
key present means the key was revoked, regenerated, or belongs to an
organization whose access ended. Refilling credits will not fix a 401.
**Verified.** Fix: generate a new key, set it as the `ANTHROPIC_API_KEY`
edge-function secret, re-run one `enrich-leads` call with `limit: 1`.

### 4.2 Gemini (Make module in S2)

| When | Error |
|---|---|
| 14:54 UTC | `[402] Your prepayment credits are depleted` |
| 15:56 UTC | `[404] gemini-2.5-flash is no longer available to new users … use gemini-3.6-flash` |
| 15:55 to 16:00 UTC | `[503] This model is currently experiencing high demand` (5 runs) |

S2 was then edited 8 times between 14:48 and 16:01 and now "succeeds" with
52 operations, but `write-enrichment` returned 422 on 8 of its last 10 calls
and zero `isa_leads` rows carry an `ai_model` value. The success is the
`Ignore` error handler on the Gemini module swallowing every failure.
**Verified.** The S2 module still names `gemini-2.5-flash` in its blueprint.

### 4.3 Supabase edge functions

| Path | Status | Count | Meaning |
|---|---|---|---|
| `write-enrichment` | 422 | 8 | "parse failed: No JSON object in model response" (Gemini returned nothing) |
| `list-pending-enrichment` | 401 | 1 | Secret mismatch during the 14:19 edit |
| `ingest-leads` | 401 | 1 | Same |
| `ingest-acris-empty-nester` | 500 | 1 | Timed out at 100 s on the ACRIS 3-way join; the retry succeeded |
| `ingest-leads` | 200 | 626 | One call per lead from the ACRIS bridge functions |

No 4xx or 5xx on any other function in the window. Edge logs show 520
requests with status 400 on an empty path; these are API-gateway rejections,
most likely PostgREST calls with malformed filters (see 4.4). **Likely.**

### 4.4 Data-integrity bug: lead deduplication is broken

`ingest-leads` deduplicates with a PostgREST filter:

```
.or(`full_name.eq.${identifier},entity_name.eq.${identifier}`)
```

PostgREST uses the comma as the OR separator. 552 of 627 leads have a name
containing a comma (ACRIS returns `LAST, FIRST`), so the filter is parsed as
three clauses, the third malformed, and the lookup fails or returns
nothing. The insert then proceeds. Each ACRIS bridge run (S8 and S9 were run
3 and 4 times today) re-inserted the same leads. Result: 68 addresses appear
2 to 9 times, and the "534 new leads today" figure is closer to 70 unique
people. **Verified** (names with comma: 552; distinct addresses: 149).

Secondary cause: `maybeSingle()` throws when more than one row matches, which
is now guaranteed, so even a fixed filter would fail until the table is
deduplicated. Fix in this order: (1) delete duplicates keeping the earliest
row per `(segment, market, lower(property_address))`; (2) add a unique index
on that key; (3) change the lookup to two `.eq()` queries or a `.or()` with
values wrapped in double quotes; (4) add `source_document_id` and dedupe on
it, which is the actual ACRIS identity.

### 4.5 Assignment and notification

- `agent_routing_rules` has 11 rows covering `athlete`, `investor`,
  `expat_relocation`, `film_tv`, `developer` for NYC and NJ. No rule for
  `divorce`, `empty_nester`, `homeowner`, `landlord`, `renter`,
  `general_inquiry`. The three segments being ingested today therefore
  never get an agent and never appear in an agent's scoped view. **Verified.**
- The Notify Receiver scenario failed 11 times on 2026-09-07 with
  `Validation failed for 7 parameter(s)` (the email/SMS modules that existed
  then). It has since been cut down to a single `log-touch` call. There is
  currently **no delivery channel** for ISA notifications: no SMS, no email,
  no Slack. **Verified from blueprint.**

---

## 5. Data quality snapshot

| Table | Rows | Notes |
|---|---|---|
| `properties` | 915 | 49 Tier 1 pending enrichment since 2026-09-08; 0 complete; 3 quarantined. 592 of 915 have no ARV. |
| `raw_properties` | 879 | All processed. 12 rows are diagnostics. |
| `isa_leads` | 627 | 149 distinct addresses. 2 have phone or email. 42 have an `ai_summary` (all pre-dating the audit columns). 585 have `routing='new'`. |
| `team_agents` | 1 | James Thompson, broker, linked to the only auth user. |
| `lead_touches`, `deals`, `outreach`, `owners`, `notification_log`, `inrange_leads`, `contact_activities` | 0 | Never written. |
| `rental_*`, `landlord_leads`, `tours`, `content_queue`, `automation_settings` | 0 | Leasing module and blog automation tables, unused. |

54 of today's leads have entity-shaped names (LLC, bank as trustee,
condominium) in segments meant for individuals. The `homeowner` skip-trace
path filters these; `divorce` and `empty_nester` do not.

---

## 6. Project status: what is and is not done

### 6.1 Login

**Not built.** There is exactly one Supabase Auth user (`team@joinjra.com`,
last sign-in 2026-09-19), linked as `broker`. The role-based RLS model exists
in the database. What does not exist:

- Any deployed web application that presents a login form. PR #4 contains a
  Next.js login page and middleware, but it is unmerged, was last touched
  2026-08-21, targets Next 14 with `@supabase/ssr` 0.4, and its data layer
  uses the service-role key server-side for every page (bypassing the RLS
  model entirely). It was written before the broker/agent roles existed.
- `invite-agent` (JWT-gated) and `invite-agent-form` (Make-gated) can create
  auth users and `team_agents` rows. Neither has been called
  (`created_at == updated_at`, version 1).
- Password reset flow: `temp-force-password-reset` was a one-off and is now a
  410 stub.

**Confidence: Verified.**

### 6.2 Dashboard

**Not built.** Three candidates were examined:

| Candidate | State |
|---|---|
| `central-station-33/nextjs-inrange` (the repo the PR #13 README points to) | One commit, `create-next-app` scaffold, Next 16.2.4, React 19. No Supabase dependency, no pages beyond the template. Not a dashboard. |
| `dashboard/` in PR #4 (`claude/ai-sales-installer-AExP8`) | Pipeline table, lead detail, log-touch form, analytics page, login. Reads `isa_pipeline` with the service-role key. Unmerged, unbuilt, no `package-lock.json`, pre-dates 20 of the 37 migrations. |
| Retool (PR #2, `main` README) | Superseded per PR #15 and the archived "replaces Retool workflow" scenarios. |

`fetch-properties` contains a comment about "PrivateRoute" and a browser
frontend calling it with a user session. No such frontend exists in either
repository. The Vercel account has projects named `cc-make-retool` and
`make-com-claude-code` under a team this session's token cannot read
(403), so a deployed frontend there cannot be ruled out. **Unverified.**

### 6.3 Other open work (from PR titles and branch contents)

| PR | Scope | State |
|---|---|---|
| #13 | Sync repo with production, broker/agent RLS docs | Closest to mergeable, already 7 functions behind |
| #14 | `enrichment_evidence`, `ai_signals`, `contact_points`, `contact_consent`, `human_reviews` tables | Not in production |
| #16, #17 | Rental-landlord segment, lead-claim mechanism | `claim-lead` and `ingest-rental-landlord-leads` are deployed; the landlord alert scenario is inactive |
| #12 | Outreach controls and Gemini/Claude routing | Gemini routing was implemented differently in S2 |
| #11 | AI lead enrichment blueprint for JRA CRM | Design doc |
| #10 | `CLAUDE.md` workflow rules | Docs only |
| #8 | RLS hardening | Partially applied live (`security_hardening` migrations exist) |
| #9, #6, #3, #7, #2 | BT Capital complaint platform, finance agents, Make error fixes, settings allowlist, Retool wiring | Stale or out of scope |

---

## 7. Recommended order of work

1. **Stop the bleeding on enrichment.** New Anthropic key; pick one Gemini
   model that exists and is funded, or drop the Gemini path. Until one of
   those is done, every downstream stage is idle.
2. **Deduplicate `isa_leads` and fix the `.or()` filter** before running any
   more ACRIS bridges. Add the unique index so it cannot recur.
3. **Add routing rules** for `divorce`, `empty_nester`, `homeowner`, `landlord`
   or the ingested leads are invisible to agents.
4. **Put a real delivery channel back in the Notify Receiver** (email at
   minimum) and fix S16's validation error, or inbound leads are lost.
5. **Add the `x-make-secret` check to `ingest-raw-properties`**, rotate the
   shared secret, and move it to a Make environment variable.
6. **Schedule S10 and the ingest scenarios** so the system runs without a
   person clicking Run.
7. **Merge PR #13, then re-sync** the 7 missing functions and 3 migrations,
   and close the 10 PRs that no longer reflect the system.
8. **Decide where the dashboard lives.** Either build `nextjs-inrange` out
   using the existing role-based RLS with the anon key (not the service-role
   key), or move PR #4's `dashboard/` there and rewrite its data layer.
9. **Consent gate before any outbound SMS.** Require `sms_consent=true` in
   `follow-up-cadence`, and treat inbound-SMS replies as the only implied
   consent.
10. Clean-up: delete the 21 orphaned webhooks, the 4 `ZZ Temp` scenarios,
    the 4 retired 410 functions, and either fix or disable Scenario 1.

---

## Appendix A: Live inventory

**Edge functions (43):** assign-leads, backfill-nj-zip, bridge-homeowner-leads,
burnt-out-landlord-scan, claim-lead, clever-handler, coop-diag, enrich-leads,
enrich-pending, enrich-property (410), estimate-arv-comps, fetch-properties,
follow-up-cadence, health, health-check, ingest-acris-empty-nester,
ingest-acris-investors, ingest-acris-life-event, ingest-leads, ingest-nj,
ingest-nj-developer-leads, ingest-nyc, ingest-raw-properties,
ingest-rental-landlord-leads, invite-agent, invite-agent-form,
list-pending-enrichment, log-touch, notification-status-, notify-isa, nyc-diag,
probe-acris-lis-pendens, process-inbound-email, process-raw-properties,
rescore-properties, respond-lead, rest-diag, score-property, secret-diag (410),
seed-scores, skip-trace-leads, temp-force-password-reset (410), test-api-keys,
write-enrichment.

**Active Make scenarios (18):** Scenario 1 Property Ingest Gateway, S1b NYC 311
HPD, S1c NYC HPD Violations, S1d NYC Tax Liens, S1k NJ County Distress, NYC
Ingest (HPD + Evictions), Process Raw Properties, ISA S2 AI Enrich + Notify,
ISA S4 Cash Investor, ISA S6 Motivated Seller Bridge, ISA S7 Developer Leads,
ISA S8 Divorce + Estate, ISA S9 Empty Nester, ISA S10 Daily Orchestrator, ISA
S19 High-Value Homeowner Bridge, S16 Inbound Fast Response, S17 Zillow/Realtor
Email Parser, S18 Twilio Inbound SMS, Skip Trace (DataSkip), ISA Notify
Receiver. Plus 4 `ZZ Temp` diagnostics still active.

**Tables (26):** properties, raw_properties, isa_leads, team_agents,
agent_routing_rules, relocation_partners, deals, lead_touches, outreach,
outcomes, owners, scores, notification_log, contact_activities, inrange_leads,
skip_trace_confirmations, landlord_leads, rental_inquiries, rental_units,
rental_matches, tours, rental_applications, lead_source_events, lead_tasks,
content_queue, automation_settings. Views (9): agent_commission_summary,
distressed_investor_pipeline, isa_pipeline, landlord_leasing_pipeline,
leads_needing_module_triage, rental_leasing_pipeline,
residential_sale_pipeline, segment_roi, unclaimed_leads.

## Appendix B: What could not be checked

- Vercel deployments and environment variables (token lacks team scope).
- Supabase Auth provider settings beyond the advisor output.
- Twilio account state (number, A2P 10DLC registration, message logs); the
  Twilio tools available here are documentation search only.
- DataSkip account balance.
- Whether any Make environment variables (`MAKE_WEBHOOK_SECRET`,
  `SUPABASE_ANON_KEY`) are actually defined at the organization level.
