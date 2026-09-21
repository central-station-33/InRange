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
>
> **Resolved since, ~19:45 UTC.** Two findings in this report are now fixed
> and are marked RESOLVED in place rather than deleted, so the evidence trail
> survives. (a) The Anthropic 401 is gone — a third key replacement took, and
> a live call through `enrich-leads` enriched a real lead and wrote a real row
> (section 4.1). (b) `isa_leads` has been deduplicated, 627 rows down to 162,
> and a partial unique index now makes the duplicate class impossible
> (section 4.4). Fixing the key also exposed a new, separate defect in the
> routing the ISA acts on — section 4.7, which is open.
>
> **Re-run, ~22:50 UTC.** Live re-check of every claim in this report against
> current production state, four sections changed:
> - Enrichment kept running after the last revision: all 162 current leads
>   now carry an `ai_summary` (was 75), $1.11 of $15 spent, not paused.
> - Assignment is corrected, not just updated: the "no routing rule, 432
>   unassigned" finding in 4.5 was accurate when written and is **wrong now**
>   — a wildcard rule was added to `agent_routing_rules` since, and all 162
>   leads are assigned. Section 4.5 marks this as a correction rather than
>   silently changing the number.
> - The routing-derivation bug (4.7) is confirmed at full scale on live data:
>   19 of 162 violate the prompt's own rules (11.7%), matching the earlier
>   12% estimate from a smaller, backup-inclusive sample. Still not fixed,
>   still not authorised.
> - Notification is now the whole story: `lead_touches` and
>   `notification_log` are both 0 against 162 enriched, assigned leads. This
>   is the actual bottleneck as of this revision, not enrichment or
>   assignment.
>
> Separately, the ops-reduction work from earlier today (S19, S1b, S1c, S1d)
> is Make/Supabase configuration, not a repo change, and isn't detailed here;
> see the PR conversation for that trail.
>
> **Notification delivery built, ~23:10 UTC.** The "ISA Notify Receiver"
> Make scenario did nothing but acknowledge its webhook — added a real
> Gmail send step using the account's existing OAuth connection. Also found
> and fixed: `notify-isa` was marking leads `'attempting'` (permanently
> un-retryable) on webhook-200 regardless of whether anything downstream
> actually sent, which had already silently stranded all 23 current hot/warm
> leads. Reset them and re-ran for real: **23/23 sent**, verified against 23
> individual Make executions, not just the caller's success count. See
> revised 4.5. Not a repo change — Make/Supabase configuration only.

---

## 1. Bottom line

**Updated ~23:10 UTC.** The pipeline now enriches, assigns, and *delivers*.
As of this revision 23 real emails have been sent to the agent for hot and
warm leads (7 and 16 respectively), verified against 23 individual Make
executions, not just an API success count. `lead_touches`/`notification_log`
staying at 0 is now expected, not a gap — those track a human ISA's logged
outcome of the call, a separate step after this notification, not a broken
delivery channel. What's actually left: SMS/Slack are unbuilt (no connection
exists), and the email step is single-agent-only — it doesn't yet route by
the lead's actual assigned agent.

