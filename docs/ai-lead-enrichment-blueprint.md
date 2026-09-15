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
| What is confirmed? | `lead_evidence` rows with `confidence = 'confirmed'` (sourced from a public record, vendor feed, or human verification) |
| What needs verification? | `lead_evidence` rows with `confidence IN ('ai_inferred','unverified')` |
| Why might this be worth investigating? | `lead_records.rationale` (generated, always paired with the evidence rows that justify it) + `ai_enrichment_runs.output` |
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
- `relocation_seller` — signals suggesting an owner may be relocating (new job filing, address change on file, etc.) — always `ai_inferred` or `unverified`, never `confirmed`, since it's a prediction

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
                              Reads property + score + raw_data, writes:
                                - lead_records row (category, owner_type, draft tier)
                                - lead_evidence rows, confidence='ai_inferred'
                                  for anything Gemini derived from raw_data
                                  that wasn't already a structured field
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
  ID, or agent note), optional `verified_by` / `verified_at` for the human
  sign-off path.
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

- It does not add a Gemini or Vercel dependency to this repo. No SDK, no
  `GEMINI_API_KEY` reference, no `vercel.json` — those land when Phase 2 is
  approved (see below).
- It does not modify `ingest-nyc`, `ingest-nj`, `score-properties`, or the
  existing `enrich-ai` function. The current pipeline keeps running
  unchanged; `lead_records` is populated by a new, separate function once
  built.
- It does not implement `lead-classify`, `lead-review`, or
  `skip-trace-dispatch` as code. Those are Phase 2/3 below.

## 7. Phased rollout

1. **Phase 0 (this change):** additive schema (`lead_records`,
   `lead_evidence`, `ai_enrichment_runs`, `lead_contacts`,
   `compliance_playbook`, `lead_workbench` view). No pipeline changes.
2. **Phase 1:** `lead-classify` Edge Function (Gemini) that backfills
   `lead_records`/`lead_evidence` for existing `properties` rows above
   Tier 3, following the `enrich-ai` function's conventions (service-role
   client, Make.com-triggered, batch `limit`). Requires
   `GEMINI_API_KEY` secret — approval + budget sign-off first.
3. **Phase 2:** `lead-review` Edge Function (Claude second-pass), triggered
   for the confidence/conflict/high-value cases in §3. Reuses the existing
   `ANTHROPIC_API_KEY` secret already in `.env.example`.
4. **Phase 3:** `skip-trace-dispatch` wiring to the existing SkipData
   integration (integration details — API shape, auth, rate limits — need
   to be pulled from wherever SkipData is currently configured; not present
   in this repo today).
5. **Phase 4:** `compliance_playbook` counsel review and agent workbench UI
   (Retool, matching the existing `leads_dashboard` pattern, or a CRM view
   if JRA's CRM is Vercel-hosted — needs confirmation, see Open decisions).

## 8. Open decisions (need JRA sign-off before Phase 1+)

- Confidence-score threshold for routing to Claude second-pass (proposed
  default: `< 0.75`, tune after real Gemini output is seen).
- Dollar-value threshold for "high-value tier-1" mandatory review.
- Where SkipData is currently integrated (this repo has no existing
  reference to it) and what its API contract looks like.
- Whether JRA's CRM UI is the existing Retool dashboard, a new Vercel app,
  or a different system — the brief says "existing CRM/UI conventions in
  this repository," but no CRM UI code currently exists here beyond the
  Retool view contract in the README.
- Final compliance-playbook content, from counsel, per category and per
  state (NY vs. NJ differ materially on foreclosure-related solicitation).
