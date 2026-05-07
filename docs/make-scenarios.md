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

Runs after scoring. Processes up to 20 Tier 1–2 properties per run to
manage Anthropic API costs (adjust `limit` as needed).

```
[Schedule trigger]
  └─▶ HTTP POST → enrich-ai
        Body: { "limit": 20, "min_tier": 1, "max_tier": 2 }
  └─▶ [Router]
        success: Log enriched count
        error:   Alert admin
```

---

## 5 — Notify Subscribers (Schedule: Daily, 7 AM ET)

Runs after enrichment. Sends notifications to matched subscribers.

```
[Schedule trigger]
  └─▶ HTTP POST → notify-subscribers
        Body: { "max_tier": 2, "limit": 100 }
  └─▶ [Router]
        Branch A (sent > 0): Log to CRM / Sheets
        Branch B (error):    Alert admin
```

### Handling notifications in Make.com

The `notify-subscribers` function posts payloads to `MAKE_NOTIFY_WEBHOOK`.
Build a separate "Notifications Router" scenario listening on that webhook:

```
[Custom Webhook]
  └─▶ [Router]
        Branch: email IS NOT NULL
          └─▶ Gmail / SendGrid — send lead email
        Branch: phone IS NOT NULL
          └─▶ Twilio — send SMS alert
```

---

## Environment Variables in Make.com

Store `MAKE_WEBHOOK_SECRET` in Make.com → Organization → Variables
and reference it as `{{env.MAKE_WEBHOOK_SECRET}}` in HTTP modules.
