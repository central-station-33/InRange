# AI Lead Enrichment Blueprint — JRA CRM

Status: **proposal / not yet implemented**. This document specifies the target
architecture for turning InRange's raw property signals into evidence-backed,
prioritized leads for The J.E.T. Group / Jet Realty Advisors (JRA). It extends
the existing pipeline (`README.md`) rather than replacing it — ingestion,
rule-based scoring, and the current `enrich-ai` Claude summary step keep working
as-is until each phase below is built and approved.

No new vendor, model provider, or infra platform described here should be
wired up (API keys issued, Edge Functions deployed, Make.com scenarios built)
until this doc — specifically the "Open decisions" section — is signed off.
The schema in `20260915120000_ai_lead_enrichment.sql` is additive-only (no
existing table is altered or dropped) so it can land ahead of that approval
without risk.

## 1. Problem with the current model

`property_scores.ai_summary` is a single free-text field written once by
Claude. It mixes confirmed public-record facts with AI phrasing, has no
per-fact source, no confidence, and no notion of "what should an agent do
next." That's fine for an investor-facing memo; it is not enough for a CRM
record an agent will act on, potentially by contacting a homeowner in
foreclosure or probate — categories with real legal exposure if the "next
action" is wrong or the AI invents a detail.

The blueprint below is built around one rule:

> **An AI-generated field is never presented as a verified fact.** Every
> field in a lead record carries its own source and confidence. The UI must
> visually distinguish "confirmed by a primary source" from "AI-inferred,
> needs verification" — never blend them into one sentence with no markers.

## 2. Lead record model

A **lead** is a CRM-facing entity built on top of one or more `properties`
rows (a property can have multiple leads over time — e.g. it re-enters
foreclosure after a prior lead was closed). Every fact attached to a lead
lives in an **evidence ledger** (`lead_evidence`), not as a plain column with
no provenance. The lead record itself only stores derived state: category,
tier, assignment, status, and the compliant next action.

Five questions the lead record must answer, mapped to storage:

| Question | Where it lives |
|---|---|
| What is confirmed? | `lead_evidence_current` rows with `confidence = 'confirmed_fact'` (an authoritative primary source, taken at face value) |
| What's a source-supported signal (real, but derived)? | `lead_evidence_current` rows with `confidence = 'source_supported_signal'` (e.g. an address-mismatch comparison over verified data) |
| What needs verification? | `lead_evidence_current` rows with `confidence IN ('hypothesis','unverified')`, or `needs_human_review = TRUE` on any current row (see §10) |
| What's missing entirely? | No current `lead_evidence` row for an expected `field_name` — absence, not a special value (see §10) |
| Why might this be worth investigating? | `lead_records.rationale` (generated, always paired with the evidence rows that justify it, and itself a hypothesis, not an assertion) + `ai_enrichment_runs.output` |
| Who should work it? | `lead_records.assigned_agent_id`, `lead_records.assignment_reason` |
| What is the compliant next action? | `lead_records.next_action_code` → resolved against `compliance_playbook`, never freeform AI text |

### Lead categories

Extends the existing `distress_flags[].type` taxonomy (`tax_lien`,
`foreclosure`, `sheriff_sale`, `probate`, `code_violation`, `vacant`,
`tax_delinquent`) with the categories named in the project brief that aren't
distress *signals* so much as lead *motivations* or *owner situations*:

