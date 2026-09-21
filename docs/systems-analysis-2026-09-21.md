# InRange Systems Analysis — 2026-09-21

Front-to-back review of the live system: this repository, the 14 open pull
requests, the Supabase project `omzugrtgwsjypekuzgtn` (schema, RLS, edge
functions, logs, advisors), the Make.com team (66 scenarios, 47 webhooks,
execution history), and the separate `nextjs-inrange` repository.

Every finding carries a confidence level. **Verified** means observed directly
in live data, logs, or source. **Likely** means inferred from code reading
with no live confirmation. **Unverified** means it could not be checked from
this session.

> **Revised 2026-09-21 ~17:40 UTC** after re-checking both enrichment paths.
> The Gemini path changed under us between 16:11 and 16:14: the model was
> moved to `gemini-3.6-flash`, `thinkingConfig` was dropped, and the error
> handler was swapped from `Ignore` to `Resume`. The scenario now completes
> without a Gemini API error, and **still writes nothing** — all 50
> `write-enrichment` calls in the 16:14–16:22 run returned 422. The Anthropic
> path is unchanged, and a replacement key installed at 18:30 UTC returned
> "API key is invalid" from a cold isolate (section 4.1). That re-check also
> surfaced a new structural bug in S2, section 4.6. Superseded numbers are
> marked as such rather than deleted.
>
> **Further update ~18:40 UTC:** the project owner confirms the Gemini
> prepay top-up has not landed yet and is expected to take a few hours.
> That confirms the cause of the 422s in section 4.2 and creates a specific
> risk when the credits do arrive — see the trap described there.

---

## 1. Bottom line

The pipeline ingests, but nothing downstream of ingestion works today.

| Stage | Status | Evidence |
|---|---|---|
| Property ingestion (NYC HPD, evictions, NJ MOD-IV) | Working, last run 2026-09-14 | 879 raw rows, 915 properties, 0 unprocessed |
| ISA lead ingestion (ACRIS divorce, empty-nester, developer) | Working, but producing duplicates | 534 leads created today, only 149 distinct addresses across the table |
| AI enrichment, Anthropic path (`enrich-leads`, `enrich-pending`) | **Broken** | `401 authentication_error — "API key is invalid."` A replacement key installed 18:30 UTC did not fix it; a stale worker was ruled out by testing a cold isolate. See 4.1. |
| AI enrichment, Gemini path (S2 via `list-pending-enrichment` → `write-enrichment`) | **Blocked on billing** | All 50 `write-enrichment` calls in the 16:14–16:22 run returned **422**, caused by an empty Gemini prepay balance the `Resume` handler masked. Top-up pending as of 18:40 UTC. The response mapping remains unproven. See 4.2. |
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

### 4.1 Anthropic — unchanged on re-check

| When | Function | Error |
|---|---|---|
| 2026-09-15 00:19 | `enrich-pending` | `400 … Your credit balance is too low to access the Anthropic API` |
| 2026-09-19 to 2026-09-21 16:22:55 | `enrich-leads` | `Anthropic 401` on every lead, every run |

The key is present (`anthropic_key_present: true`, 108 chars — the right
length for a current key). A 401 with a key present means the key was
revoked, regenerated, or belongs to an organization whose access ended.
Refilling credits will not fix a 401, and the 2026-09-15 balance error is a
separate, earlier problem. **Verified.**

The model ID in `enrich-leads`, `claude-sonnet-4-6`, is a currently valid
model. So the 401 is purely authentication: nothing about the request shape
is at fault, and the function will start working on a valid key with no code
change. **Verified.**

One related item to check while the key is being replaced: `respond-lead`
and `enrich-pending` both request `claude-haiku-4-5-20251001`, a
date-suffixed form of the `claude-haiku-4-5` ID. Current guidance is to use
the unsuffixed ID. Whether the suffixed form still resolves was not tested
here, and it would surface as a 404 rather than a 401. **Unverified** —
worth one probe once the key works, because `respond-lead` is the inbound
auto-responder and a silent 404 there means inbound leads get the canned
fallback SMS instead of a written reply.

**Update, 2026-09-21 18:30 UTC — a new key was installed and did not fix
it.** Tested directly through two functions. Anthropic's verbatim response:

```
401 {"type":"error","error":{"type":"authentication_error",
     "message":"API key is invalid."},"request_id":null}
```

That is more specific than the earlier reading. It is not an expiry, not a
balance problem (which returns a 400 with a distinct message, as on
2026-09-15), and not workspace scoping (a 400 naming
`anthropic-workspace-id`). The key string reaching Anthropic is being
rejected outright, and `request_id: null` means it was discarded before
becoming a request.

A stale warm worker was ruled out rather than assumed. `enrich-leads`
captures the key once at module load, so it could serve an old value
indefinitely; `enrich-pending` reads it inside the handler and had been
cold since 2026-09-15, so it booted fresh against the currently stored
secret. Both returned the same error. **A redeploy will not help.**