| Stage | Status | Evidence |
|---|---|---|
| Property ingestion (NYC HPD, evictions, NJ MOD-IV) | Working, scheduled daily 07:00–08:30 ET | 900 raw rows as of 22:46 UTC (was 879). S1b/S1c/S1d moved to a daily schedule and re-verified live today; see §7 and the PR notes on the Route A ops work. |
| ISA lead ingestion (ACRIS divorce, empty-nester, developer) | Working; duplicates cleaned and now blocked at the DB | Table deduplicated 627 → 162 rows, 465 removed to a backup table, partial unique index applied and guard-tested. The `.or()` filter in `ingest-leads` is still unfixed — the index is what holds the line. See 4.4. |
| AI enrichment, Anthropic path (`enrich-leads`, `enrich-pending`) | **Working** (as of 2026-09-21 ~19:20 UTC) | Live call returned `enriched: 1`, 358 input / 596 output tokens, and wrote `ai_summary`, BANT and routing to a real lead. The 401 was a bad key string, fixed on the third replacement. See 4.1. |
| AI enrichment, Gemini path (S2 via `list-pending-enrichment` → `write-enrichment`) | **Blocked on billing, status unchanged** | All 50 `write-enrichment` calls in the 16:14–16:22 run returned **422**, caused by an empty Gemini prepay balance the `Resume` handler masked. Top-up pending as of 18:40 UTC, not re-checked since. The response mapping remains unproven. See 4.2. |
| Lead assignment (`assign-leads`) | **Working — 100% of current leads assigned** | Re-checked live: all 162 leads carry `assigned_agent_id`, all to the sole agent. A wildcard rule (`segment: null`, priority 99) added to `agent_routing_rules` since the original finding catches everything the 11 named rules don't. See revised 4.5 — the original "no rule, 432 unassigned" claim is corrected there, not deleted. |
| ISA notification (`notify-isa` → Make receiver) | **RESOLVED — real email delivery built and verified** | The receiver scenario did nothing but ack a webhook (not even `log-touch`, contrary to what this report previously said). Added a `google-email:sendAnEmail` module using the account's existing Gmail connection. 23/23 hot+warm leads sent, confirmed against 23 individual Make executions. A related bug (notify-isa marking leads `'attempting'` on webhook-200 regardless of real delivery, permanently stranding them) was also found and reset. SMS/Slack still unbuilt — no connection exists for either. See revised 4.5. |
| Inbound lead fast response (S16 → `respond-lead`) | **Broken** | Last two real inbound events (2026-09-17) failed with `BundleValidationError` before reaching the edge function. |
| Inbound SMS (S18) and email parser (S17) | Never executed | Both active since 2026-09-06 with zero runs. |
| Follow-up cadence (`follow-up-cadence`) | Not scheduled | The only scenario that calls it, **ISA S19 – Follow-up Cadence** (id 5094961), is inactive and marked invalid. Note the name collision: this is a different scenario from **ISA S19: High-Value Homeowner Bridge** (id 6187369), which is active and was moved from 35 ops/run to 1 today — see §7. Worth renaming one of them before it causes a wrong-scenario mistake. |
| Skip trace (DataSkip) | Wired, spend gated | 2 confirmations issued, 2 leads matched, 18 no-match. Two-step approval gate works as designed. |
| AI routing (`bant_score` → `routing`) | **Broken, confirmed at full scale, still not fixed** | Re-checked against all 162 current leads (up from the 172-row sample that included dedupe-backup rows): 143 agree with the prompt's own stated rules, **19 violate them (11.7%)** — consistent with the original 12% estimate, not a fluke of the smaller sample. `enrich-leads` still trusts the model's `routing` string instead of deriving it from `bant_score`. See 4.7. Not authorised for a code fix as of this revision. |
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

### 4.1 Anthropic — RESOLVED 2026-09-21 ~19:20 UTC

**Current state: working.** A live call through `enrich-leads` returned
`enriched: 1` with 358 input and 596 output tokens and wrote `ai_summary`,
the four BANT components and `routing` to a real lead row. That is the test
that matters — not the absence of an error in a log, but a paid call whose
output landed in the table. **Verified.**

It took three key replacements. The two that failed both returned:

```
401 {"type":"error","error":{"type":"authentication_error",
     "message":"API key is invalid."},"request_id":null}
```

The diagnostic trail is kept below because the same failure will recur the
next time a key is rotated, and the cheap checks are worth having written
down.

| When | Function | Error |
|---|---|---|
| 2026-09-15 00:19 | `enrich-pending` | `400 … Your credit balance is too low to access the Anthropic API` |
| 2026-09-19 to 2026-09-21 16:22:55 | `enrich-leads` | `Anthropic 401` on every lead, every run |
| 2026-09-21 18:30 | both | `401 … "API key is invalid."` after first replacement |
| 2026-09-21 ~19:20 | `enrich-leads` | none — `enriched: 1` |

What the 401 was and was not:

- **Not an expiry and not a balance problem.** A depleted balance returns a
  400 with a distinct message, as on 2026-09-15.
- **Not workspace scoping.** An unscoped (organization-level) key returns a
  400 naming `anthropic-workspace-id`, not a 401 — none of these functions
  send that header, so a workspace-scoped key is the right choice here.
- **Not a stale warm isolate**, and this was ruled out rather than assumed.
  `enrich-leads` captures the key once at module load and can serve an old
  value indefinitely; `enrich-pending` reads it inside the handler and had
  been cold since 2026-09-15, so it booted fresh against the stored secret.
  Both returned the same error, so a redeploy would not have helped.
