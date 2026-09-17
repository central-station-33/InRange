# Model Strategy

## Gemini is the primary production enrichment model

Used for high-volume tasks — in this codebase, that's the first-pass
structured extraction/classification that runs on every Tier 1–2 property in
`enrich-ai`: an investment summary, a confidence score, an estimated deal
value, and flags for source conflicts, complex ownership, related
properties, and LLC/unclear-beneficial-ownership.

Gemini output must be structured JSON that validates against an
application-owned schema — see `GEMINI_RESPONSE_SCHEMA` in
`supabase/functions/enrich-ai/index.ts`.

## Claude is a selective escalation model

Used only when one or more escalation conditions applies:

- Estimated deal value is above `CLAUDE_ESCALATION_DEAL_VALUE_THRESHOLD` (default $400,000)
- Lead priority is Tier 1 ("A") or manually marked strategic
- Gemini confidence is lower than 0.80
- Two authoritative source records conflict
- Ownership/entity chain is complex
- The lead has multiple related properties
- The lead is an LLC with unclear beneficial/contact ownership
- An agent requests a detailed seller/investor strategy brief (`agent_requested: true` in the request body)
- A record needs a second-pass quality review (`second_pass: true` in the request body)

Implemented in `shouldEscalateToClaude()` in
`supabase/functions/_shared/modelRouting.ts`. Gemini and Claude are never
both run on a record by default — `enrich-ai` calls Claude only when
`shouldEscalateToClaude()` returns a reason, and that reason is stored in
`property_scores.escalation_reason` for audit.

## Model routing policy

Default routing, as implemented in `enrich-ai`:

1. Deterministic source validation — handled upstream by `score-properties` (composite scoring, tiering) before enrichment ever runs.
2. Gemini extraction and first-pass classification — always runs for Tier 1–2 properties.
3. Rule-based data validation — `shouldEscalateToClaude()`.
4. Claude escalation only when rules require it.
5. Human review if models conflict materially or confidence remains low — enforced by `review_status` and the `campaign_eligible_properties` view (below).

### Confidence thresholds

| Confidence | `review_status` | Effect |
|---|---|---|
| 0.90 – 1.00 | `auto_accepted` | Eligible for automated internal enrichment acceptance |
| 0.80 – 0.89 | `agent_review` | Enrichment created, flagged for normal agent review |
| 0.70 – 0.79 | `claude_review` | Escalated to Claude (this band is itself one of the escalation triggers) |
| < 0.70 | `human_review` | Human-review queue; **excluded from campaign eligibility** |

Implemented in `classifyReviewStatus()` (`_shared/modelRouting.ts`) and
enforced at the outreach layer by the `campaign_eligible_properties` SQL
view, which filters out any property whose latest `review_status` is
`human_review` or still `pending`.

Any conflict in core ownership, address, contact, consent, DNC, lien,
court, or legal record fields still requires human review — this codebase
surfaces `sources_conflict` from Gemini as an escalation trigger to Claude,
but a Claude review is not a substitute for human sign-off on those fields;
nothing in this pipeline writes consent/DNC/legal conclusions automatically
(see `docs/outreach-controls.md`).