What is still open: whether the stored secret ever changed. The function
reports the key length as 108 characters, identical to the previous key —
which is also the normal length for a valid key, so it discriminates
nothing. Two checks settle it:

1. `supabase secrets list --project-ref omzugrtgwsjypekuzgtn` prints a
   digest per secret. An unchanged digest means the save never landed
   (wrong project — `silent-legacy-media` is also active in that org — or
   an uncommitted dashboard edit).
2. Test the key against Anthropic directly from a workstation, which
   separates "is the key good" from "did Supabase receive it".

Also worth ruling out: a key beginning `sk-ant-admin` is an Admin key and
is rejected by the Messages API by design. A valid inference key begins
`sk-ant-api`.

### 4.2 Gemini (Make module in S2) — new failure mode on re-check

Earlier errors, now resolved:

| When | Error |
|---|---|
| 14:54 UTC | `[402] Your prepayment credits are depleted` |
| 15:56 UTC | `[404] gemini-2.5-flash is no longer available to new users … use gemini-3.6-flash` |
| 15:55 to 16:00 UTC | `[503] This model is currently experiencing high demand` (5 runs) |

Between 16:11 and 16:14 the scenario was edited three more times. The
current blueprint (last edited 16:14:46) differs from the version described
earlier in this report:

- `model` is now `gemini-3.6-flash`, which clears the 404.
- `thinkingConfig` and `imageConfig` were removed from `generationConfig`;
  only `responseMimeType: application/json` remains.
- The Gemini module's error handler changed from `builtin:Ignore` to
  `builtin:Resume`, substituting `{candidates: [], usageMetadata: {…: 0}}`.
- The `write-enrichment` module got its own `Resume` handler substituting
  `{data: {}, success: false}`.

The 16:14:52 → 16:22:56 run then completed with status SUCCESS, 252
operations, over 8 minutes. It is the first run that reached
`write-enrichment` for every lead. The result:

| Path | Status | Count |
|---|---|---|
| `write-enrichment` | **422** | **50 of 50** |
| `enrich-leads` | 200 (all leads 401 internally) | 50 |
| `notify-isa` | 200, `no_leads_matched` | 100 |

**Verified** from edge logs and the Make execution record. A 422 from
`write-enrichment` has exactly one cause in its source: `parseModelJson`
found no `{` in `raw_text`. So the scenario is now handing that endpoint an
empty or non-JSON string on every lead.

Two candidate causes, and this session could not distinguish them:

1. **Gemini is still failing and `Resume` is masking it.** The substituted
   bundle sets `candidates: []`, so `{{3.candidates[1].content.parts[1].text}}`
   resolves to empty, and `write-enrichment` 422s. The switch from `Ignore`
   to `Resume` made this worse, not better: `Ignore` skipped the lead,
   whereas `Resume` guarantees a doomed downstream call and burns two
   operations doing it. The 402 credit-depletion error at 14:54 was never
   shown to be resolved, and a still-empty prepay balance would produce
   exactly this on all 50.
2. **The response mapping is wrong.** `{{3.candidates[1].content.parts[1].text}}`
   may not match what the Make Gemini module actually emits for this model.
   An earlier version of this mapping was demonstrably wrong in a different
   way: the `write-enrichment` diagnostic row from 14:53 shows `raw_text`
   arriving as the **prompt** (`"Analyze this prospect and return JSON
   only.…"`, 1,006 chars), meaning the field was mapped to `{{2.prompt}}`
   at that point.

**Cause 1 is confirmed** (project owner, 2026-09-21 ~18:40 UTC): the Gemini
prepay top-up has not landed on Google's side yet and is expected to take a
few hours. So the balance was still empty throughout the 16:14–16:22 run.
Every Gemini call 402'd, `Resume` substituted `candidates: []`, and
`write-enrichment` received an empty string. That accounts for all 50
failures without needing cause 2.

**Cause 2 is not thereby excluded, and this is the trap.** The mapping has
never been observed working. It was demonstrably wrong once already, and
the two `Resume` handlers now guarantee that a mapping failure and a
successful run look identical from Make's side: the scenario reports
SUCCESS either way. When the credits land, a green run is therefore *not*
evidence that enrichment works.

Do two things before the top-up arrives:

1. **Restore the diagnostic.** `write-enrichment` version 4 persisted a
   `diag_write_enrichment_*` row recording `raw_text_length` and
   `raw_text_preview`; version 5 (deployed 14:56) dropped it. Without it
   there is no record of what the endpoint actually received.
2. **Reconsider the `Resume` handlers.** `Ignore` at least skipped a failed
   lead. `Resume` feeds a known-bad bundle downstream and burns two
   operations per lead doing it, while converting a visible failure into a
   silent one.