- **`request_id: null`** means the string was rejected before it became a
  request. The key text reaching Anthropic was simply wrong.

The one discriminator that does not work: key length. All three keys reported
108 characters, so `anthropic_key_len` in the diagnostic row tells you nothing
about whether a save landed. Use `supabase secrets list --project-ref
omzugrtgwsjypekuzgtn`, which prints a per-secret digest, or test the key
against Anthropic directly from a workstation.

Rotation checklist, for next time:

1. The key must begin `sk-ant-api`. `sk-ant-admin` is an Admin key and is
   rejected by the Messages API by design; `sk-ant-oat01-` is an OAuth token
   and is not a Messages API credential either.
2. Scope it to the **workspace**, not the organization, unless you also add
   an `anthropic-workspace-id` header to every function.
3. Save it to project `omzugrtgwsjypekuzgtn` (InRange). `silent-legacy-media`
   is also active in the same org and is the easy mis-save.
4. Verify with a real call that writes a row, not with a log that is quiet.

**Still open from this section.** `respond-lead` and `enrich-pending` both
request `claude-haiku-4-5-20251001`, a date-suffixed form. Whether it still
resolves was not tested, and it would surface as a 404, not a 401 — so a
working key does not clear it. Worth one probe, because `respond-lead` is the
inbound auto-responder and a silent 404 there means inbound leads get the
canned fallback SMS instead of a written reply. **Unverified.**

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

### 4.4 Lead deduplication — data RESOLVED 2026-09-21 ~19:30 UTC, code still open

**The duplicates are gone and cannot come back. The bug that created them is
still in the source.** Those are two different statements and both matter.

#### The bug

`ingest-leads` deduplicates with a PostgREST filter:

```
.or(`full_name.eq.${identifier},entity_name.eq.${identifier}`)
```

PostgREST uses the comma as the OR separator. 552 of 627 leads had a name
containing a comma (ACRIS returns `LAST, FIRST`), so the filter parsed as
three clauses, the third malformed, and the lookup returned nothing. The
insert then proceeded. Each ACRIS bridge run (S8 and S9 ran 3 and 4 times on
2026-09-21) re-inserted the same leads. Result: 68 addresses appeared 2 to 9
times, and the "534 new leads today" figure was closer to 70 unique people.
**Verified** (names with comma: 552; distinct addresses: 149).

Secondary cause: `maybeSingle()` throws when more than one row matches, which
was guaranteed once duplicates existed, so even a corrected filter would have
kept failing until the table was cleaned.

#### What was done

1. **Backed up first.** All 465 rows destined for deletion were copied to
   `isa_leads_dedupe_backup_20260921` before anything was removed. Still
   present, 465 rows, confirmed by count. Nothing was destroyed.
2. **Deduplicated**, keeping the earliest row per natural key. 627 → 162
   rows, 465 deleted, 0 duplicate groups remaining. **Verified by re-query.**
3. **Applied a partial unique index**, committed to the repo as
   `supabase/migrations/20260921193000_isa_leads_natural_key_unique_index.sql`:

   ```sql
   create unique index if not exists isa_leads_natural_key_uidx
   on isa_leads (
     coalesce(segment, ''),
     coalesce(market, ''),
     lower(btrim(coalesce(full_name, entity_name, ''))),
     lower(btrim(coalesce(property_address, '')))
   )
   where outreach_status is distinct from 'dead'
     and outreach_status is distinct from 'closed';
   ```

   `coalesce` on every term is load-bearing: a NULL in any column would
   otherwise make the row unique against everything, which is exactly the
   escape hatch the ACRIS rows would have used. `is distinct from` rather
   than `not in` for the same reason — `outreach_status NULL NOT IN (...)`
   evaluates to NULL, not true, and the row would fall out of the index.
   The partial predicate is deliberate: a dead or closed lead should not
   block re-ingesting the same person later.
4. **Guard-tested with a real rejected insert**, not by reading the DDL. A
   deliberate duplicate was attempted and Postgres refused it.

#### What it cost

Measured from the backup table, the duplicates were not merely untidy — they
were billed. 97 of the 465 deleted rows carried an `ai_summary`, and **10 of
them carried audited token counts** — 10 paid Anthropic calls and 6,136
output tokens spent analysing people the table already held. (The other 87
pre-date the `ai_input_tokens`/`ai_output_tokens` audit columns, so their cost
is unknown, not zero.) At Sonnet rates the measurable waste is small money,
but it scaled linearly with bridge runs and would have compounded the moment
the key started working. **Verified from the backup.**

