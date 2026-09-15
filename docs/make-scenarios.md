# Make.com Scenarios

All scenarios live at us2.make.com and call Supabase Edge Functions via HTTP POST.
Add `x-make-secret: <MAKE_WEBHOOK_SECRET>` to every HTTP module.

---

## 1 — Ingest NYC (Schedule: Daily, 3 AM ET)

```
[Schedule trigger]
  └─▶ HTTP POST → ingest-nyc
        URL: https://<project>.supabase.co/functions/v1/ingest-nyc
        Headers: { x-make-secret: {{env.MAKE_WEBHOOK_SECRET}} }
        Body: {} (empty JSON)
  └─▶ [Router]
        Branch A (success): Log to Google Sheets / Slack
        Branch B (error):   Send alert email to admin
```

---

## 2 — Ingest NJ (Schedule: Daily, 3:30 AM ET)

```
[Schedule trigger]
  └─▶ HTTP POST → ingest-nj
        URL: https://<project>.supabase.co/functions/v1/ingest-nj
        Headers: { x-make-secret: {{env.MAKE_WEBHOOK_SECRET}} }
        Body: {} (empty JSON)
  └─▶ [Router] — same success/error branches as NYC
```

**Sheriff Sale supplement (optional):**
Add county-specific HTTP modules that scrape or fetch sheriff sale CSVs,
then include a `sheriff_sales` array in the ingest-nj POST body:

```json
{
  "sheriff_sales": [
    {
      "county": "HUDSON",
      "parcel_id": "09-12345-00001",
      "address": "123 Main St",
      "city": "Jersey City",
      "zip": "07302",
      "owner_name": "John Smith",
      "sale_date": "2024-03-15",
      "case_number": "F-12345-23"
    }
  ]
}
```

---

## 3 — Score Properties (Trigger: after Ingest NYC or NJ completes)

```
[Webhook — triggered by scenario 1 or 2 on success]
  └─▶ HTTP POST → score-properties
        Body: { "limit": 500 }
```

Or chain it directly with a Sleep module after each ingest:

```
[HTTP ingest-nyc] → [Sleep 5s] → [HTTP score-properties]
```

---

## 4 — AI Enrichment (Schedule: Daily, 6 AM ET)

Runs after scoring. Gemini runs first-pass on every Tier 1–2 property;
Claude is only invoked when `enrich-ai` decides to escalate (see
`docs/model-routing.md`), so per-run Claude cost scales with how many
records actually escalate, not with `limit`.

```
[Schedule trigger]
  └─▶ HTTP POST → enrich-ai
        Body: { "limit": 20, "min_tier": 1, "max_tier": 2 }
  └─▶ [Router]
        success: Log enriched / escalated_to_claude counts
        error:   Alert admin
```

---

## 5 — Notify Subscribers (Schedule: Daily, 7 AM ET)

Runs after enrichment. This scenario only **queues** candidate
notifications — it never sends anything. Every subscriber/property match
gets a campaign-eligibility and consent/DNC check; eligible matches are
inserted as `notifications.status = 'pending_approval'`, everything else as
`status = 'blocked'`. See `docs/outreach-controls.md`.

```
[Schedule trigger]
  └─▶ HTTP POST → notify-subscribers
        Body: { "max_tier": 2, "limit": 100 }
  └─▶ [Router]
        Branch A (queued > 0): Notify human agents a review queue is ready
        Branch B (error):      Alert admin
```

---

## 6 — Approve & Send (human-triggered, not scheduled)

A human agent reviews `pending_approval` notifications (e.g. in Retool,
against the `notifications` table) and calls `approve-notification` with
their own identifier. This is the only scenario allowed to result in an
actual email/SMS/webhook send.

```
[Retool "Approve" / "Reject" button]
  └─▶ HTTP POST → approve-notification
        Body: { "notification_id": "<uuid>", "decision": "approve", "agent": "<human agent email/id>" }
  └─▶ [Router]
        success (status=sent):   done
        success (status=blocked): surface block_reason to the agent
        error:                    alert admin
```

`approve-notification` re-checks consent/DNC/eligibility at send time, then
posts the payload to `MAKE_NOTIFY_WEBHOOK` (or the subscriber's own
`webhook_url`). Build a "Notifications Router" scenario listening on
`MAKE_NOTIFY_WEBHOOK`:

```
[Custom Webhook]
  └─▶ [Router]
        Branch: email IS NOT NULL
          └─▶ Gmail / SendGrid — send lead email
        Branch: phone IS NOT NULL
          └─▶ Twilio — send SMS alert
```

## 7 — Opt-Out Processing (Trigger: inbound STOP/unsubscribe)

Wire Twilio inbound "STOP" replies and any unsubscribe-link webhook to
`process-opt-out`. This is rule-based processing of the contact's own
request, not an autonomous AI decision.

```
[Twilio inbound webhook / unsubscribe link]
  └─▶ HTTP POST → process-opt-out
        Body: { "phone": "{{trigger.From}}", "source": "sms_stop" }
```

---

## Environment Variables in Make.com

Store `MAKE_WEBHOOK_SECRET` in Make.com → Organization → Variables
and reference it as `{{env.MAKE_WEBHOOK_SECRET}}` in HTTP modules.