- `pre_foreclosure` — default/lis pendens filed, sale not yet scheduled (distinct from `foreclosure`/`sheriff_sale`, which imply an active or completed process)
- `reo` — bank/lender-owned after completed foreclosure
- `absentee_owner` — owner mailing address ≠ property address, in-state
- `out_of_area_owner` — owner mailing address ≠ property address, out-of-state
- `expired_listing` — was on-market via MLS/vendor feed, expired or withdrawn unsold
- `llc_owned` — title held by an LLC (ownership structure, not a distress signal)
- `investor_owned` — owner holds 2+ parcels or is flagged by a vendor as an investor entity
- `probate_estate` — owner deceased, estate in probate (distinct from generic `probate` flag; only used when sourced from a permitted probate/surrogate's-court feed, never inferred from a death record alone)
- `relocation_seller` — signals suggesting an owner may be relocating (an
  objectively sourced signal, e.g. a recorded address change on file — see
  §10 for what's permitted here) — evidence for this category is always
  `hypothesis` or `unverified`, **never** `confirmed_fact` or
  `source_supported_signal`, since "intent to sell" is a prediction, not a
  fact, whatever the underlying signal's own quality (§10 is explicit:
  never infer "intent to sell" as a fact, and never derive this from
  family composition, marital status, or any other prohibited inference)

`owner_type` (`individual`, `llc`, `trust`, `estate`, `investor_entity`,
`government`, `unknown`) is stored separately from category — an absentee
owner can also be an LLC, and both facts matter for how an agent approaches
the lead.

## 3. Pipeline architecture

```
Existing: ingest-nyc / ingest-nj → score-properties → properties + property_scores
                                          │
                                          ▼
                              [NEW] lead-classify (Gemini)
                              Primary extraction/classification pass.
                              Reads property + score + raw_data (never
                              lead_contacts — see §9) and writes:
                                - lead_records row (category, owner_type, draft tier)
                                - lead_evidence rows: confidence='hypothesis'
                                  for anything Gemini derived by inference,
                                  or 'source_supported_signal' when it's a
                                  direct rule-derived comparison over
                                  already-structured/sourced fields — never
                                  'confirmed_fact' (§9/§10: an AI model
                                  never writes that value)
                                          │
                                          ▼
                         confidence_score < threshold
                         OR conflicting signals (e.g. two owner-type
                            classifications disagree)
                         OR tier 1 AND dollar value above review threshold
                                    │              │
                                   yes             no
                                    │              │
                                    ▼              ▼
                    [NEW] lead-review (Claude)   lead stays as Gemini-only,
                    Second-pass reviewer.        flagged in UI as
                    Confirms, revises, or        "not reviewed"
                    rejects Gemini's draft.
                    Writes ai_enrichment_runs
                    row with run_type=
                    'second_pass_review';
                    never silently overwrites
                    the Gemini row — both are
                    kept, reviewer's verdict
                    wins for display order.
                                    │
                                    ▼
                    [EXISTING, optional] skip-trace-dispatch
                    For individual/LLC leads missing verified contact info,
                    calls the existing SkipData integration. Results land in
                    lead_contacts with confidence='confirmed' only if SkipData
                    returns a matched record; otherwise 'unverified'.
                                    │
                                    ▼
                    compliance_playbook lookup → next_action_code
                    (rule-based, keyed on category + jurisdiction;
                    never generated by the AI models)
                                    │
                                    ▼
                    Agent-facing lead workbench (Retool or CRM UI)
```

Why Gemini primary / Claude secondary, per the brief: Gemini handles the
high-volume, low-marginal-cost extraction and classification pass across
every ingested property. Claude is reserved for the cases where getting it
wrong is expensive — low confidence, conflicting signals, or high-value
tier-1 leads — matching the existing budget-conscious pattern already used
for `enrich-ai` (`limit: 20` per run).

### What Gemini/Claude are allowed to write, and what they aren't

- They may write to `lead_evidence` with `confidence` of `ai_inferred` or
  (only via `lead-review`, and only when the source document is directly
  cited) `confirmed`. `lead-classify` (Gemini) may never write `confirmed` —
  that requires either a structured public-record field already in
  `properties.raw_data`, or human/Claude-reviewer sign-off.
- They may never write directly to `next_action_code`. That's a lookup
  against `compliance_playbook`, not free text — see §5.
- Every `ai_enrichment_runs` row stores the exact prompt input reference and
  raw model output, so a disputed classification can be audited back to what
  the model actually saw.

## 4. Schema additions

See `supabase/migrations/20260915120000_ai_lead_enrichment.sql`. Summary:

- `lead_records` — one row per active lead; FK to `properties`; category,
  owner_type, tier, status, assignment, rationale, `next_action_code`.
- `lead_evidence` — the provenance ledger described above. `confidence`
  enum (`confirmed`, `ai_inferred`, `unverified`), `source_type`
  (`public_record`, `vendor_feed`, `ai_extraction`, `skip_trace`,
  `agent_input`), `source_detail` (free text citation — dataset name, doc
  ID, or agent note). Rows are immutable — enforced by a `BEFORE UPDATE OR
  DELETE` trigger, not just convention (see §9) — so a human verifying or
  correcting an AI-inferred fact is a new row with `supersedes_id` pointing
  at the one it confirms/corrects, `verified_by`/`verified_at` set at that
  row's insert time. A companion `is_current` boolean is the one
  system-managed exception (flipped `TRUE`→`FALSE` on the superseded row
  automatically, by trigger, on insert — never by application code
  directly): it turns "what's true right now for this lead" into a direct
  indexed lookup (`lead_evidence_current`, a thin view filtering on it)
  instead of scanning a field's entire correction history on every read.
  A partial unique index enforces at most one current row per
  `(lead_id, field_name)`, so an insert that forgets to set
  `supersedes_id` when superseding fails loudly instead of silently
  leaving two disagreeing "current" facts. `lead_workbench`'s fact counts
  read from `lead_evidence_current`, so a verified fact isn't
  double-counted as both confirmed and unverified.
- `ai_enrichment_runs` — audit log of every Gemini/Claude call: model,
  run_type, input reference, raw output, confidence_score,
  flagged_for_review.
- `lead_contacts` — skip-traced or agent-supplied contact info, separate
  from evidence because it carries its own compliance flags (`dnc_flag` for
  TCPA/Do-Not-Call exposure).
- `compliance_playbook` — seed lookup table mapping
  `(lead_category, jurisdiction)` → `next_action_code` + a plain-language
  compliance note. Seeded with placeholder rows for NY/NJ pre-foreclosure,
  foreclosure, and probate — **these placeholder rows are not legal advice
  and must be reviewed by JRA's counsel before any agent acts on them.**
- `lead_workbench` view — the agent-facing read model joining a lead to its
  latest confirmed evidence, latest AI rationale, and resolved next action.

RLS on every new table follows the existing pattern in
`20240101000000_initial_schema.sql`: `authenticated` gets read access (and,
for `lead_records`/`lead_contacts`, the update access an agent needs to
change status or assignment); writes from the enrichment pipeline go through
the service-role key in Edge Functions, same as `score-properties` does
today.

## 5. Compliance guardrails (non-exhaustive — route to counsel)

This is engineering guidance on where compliance hooks belong in the data
model, not legal advice. JRA's counsel should review before any of this
drives outreach:

- **TCPA / Do-Not-Call** — `lead_contacts.dnc_flag` exists specifically so
  the existing `notify-subscribers` SMS/email path (see
  `docs/make-scenarios.md` §5) can be gated per-contact, not just per-lead.
- **Pre-foreclosure/foreclosure solicitation restrictions** — several
  states (NY included, via RPAPL §1303-adjacent homeowner-protection
  provisions, and NJ's Fair Foreclosure Act) restrict how and when a
  distressed homeowner can be solicited, and some "equity purchaser"
  statutes impose specific disclosures on anyone soliciting a
  pre-foreclosure sale. `compliance_playbook` exists so these rules are
  centrally maintained and versioned, not hard-coded per script.
- **Probate/estate records** — `probate_estate` is only ever populated from
  a feed JRA has confirmed is a permitted source (per the project brief's
  "when obtained from permitted sources" qualifier). The ingestion layer for
  any probate feed must record that source in `lead_evidence.source_detail`
  so it's auditable which feed a probate lead came from.
- **Skip-trace data (SkipData)** — results are contact data, not a
  consumer-report eligibility decision, but FCRA exposure depends on how
  SkipData sources its data; confirm with counsel before this data is used
  for anything resembling a permissible-purpose determination.

## 6. What this doc does NOT do

- It does not add a Vercel dependency to this repo, and Gemini is wired as
  code but not as a live capability — `GEMINI_API_KEY` remains unset (see
  §11). No `vercel.json` — that lands only if/when the CRM-UI open
  decision (§8) resolves toward a Vercel app.
- It does not modify `ingest-nyc`, `ingest-nj`, `score-properties`, or the
  existing `enrich-ai` function. The current pipeline keeps running
  unchanged.
- It does not implement `skip-trace-dispatch` (Phase 3, still fully open —
  see §8) or any CRM UI (Phase 4).
- Outreach send is implemented as a permanent, unconditional refusal, not
  a stub to fill in later without further review — see §11.

## 7. Phased rollout

1. **Phase 0 (merged into this PR earlier):** additive schema
   (`lead_records`, `lead_evidence`, `ai_enrichment_runs`, `lead_contacts`,
   `compliance_playbook`, `lead_workbench` view).
2. **Phase 1 (this change):** the API/queue/prompt layer — 15 Edge
   Functions, the `enrichment_jobs` queue, and the Gemini/Claude prompt
   contracts. See §11 for what shipped and what's still unverified
   (principally: no `GEMINI_API_KEY` exists anywhere to actually call
   Gemini with). Supersedes the originally-planned single `lead-classify`/
   `lead-review` functions named in earlier drafts of this doc — the
   JRA-specified endpoint list (`enrichment-gemini-normalize`,
   `enrichment-gemini-brief`, `enrichment-claude-review`, etc.) is more
   granular, and this implementation follows that instead.
3. **Phase 2:** provision `GEMINI_API_KEY`, verify the Gemini/Claude call
   paths against real traffic, tune `LOW_CONFIDENCE_THRESHOLD` (currently
   `0.75`, see §11) against real output.
4. **Phase 3:** `skip-trace-dispatch` wiring to the existing SkipData
   integration (integration details — API shape, auth, rate limits — need
   to be pulled from wherever SkipData is currently configured; not present
   in this repo today).
5. **Phase 4:** `compliance_playbook` counsel review, real consent/DNC
   tracking (required before `outreach-send` can ever be unblocked — see
   §11), and the agent workbench UI (Retool, matching the existing
   `leads_dashboard` pattern, or a CRM view if JRA's CRM is Vercel-hosted —
   needs confirmation, see Open decisions).

## 8. Open decisions (need JRA sign-off before Phase 2+)

- `LOW_CONFIDENCE_THRESHOLD = 0.75` (in
  `supabase/functions/_shared/prompts/apply-gemini-output.ts`) is coded
  and used, but still the same proposed default from earlier drafts of
  this doc — needs tuning against real Gemini output once
  `GEMINI_API_KEY` exists.
- Dollar-value threshold for "high-value tier-1" mandatory Claude review —
  not implemented; `enrichment-claude-review` currently has to be called
  explicitly (e.g. by `enrichment-process` claiming a `claude_escalation`
  job) rather than auto-triggered by a value threshold.
- Where SkipData is currently integrated (this repo has no existing
  reference to it) and what its API contract looks like.
- Whether JRA's CRM UI is the existing Retool dashboard, a new Vercel app,
  or a different system — still fully open; no CRM UI code exists in this
  repo (Phase 1 is API-only).
- Final compliance-playbook content, from counsel, per category and per
  state (NY vs. NJ differ materially on foreclosure-related solicitation)
  — `counsel_reviewed` is still `false` on every seed row.
- Real consent/opt-in tracking, required before `outreach-send` can ever
  be unblocked (see §11) — no design proposed yet.

## 9. Security & Data Handling (non-negotiable)

These rules govern every phase of this blueprint, not just future ones.
Two of them are already enforced in the Phase 0 schema shipped in this
change, listed first; the rest apply once Phase 1+ code is written.

### Already enforced in Phase 0

- **No secrets in source.** This repo had no `.gitignore` before this
  change — nothing stopped a real `.env` from being committed. Added one
  that excludes `.env`/`.env.*` (keeping `.env.example`). Verified no real
  key is currently committed anywhere in the repo (checked the tracked
  `.env.example` and the three Make.com blueprint JSON exports — all
  contain only the literal placeholder `YOUR_SUPABASE_SERVICE_ROLE_KEY`,
  not a real key).
- **AI-derived fields are auditable and linked to a specific run.**
  `lead_evidence.ai_run_id` is a real foreign key to `ai_enrichment_runs`,
  enforced by a `CHECK` constraint requiring it whenever
  `source_type = 'ai_extraction'`. The earlier draft of this migration
  only had `extracted_by TEXT` (a free-text label like `'gemini'`) — that
  was a real gap against "linked to an enrichment run," not just a
  wording issue, and is fixed in this revision.
- **Reversible without deleting original evidence — DB-enforced, not just
  a convention, and efficient to query.** `lead_evidence` has a
  `BEFORE UPDATE OR DELETE` trigger (`trg_lead_evidence_immutable`) that
  fires for every role — including the service-role key Edge Functions
  use, which bypasses RLS but not triggers — and rejects every UPDATE or
  DELETE except one narrow, system-generated case: flipping `is_current`
  from `TRUE` to `FALSE` with no other column changed. That one exception
  is what makes correcting a fact efficient rather than just possible:
  inserting a new row with `supersedes_id` set fires
  `trg_lead_evidence_supersede`, which flips the superseded row's
  `is_current` off automatically, so "what's true right now" for a lead is
  a direct index lookup (`lead_evidence_current`) instead of every reader
  re-deriving it by scanning the row's full correction history and
  checking each one for a successor. A bug that tried to edit a fact's
  actual value, or to flip `is_current` the wrong way, still fails loudly
  at the database rather than silently corrupting the audit trail — and a
  write that forgets to set `supersedes_id` when superseding a field is
  caught by a partial unique index (`idx_lead_evidence_one_current_per_field`)
  rather than silently leaving two disagreeing "current" facts.
  `ai_enrichment_runs` has the analogous guard
  (`trg_ai_enrichment_runs_guard`): `DELETE` is always rejected, and
  `UPDATE` is rejected unless the only columns changing are
  `reviewed_by`/`flagged_for_review` — the model, its output, and
  everything else about a run are immutable once logged. Verified against
  a local Postgres instance: inserting without `supersedes_id` while a
  current row exists fails (the safety net), inserting with it succeeds
  and auto-flips the original to not-current while leaving every other
  column untouched, `lead_evidence_current` and `lead_workbench`'s counts
  both reflect only the current row, a direct `UPDATE`/`DELETE` attempt
  (including flipping `is_current` the wrong way, or combining it with any
  other column change) fails on `lead_evidence`, and the
  `ai_enrichment_runs` reviewed-by-only-update-succeeds /
  output-update-fails / delete-fails behavior is unchanged.
- **Never overwrite raw source data with model output.** `properties` and
  `properties.raw_data` are untouched by this migration; `lead_evidence`
  is an entirely separate table, so there's no code path by which
  enrichment can clobber an ingested fact.

### Required once Phase 1+ code is written

- **Env vars only, never inline.** `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`,
  `SKIPDATA_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ENRICHMENT_WEBHOOK_SECRET`, and
  `INTERNAL_ADMIN_EMAILS` are documented as reserved in `.env.example`
  (unset, so nothing accidentally activates before its phase is approved).
  `SUPABASE_SERVICE_ROLE_KEY` must never reach browser/client-side code —
  only `SUPABASE_ANON_KEY` is safe there, and only under RLS.
- **Minimize what reaches the LLM.** `lead-classify` (Gemini) and
  `lead-review` (Claude) read `properties` + `property_scores` (public
  record / vendor data) to classify a lead. They must not read
  `lead_contacts` — phone numbers, emails, and mailing addresses are not
  needed to classify or score a lead, so they should never be part of
  `ai_enrichment_runs.input_ref`. If a future workflow genuinely needs a
  model to see contact data (e.g. drafting outreach copy), that's a
  distinct, explicitly-scoped call — not a side effect of classification.
- **No PII/secrets in logs.** Edge Function logs (and `ai_enrichment_runs`
  rows, which are readable by any `authenticated` user per the RLS policy
  above) must never contain a full API key, a full phone number, an email
  address, or a raw vendor payload. `ai_enrichment_runs.output` should
  capture the model's classification reasoning, not a copy of whatever
  contact-bearing payload it was (correctly) never given.
- **`compliance_playbook`, not model prose, is authoritative for "what to
  do next."** Already true in Phase 0's schema (§4); restated here because
  it's the mechanism that keeps a compliance decision out of an LLM's
  hands even once Phase 1+ ships.

## 10. Fair Housing & Consumer Protection (non-negotiable)

These rules bind every phase, including Phase 0's schema. Two things are
already DB-enforced (listed first); the rest is prompt-design and process
discipline for Phase 1+, which the schema can support but can't fully
guarantee on its own — that limitation is stated plainly below rather than
implied away.

### Never, on any basis

Do not create, infer, store, score, rank, target, exclude, or personalize
outreach based on: race, color, religion, national origin, sex, gender
identity, sexual orientation, disability, familial status, age (where
prohibited or inappropriate — see caveat below), any other protected
characteristic, or any proxy designed to approximate one.

Do not infer, as a system output: divorce status (from names, online
behavior, or any unsupported signal), financial hardship, health status,
disability, immigration/nationality status, family composition,
vulnerability, or intent to sell presented as a fact.

**`age` is deliberately not in the DB blocklist below.** The instruction
itself hedges ("where prohibited or inappropriate"), which isn't something
a regex can judge — a blanket block would either miss legitimate
jurisdiction-specific uses or false-positive on unrelated fields (`stage`,
`storage_unit`, `average_*`). This one needs counsel judgment per use case,
not a blunt DB rule; flagged here so it isn't silently dropped.

### Already DB-enforced in Phase 0

- **A hard blocklist on `lead_evidence.field_name`**
  (`lead_evidence_field_name_not_prohibited`) rejects field names built
  around any of the above (`race`, `disab*`, `divorc*`, `familial_status`,
  `financial_hardship`, `health`, `immigrat*`, `vulnerab*`,
  `intent_to_sell`, etc.) at insert time, for every role. This is
  defense-in-depth, not a complete guarantee — verified against a local
  Postgres instance that it: (a) rejects `divorce_status`,
  `disability_flag`, `vulnerable_score`, `is_handicapped`, `owner_race`,
  `immigration_status`, `ethnicity_guess`, and `intent_to_sell`; (b) does
  **not** false-positive on real field names that happen to share a
  substring, e.g. `essex_county` / `middlesex_county` (both are real NJ
  counties named in `docs/data-sources.md`) despite containing "sex" —
  the leading-boundary requirement means the blocked term has to *start*
  a token, not just appear inside one. It cannot catch a proxy smuggled
  into free text — `lead_evidence.source_detail`,
  `lead_records.rationale`, or `ai_enrichment_runs.output` are all
  unstructured and unconstrained by this CHECK. That gap is a prompt-design
  and human-review problem, not a schema problem; see below.
- **`ai_extraction_never_confirmed_fact`** — a `lead_evidence` row can
  never have `source_type = 'ai_extraction'` and
  `confidence = 'confirmed_fact'` at the same time. This is the
  blueprint's opening design rule (§1: "an AI-derived field is never
  presented as a verified fact") as an actual constraint, not just a
  sentence at the top of a doc a future engineer might not read. A human
  confirming an AI-inferred value still has to go through the normal
  supersede-with-a-new-row path (§2, §4), recorded as their own act of
  verification (`source_type = 'agent_input'`), not the model vouching for
  itself.

### Permitted signals — and how they map to what's already built

The system may identify these objectively sourced, permitted business
signals (the categories and mechanisms already in §2/§4 of this doc):

| Permitted signal | Schema mechanism |
|---|---|
| Absentee-owner status from verified mailing/property-address mismatch | `lead_category = 'absentee_owner'` / `'out_of_area_owner'`, evidence at `confidence = 'source_supported_signal'` |
| Publicly recorded foreclosure indicator | `lead_category = 'pre_foreclosure'` / `'foreclosure'` / `'reo'`, evidence at `confidence = 'confirmed_fact'`, `source_type = 'public_record'` |
| Expired-listing indicator from permitted data source | `lead_category = 'expired_listing'`, `source_type = 'vendor_feed'` |
| Entity ownership from recorded ownership source | `owner_type = 'llc'/'trust'/'estate'/'investor_entity'`, `lead_category = 'llc_owned'` |
| Multi-property ownership where supported by sourced data | `lead_category = 'investor_owned'`, `confidence = 'source_supported_signal'` |
| Long ownership tenure based on verified recorded data | a `lead_evidence` row (`field_name = 'ownership_tenure_years'` or similar), `confidence = 'confirmed_fact'`, `source_type = 'public_record'` |
| Data conflicts that require human review | `lead_evidence.needs_human_review = TRUE` (§4) — set when a new current row disagrees with what it supersedes |

### Required once Phase 1+ code is written (the DB can't do this alone)

- **Prompt construction must never pass protected-characteristic data as
  input**, even incidentally (e.g. a raw vendor record that happens to
  include a religious-institution name as `owner_name` should be passed
  as an address/entity fact, not framed as a religion signal). This is a
  Phase 1 (`lead-classify`)/Phase 2 (`lead-review`) prompt-design
  requirement, not something `ai_extraction_never_confirmed_fact` or the
  field-name blocklist can verify.
- **Prompt construction must never ask the model to infer** any of the
  "never infer" list above — not "is this owner going through a divorce,"
  not "estimate financial hardship," not "guess health status." The model
  may be asked to extract and classify from `properties`/`property_scores`
  structured data only, per §3.
- **`lead_records.rationale` and `ai_enrichment_runs.output` need a
  review pass**, at least a sampling-based one, checking they don't smuggle
  a prohibited inference into prose that the field-name blocklist can't
  see (e.g. a Claude-generated rationale that reads "owner appears to be
  going through a life transition" is a euphemism for exactly what's
  banned above, even though it never touches a blocked `field_name`).
- **The five-way distinction (confirmed fact / source-supported signal /
  hypothesis / missing data / human review requirement) must be visible in
  whatever UI or CRM surface Phase 4 builds**, not just present in the
  database. `lead_workbench`'s per-bucket counts (§4) are meant to back an
  actual visual distinction — e.g. different badge colors or icons per
  bucket — not just a number nobody looks at.

## 11. Phase 1 Implementation: API, Queue, and Prompt Contracts

Ships the API/queue/prompt layer specified by JRA on top of Phase 0's
schema. Two things to be precise about up front, because "implemented"
can be overstated:

**What was actually verified.** Every SQL statement in
`20260917200000_enrichment_queue_and_review.sql` — the new enums, columns,
constraints, the `claim_enrichment_job` function, `raw_records`,
`enrichment_jobs`, `lead_review_actions`, `lead_feedback`,
`outreach_drafts`, and the `review_queue` view — was run against a local
Postgres 16 instance, including the exact INSERT/UPDATE shapes every new
Edge Function issues (idempotency conflicts, the atomic job-claim's
concurrency behavior, the approve/reject supersede pattern, the rejected-
state CHECK constraints). Every `.ts` file (14 new Edge Functions plus 5
new `_shared` modules) was typechecked with `tsc --strict` against a
hand-written Deno shim, cross-checked by running the same checker over the
repo's existing deployed functions to confirm it doesn't flag things Deno
itself wouldn't. That check caught two real bugs before they shipped: a
JSDoc comment containing a literal `*/` that would have corrupted a whole
prompt-builder file, and (carried over from Phase 0's own review) the
`needs_human_review`-under-cover-of-`is_current` mutation gap, closed here
properly with a jsonb-diff refactor instead of a manually-maintained
column whitelist (see the migration's "Trigger hardening" section).

**What was not verified: any actual Gemini or Claude API call.** No Deno
runtime exists in this environment (no `deno` binary, and the network
proxy returned 403 on the installer), and `GEMINI_API_KEY` is not
provisioned anywhere — it remains deliberately reserved-but-unset in
`.env.example`, per the Phase 2 gate in §7. `enrichment-gemini-normalize`,
`enrichment-gemini-brief`, and `enrichment-claude-review` are code-complete
and typecheck cleanly, but the actual HTTP calls to
`generativelanguage.googleapis.com` and the Anthropic API were never
exercised. Treat that code as reviewed-but-untested until Phase 2.

### What shipped

- **Schema:** `raw_records` (staging for `POST /ingest/raw-record`),
  `enrichment_jobs` (the 8-job-type queue, with `claim_enrichment_job`
  doing atomic `FOR UPDATE SKIP LOCKED` claiming — a plain
  select-then-update from application code would race under concurrent
  `enrichment-process` invocations), `lead_review_actions` (the
  approve/reject/edit/request-more-research audit log),
  `lead_feedback` (the 10 agent-feedback categories), `outreach_drafts`,
  and a `rejected` confidence value with its own
  `ai_extraction_never_rejected` CHECK — symmetric with Phase 0's
  `ai_extraction_never_confirmed_fact`: an AI model can flag a claim as
  dubious, but only a human review action can formally reject or confirm
  one.
- **15 Edge Functions:** `ingest-raw-record`, `enrichment-queue`,
  `enrichment-process` (the job dispatcher — claims a job, dispatches by
  `job_type`, marking `document_extraction` jobs immediately dead-lettered
  with a clear "not implemented" error rather than silently no-opping,
  since no document/Storage pipeline exists in this repo),
  `enrichment-retry`, `enrichment-gemini-normalize`,
  `enrichment-gemini-brief`, `enrichment-claude-review`,
  `lead-intelligence` (GET), `lead-request-review`,
  `lead-approve-ai-suggestion`, `lead-reject-ai-suggestion`,
  `outreach-draft`, `outreach-approve`, `outreach-send`, and
  `leads-feedback` (not in the original endpoint list, but "store
  [agent] feedback for later prompt and rule evaluation" needs an
  endpoint to land on, so one was added).
- **`outreach-send` is a permanent refusal, not a stub.** Per the
  instruction not to implement send behavior until consent/approval
  controls are verified: it always returns `403` naming the specific
  reasons (no consent/opt-in table exists at all, `lead_contacts.dnc_flag`
  is never read by any code path, every `compliance_playbook` row is
  still `counsel_reviewed = false`). Approving a draft
  (`outreach-approve`) does not change this — approval and consent
  verification are different gates.
- **Prompt contracts** in `supabase/functions/_shared/prompts/`:
  `gemini-enrichment.ts` carries the JRA-specified system instruction and
  response schema verbatim; `claude-escalation.ts` carries Claude's system
  instruction verbatim, but its response JSON schema is this repo's own
  design (the spec gave Claude's instruction without an explicit schema —
  flagged in the file itself for JRA sign-off before Phase 2). Both are
  versioned (`GEMINI_PROMPT_VERSION`, `CLAUDE_ESCALATION_PROMPT_VERSION`)
  and every `ai_enrichment_runs` row records which version produced it.
- **A deliberate mapping decision worth knowing about:** Gemini's own
  response schema calls one of its output buckets `confirmed_facts` — but
  those are never written as new `lead_evidence` rows (they're Gemini's
  reflection of facts already in its input, and an AI model is never
  allowed to author a `confirmed_fact` row regardless of what it calls
  itself). Gemini's `source_supported_signals` are written to
  `lead_evidence`, but at `confidence = 'hypothesis'`, not
  `'source_supported_signal'` — this repo's confidence taxonomy is a
  statement about what our system trusts, not a pass-through of a model's
  own label for its output. See
  `supabase/functions/_shared/prompts/apply-gemini-output.ts` for the full
  reasoning.
- **`outreach-draft` never calls an LLM.** No prompt contract was
  specified for outreach copy generation, and per §9, a model call needing
  contact-adjacent context should be "a distinct, explicitly-scoped call,"
  not folded into drafting. It templates from the already-vetted
  `suggested_outreach_angle` (itself constrained by the Gemini prompt
  contract to be grounded only in confirmed/source-supported evidence)
  plus the resolved `compliance_playbook` entry, and never reads
  `lead_contacts` values.