#### Still open

- **The `.or()` filter in `ingest-leads` is unchanged.** The index now
  converts the bug from silent duplication into a visible insert error, which
  is the right failure mode but is still a failure mode. The fix is two
  `.eq()` queries, or a `.or()` with the values wrapped in double quotes, or
  better, an upsert on the natural key so a re-run is idempotent by design.
- **`source_document_id` is still not captured.** The ACRIS document ID is
  the actual identity of these records; name plus address is a good proxy and
  nothing more. Until it is stored, two genuinely distinct filings on the
  same property by the same owner cannot be told apart.
- `isa_leads_dedupe_backup_20260921` is working data sitting in `public`.
  The `ensure_rls` event trigger should have enabled RLS on it automatically,
  but that was not confirmed, and no policy was written for it either way.
  Drop it once the cleanup is accepted, or move it out of `public`.

### 4.5 Assignment and notification

**CORRECTION, 2026-09-21 ~22:50 UTC.** This section originally said no rule
covered `divorce`, `empty_nester`, `homeowner`, `landlord` and that those
leads therefore never got an agent. Re-checked live and that is no longer
true, and the mechanism is worth recording. `agent_routing_rules` now has 11
named rows (`athlete`, `investor`, `expat_relocation`, `film_tv`, `developer`
× NYC/NJ) **plus a catch-all row added since**: `segment: null, market: null,
priority: 99, max_active_leads: 500`. `assign-leads` matches a rule when
`r.segment === null OR r.segment === lead.segment`, so that row matches
everything nothing else claims. Result, checked directly against
`isa_leads`: **all 162 current leads are assigned**, all to the same person
(`assigned_agent_id = 8d459409-...`) — unsurprising, since `team_agents` has
exactly one row. The original finding wasn't fabricated — it was true when
written and the wildcard rule was added afterward — but it's stale now, and
leaving it uncorrected would send someone chasing a problem that no longer
exists. **Verified**, by direct query.

What the wildcard doesn't fix: it's a single-agent stopgap. The moment a
second agent exists, every unnamed segment (`divorce`, `empty_nester`,
`homeowner` among them) funnels to whichever agent this rule points at,
priority 99, regardless of who should actually own it. Named rules per
segment are still the correct fix before hiring; noting it here so it
doesn't get re-discovered as a surprise later.

- **RESOLVED, 2026-09-21 ~23:05 UTC.** Notification delivery is now real.
  The "ISA Notify Receiver" Make scenario (id 5077766) had shrunk to a bare
  webhook-in/webhook-respond pair with nothing in between — not even the
  single `log-touch` call this section previously described; it did
  literally nothing but acknowledge receipt. A `google-email:sendAnEmail`
  module was added between them, using the Gmail OAuth connection already
  live on this account (proven working elsewhere, in the inactive
  "Unclaimed Landlord Lead Alert" scenario), sending to the sole agent's
  address with the lead's name, AI summary, talking points, BANT/motivation
  scores, contact info and commission split — all fields `notify-isa`
  already assembled but had nowhere to send.

  A second, related bug surfaced in the same pass: `notify-isa` marks a lead
  `outreach_status = 'attempting'` as soon as the webhook call returns 200 —
  and the old empty receiver always returned 200. So every prior notify
  attempt "succeeded" and permanently removed the lead from the `'new'`
  pool notify-isa re-queries, without anything ever being sent. All 7 hot
  and 16 warm leads were stuck this way. They were reset to `'new'` and
  `notify-isa` was re-run for real for both routings: **23/23 sent, 0
  errors**, confirmed against 23 individual Make executions
  (`status: 1, operations: 3` — webhook → email → respond — each), not
  just the caller's success count. 23 real emails landed in the agent's
  inbox. **Verified end to end**, not by config review.

  Still open: SMS and Slack are unbuilt (no Twilio or Slack connection
  exists on this Make team), so `sms_message` — a field `notify-isa` has
  built into its payload since before this fix — is composed and unused.
  Single-agent-only: the email module hardcodes the one connected address;
  the moment a second agent exists this needs to route by the lead's actual
  assigned agent, which `notify-isa`'s payload doesn't currently carry (only
  `assigned_agent` as a display name, not an address). `lead_touches` and
  `notification_log` remain 0 — correctly: those track an ISA's logged
  outcome of actually calling the lead (via `log-touch`), a distinct,
  still-manual step downstream of this notification, not a defect in it.

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