Then verify on evidence, not on run status: after the credits land, run S2
with `limit: 1` and check that an `isa_leads` row has
`ai_model = 'gemini-3.6-flash'` and a non-null `ai_enriched_at`. As of this
writing no row in the table has ever had a non-null `ai_model`, so any
non-null value is proof the path completed end to end.

### 4.3 Supabase edge functions

| Path | Status | Count | Meaning |
|---|---|---|---|
| `write-enrichment` | 422 | 50 (latest run) + 8 earlier | "parse failed: No JSON object in model response" |
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

### 4.6 Structural bug in S2: batch modules run inside the per-lead loop

Found while re-checking the Gemini path. In the current S2 blueprint,
module 2 is a `BasicFeeder` iterating `{{1.data.data.leads}}`. Everything
after it runs **once per lead**. Modules 3 and 4 (Gemini, `write-enrichment`)
belong there — they are per-lead by design. Modules 5, 6 and 7 do not:

| Module | What it is | Should run | Actually runs |
|---|---|---|---|
| 5 | `enrich-leads` with `{"limit": 50}` | once per run | once per lead |
| 6 | `notify-isa` `{"routing":"hot","limit":20}` | once per run | once per lead |
| 7 | `notify-isa` `{"routing":"warm","limit":30}` | once per run | once per lead |

**Verified** three ways: the blueprint has no aggregator between modules 4
and 5; the 16:14 run recorded 252 Make operations where a correctly shaped
50-lead run needs about 104; and the edge logs for that window show exactly
50 `enrich-leads` and 100 `notify-isa` calls against 50 `write-enrichment`
calls.

Consequences, in order of how much they matter:

- **Make operations.** About 148 wasted operations per run, roughly 2.4× the
  necessary count. That scales linearly with batch size: a 200-lead batch
  would waste ~600.
- **Runtime.** The run took 8 minutes and 4 seconds, almost all of it in the
  50 sequential `enrich-leads` calls. Each carries a 90-second Make timeout,
  so a batch where Anthropic actually responds is a plausible timeout
  candidate — and the 2026-09-08 run already failed exactly that way.
- **Notification duplication risk.** `notify-isa` flips a lead to
  `attempting` after a successful send, so a second pass will not re-send
  the same lead. That is the only reason 100 invocations are not 100 duplicate
  alerts. It is load-bearing behaviour nobody designed for.
- **Anthropic spend is *not* multiplied 50×.** `enrich-leads` selects leads
  with `ai_summary IS NULL` and a limit of 50, so successive calls walk
  through the pending pool rather than re-enriching it. With 585 pending
  leads and a working key, roughly the first 12 calls would do real work and
  the remaining 38 would return zero rows. The cost is wasted round trips,
  not a 50× token bill. Worth stating plainly because the operation count
  looks alarming and the token exposure is the thing that would actually be
  expensive.

Fix: put an aggregator (or a second route off a router) between module 4 and
module 5, so modules 5–7 run once after the loop finishes rather than inside
it.

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

1. **Get one enrichment path working, and only one.** The Anthropic fix is a
   new key and nothing else — the model ID is valid and the code is sound, so
   this is the shortest route to a working pipeline. The Gemini path needs a
   diagnosed 422 on top of a funded balance and a verified response mapping.
   Fix the key first, confirm one lead enriches end to end, then decide
   whether Gemini is still wanted.
2. **Before any more S2 runs: move modules 5–7 out of the iterator** (section
   4.6). Right now every run makes 148 unnecessary Make operations and 100
   `notify-isa` calls. That is tolerable while everything 401s and is not
   tolerable once the key works.
3. **Deduplicate `isa_leads` and fix the `.or()` filter** before running any
   more ACRIS bridges. Add the unique index so it cannot recur.
4. **Add routing rules** for `divorce`, `empty_nester`, `homeowner`, `landlord`
   or the ingested leads are invisible to agents.
5. **Put a real delivery channel back in the Notify Receiver** (email at
   minimum) and fix S16's validation error, or inbound leads are lost.
6. **Add the `x-make-secret` check to `ingest-raw-properties`**, rotate the
   shared secret, and move it to a Make environment variable.
7. **Schedule S10 and the ingest scenarios** so the system runs without a
   person clicking Run.
8. **Merge PR #13, then re-sync** the 7 missing functions and 3 migrations,
   and close the 10 PRs that no longer reflect the system.
9. **Decide where the dashboard lives.** Either build `nextjs-inrange` out
   using the existing role-based RLS with the anon key (not the service-role
   key), or move PR #4's `dashboard/` there and rewrite its data layer.
10. **Consent gate before any outbound SMS.** Require `sms_consent=true` in
    `follow-up-cadence`, and treat inbound-SMS replies as the only implied
    consent.
11. Clean-up: delete the 21 orphaned webhooks, the 4 `ZZ Temp` scenarios,
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
