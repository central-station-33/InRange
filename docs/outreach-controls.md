# Outreach Controls

The AI pipeline must never autonomously:

- Send an email
- Send an SMS
- Place a call
- Leave a voicemail
- Add a lead to a campaign
- Change consent status
- Change DNC status
- Mark a person as contactable
- Opt a person in or out
- Assign a lead permanently
- Create legal, financial, title, or credit conclusions

All external communications require:

- Valid campaign eligibility check
- Consent/DNC check
- Human agent approval
- Activity logging
- Opt-out processing where applicable

## How this is enforced in code

| Requirement | Implementation |
|---|---|
| Campaign eligibility check | `checkCampaignEligibility()` in `supabase/functions/_shared/outreachControls.ts` — active subscriber, tier within `min_tier`, market targeted. Also gated upstream by the `campaign_eligible_properties` view, which excludes any property whose AI enrichment landed in the `human_review` confidence band. |
| Consent/DNC check | `checkConsent()` in the same file — requires `consent_status = 'opted_in'`, `dnc = false`, and `contactable = true` on the subscriber. All three default to "not contactable" (`consent_status='unknown'`, `contactable=false`). |
| Human agent approval | `notify-subscribers` only ever inserts `notifications` rows with `status='pending_approval'` or `status='blocked'` — it never sends anything. `approve-notification` is the single function that can transition a notification to `sent`, and it rejects any call whose `agent` field is missing or is an automated-sounding identifier (`requireHumanActor()`). |
| Activity logging | Every eligibility decision, approval, rejection, and delivery attempt is written to `activity_log` via `logActivity()`. |
| Opt-out processing | `process-opt-out` processes a contact's own explicit stop/unsubscribe signal (never an AI-initiated decision) and sets `consent_status='opted_out'`, `dnc=true`, `contactable=false`. |
| No permanent lead assignment / legal-financial conclusions | Not implemented anywhere in this codebase — `ai_summary` is explicitly scoped to a descriptive investment memo, and there is no lead-assignment or legal/credit-conclusion feature for the AI to reach into. |

## Delivery flow

```
notify-subscribers          approve-notification (human-gated)
  │ eligibility + consent      │ re-checks consent/DNC/eligibility
  │ checks, activity_log        │ requires agent identifier
  ▼                             ▼
notifications                notifications.status = sent | failed | rejected | blocked
  status = pending_approval    + activity_log entry
  or blocked
```

Nothing between `score-properties` and `approve-notification` can dispatch a
message. Make.com's role stops at *queuing* work (via `notify-subscribers`)
and *relaying* an already-approved payload (via `MAKE_NOTIFY_WEBHOOK`, called
only from inside `approve-notification`).