### 4.7 NEW: routing is taken from the model, not derived from the score

This was invisible while everything 401'd. Fixing the Anthropic key made it
visible, and it affects the one field an ISA acts on directly.

`enrich-leads` computes `bantScore` itself, correctly, by summing the four
clamped components — and then ignores it when setting `routing`:

```ts
const routing = typeof result.routing === 'string' && ROUTINGS.has(result.routing)
  ? result.routing
  : null;
```

Any of the four strings in `ROUTINGS` is accepted on the model's word alone.
The system prompt states the rules the model is supposed to apply:

```
- hot:     bant total >= 9 AND motivation_score >= 4
- warm:    bant total >= 7 OR  motivation_score >= 3
- nurture: bant total >= 4
- cold:    all other cases
```

Those rules are arithmetic. The code already has both inputs in hand at the
moment it writes the row. It asks the model instead.

**The model does not follow them.** Applying the prompt's own rules to every
enriched row (75 live plus 97 in the dedupe backup, 172 total) gives **151
agreements and 21 violations — 12% of assessments routed against the stated
policy.** **Verified.**

| `bant_score` | routings actually written |
|---|---|
| 2 | `cold` ×12, `nurture` ×2 |
| 3 | `cold` ×1, `nurture` ×3 |
| 6 | `nurture` ×11, `warm` ×2 |
| 7 | `nurture` ×6, `warm` ×10 |

Score 7 is the clearest case: the rule says `warm`, and 6 of 16 rows at that
score were written `nurture`. Score 2 and 3 straddle the `nurture` cutoff of
4 in both directions. The strongest single piece of evidence is that
**identical input produced different output**: five duplicate rows for
`420 West 42nd Street, LLC` at the same address, all scored `bant_score 2`,
were split across `cold` and `nurture`. Same prospect, same prompt, same
score, two different call-list priorities — which is what non-determinism in
a business rule looks like from the outside.

Why it matters more than the percentage suggests: `routing` is what tells an
ISA whether to call someone today. A lead demoted from `warm` to `nurture` is
not called. `notify-isa` has separate hot and warm paths keyed on this field
(the two calls inside the S2 iterator, section 4.6), so a wrong routing value
does not just mis-sort a list, it changes whether a notification fires at all.

Fix: derive it. Delete the model's `routing` from the write and compute it
from `bantScore` and the clamped `motivation_score` using the four rules
above. Keep `routing` in the requested JSON shape if you want the model's
opinion recorded, but write it to a separate advisory column rather than the
one the pipeline reads. This is a ~6-line change in `enrich-leads` and it
makes the field reproducible from data already stored on every row.

Two related notes on the same write path:

- The `...(routing ? { routing } : {})` spread means a malformed `routing`
  leaves the column at whatever it was before, silently. On a re-enrichment
  that is a stale value presented as fresh. Deriving it removes the branch.
- `bant_score` itself is sound — the component-sum fallback is well built and
  the CHECK-constraint clamping before the write is the right instinct. The
  defect is narrow and local to `routing`.

**Not yet fixed.** Unlike 4.1 and 4.4, no change has been made for this.

## 5. Data quality snapshot

| Table | Rows | Notes |
|---|---|---|
| `properties` | 915 | 49 Tier 1 pending enrichment since 2026-09-08; 0 complete; 3 quarantined. 592 of 915 have no ARV. |
| `raw_properties` | 879 | All processed. 12 rows are diagnostics. |
| `isa_leads` | 162 (was 627) | Deduplicated 2026-09-21; 465 rows moved to `isa_leads_dedupe_backup_20260921`. **All 162 now have an `ai_summary`** (up from 75 at ~19:30 UTC — a further enrichment run completed 19:20–20:28 UTC, $1.11 of the $15/month Anthropic budget spent, not paused). All 162 are also assigned (§4.5). Contact coverage remains the binding constraint: almost none carry a phone or email, so enrichment and assignment cannot compensate for having no way to reach the person, and 0 have been touched (`lead_touches`, `notification_log` both empty). |
| `team_agents` | 1 | James Thompson, broker, linked to the only auth user. |
| `lead_touches`, `deals`, `outreach`, `owners`, `notification_log`, `inrange_leads`, `contact_activities` | 0 | Never written. |
| `rental_*`, `landlord_leads`, `tours`, `content_queue`, `automation_settings` | 0 | Leasing module and blog automation tables, unused. |

54 of the pre-dedupe leads had entity-shaped names (LLC, bank as trustee,
condominium) in segments meant for individuals — the proportion after the
dedupe was not re-measured. The `homeowner` skip-trace path filters these;
`divorce` and `empty_nester` do not, and neither does the `enrich-leads`
selection query, so the pipeline pays to analyse them (section 7, item 5).

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

**Done since this report was written** (struck from the list, kept here so the
ordering still reads as a sequence):

- ~~Get the Anthropic path working.~~ Done — section 4.1. A real lead
  enriched end to end at ~19:20 UTC.
- ~~Deduplicate `isa_leads` and stop it recurring.~~ Data done and the unique
  index is applied — section 4.4. **The `.or()` filter itself is still
  unfixed**, so this is carried forward as item 2 below rather than closed.

Remaining, in order:

1. **Fix `routing` in `enrich-leads`** (section 4.7). Derive it from
   `bant_score` and `motivation_score` instead of trusting the model's
   string. This is first because the key now works, so every enrichment run
   from here on writes more rows with a field that is wrong 12% of the time,
   and `notify-isa` branches on it. Six lines. Then re-derive `routing` for
   the 162 existing rows from the components already stored — no re-billing
   needed.
2. **Fix the `.or()` filter in `ingest-leads`** before the next ACRIS bridge
   run (section 4.4). The unique index now catches the duplicates, so the
   failure is loud instead of silent — but the next run will error rather
   than insert. Convert the lookup to an upsert on the natural key and the
   whole class goes away.
3. **Before any more S2 runs: move modules 5–7 out of the iterator** (section
   4.6). Every run makes 148 unnecessary Make operations and 100 `notify-isa`
   calls. That was tolerable while everything 401'd. It is not tolerable now
   that the key works, and it is a spend problem the moment Gemini credits
   land too.
4. **Decide whether Gemini is still wanted** (section 4.2). The credits are
   pending. The response mapping in module 4 has never been observed
   producing a value, so a funded balance proves nothing by itself — restore
   the `write-enrichment` diagnostic row before the credits arrive, or the
   first funded run will look like it worked and write nothing. With
   Anthropic working and budget-gated at $15/month, running both paths is a
   choice, not a necessity.
5. **Stop paying to analyse entities in the `homeowner` segment.** The
   enrichment prompt itself tells the model to flag "entity owner — no
   individual to call"; the selection query does not filter them out, so the
   pipeline pays Sonnet rates to be told a lead is uncallable.
6. **Add routing rules** for `divorce`, `empty_nester`, `homeowner`,
   `landlord`, or the ingested leads stay invisible to agents (section 4.5).
7. **Put a real delivery channel back in the Notify Receiver** (email at
   minimum) and fix S16's validation error, or inbound leads are lost.
8. **Add the `x-make-secret` check to `ingest-raw-properties`**, rotate the
   shared secret, and move it to a Make environment variable.
9. **Schedule S10 and the ingest scenarios** so the system runs without a
   person clicking Run.
10. **Merge PR #13, then re-sync** the 7 missing functions and 3 migrations,
    and close the 10 PRs that no longer reflect the system.
11. **Decide where the dashboard lives.** Either build `nextjs-inrange` out
    using the existing role-based RLS with the anon key (not the service-role
    key), or move PR #4's `dashboard/` there and rewrite its data layer.
12. **Consent gate before any outbound SMS.** Require `sms_consent=true` in
    `follow-up-cadence`, and treat inbound-SMS replies as the only implied
    consent.
13. Clean-up: delete the 21 orphaned webhooks, the 4 `ZZ Temp` scenarios,
    the 4 retired 410 functions, the `isa_leads_dedupe_backup_20260921`
    table once the cleanup is accepted, and either fix or disable Scenario 1.

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
- Two post-dedupe re-measurements: the entity-shaped-name proportion in the
  remaining 162 rows, and whether RLS is enabled on
  `isa_leads_dedupe_backup_20260921`. Both are noted inline where they
  matter (sections 4.4 and 5) rather than stated as fact.
