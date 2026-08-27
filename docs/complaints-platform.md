# BT Capital — Investor Complaint Platform

Front-facing complaint intake for a FINRA-registered Reg CF funding portal,
meeting Funding Portal Rule 300(c) and FINRA Rule 4513/4530-style complaint
handling requirements. Built on the same Supabase / Make.com / Retool stack
as the rest of this repo, as an independent module (`complaints*` tables and
functions) — it does not touch the property lead-gen pipeline.

## Architecture

```
WordPress/Elementor Form (/investor-complaints)
  │  Elementor Forms → Webhook action
  ▼
Make.com Scenario: Complaint Intake → Escalation → Reporting
  │  server-side re-validation, keyword flagging, routing
  ▼
Supabase Edge Functions (Deno/TypeScript)
  │  complaint-intake → complaint-escalation-check → complaint-quarterly-report
  ▼
Supabase PostgreSQL
  │  complaints, complaint_escalation_alerts
  ▼
Retool Dashboard
     compliance officer / principal review, FINRA due-date badges
```

## 1. WordPress/Elementor Form

Embed as a page (`/investor-complaints`), linked from the investor dashboard
footer and every transaction confirmation email.

| # | Field | Type | Required | Maps to |
|---|---|---|---|---|
| 1 | Full legal name | text | yes | `complainant_name` |
| 2 | Mailing address | text | yes | `complainant_address` |
| 3 | BT Capital account number | text | yes | `account_number` |
| 4 | Email | email | yes | `email` |
| 5 | Phone | tel | no | `phone` |
| 6 | Date of incident/issue | date | yes | `date_of_incident` |
| 7 | Category (dropdown) | select | yes | `category` |
| 8 | Associated representative involved? | text | no | `associated_person` |
| 9 | Description of complaint | textarea (min 50 chars) | yes | `description` |
| 10 | Supporting documents | file (PDF/JPG/PNG, max 10MB) | no | `supporting_doc_url` (upload to storage first, pass the URL) |
| 11 | Preferred resolution/outcome | textarea | no | `preferred_resolution` |
| 12 | Consent checkbox | checkbox | yes | `consent_acknowledged` |

Category values (`category`): `investment_dispute`, `fund_disbursement`,
`unauthorized_fraud`, `misrepresentation`, `technical`, `other`.

**No client-side-only validation.** `complaint-intake` re-checks every
required field, the 50-character description minimum, email format, and
consent — a bypassed or scripted form submission is rejected with a 422 and
a list of the missing/invalid fields.

## 2. Make.com Scenario — Complaint Intake → Escalation → Reporting

```
[Elementor Forms Webhook]
  └─▶ HTTP POST → complaint-intake
        URL: https://<project>.supabase.co/functions/v1/complaint-intake
        Headers: { x-make-secret: {{env.MAKE_WEBHOOK_SECRET}} }
        Body: form fields mapped to the table above
  └─▶ [Router]
        Branch A (success): reply to submitter with reference_number
                             ("logged, response within 15 business days")
        Branch B (422 / validation error): notify site admin — form bypass attempt
```

`complaint-intake` itself:
- Flags `involves_theft_misappropriation_forgery` when category is
  `unauthorized_fraud` or the description contains `theft`, `stolen`,
  `steal`, `misappropriat*`, or `forg*` — starts the FINRA Rule 4530 30-day
  clock (`finra_report_due_date`) via a DB trigger and posts an immediate
  alert to `COMPLIANCE_ALERT_WEBHOOK`.
- Flags `escrow_agent_responsible` for `fund_disbursement` complaints and
  alerts `ESCROW_AGENT_ALERT_WEBHOOK` — BT Capital cannot hold investor
  funds directly (FP Rule 300(c)(2)(iv)), so disbursement complaints are
  routed to the qualified third-party escrow agent for response
  coordination.
- Sends the complainant confirmation via `COMPLAINANT_CONFIRMATION_WEBHOOK`.

### Manual entry for non-web complaints

Every complaint received by phone, email, or social DM should be entered
into the same system so there's one system of record — don't let complaints
live in inboxes. Call `complaint-intake` directly (or insert via Retool)
with `intake_channel` set to `email` / `phone` / `social_dm` / `other`,
`entered_by` set to the staff member logging it, and `is_written` set to
`false` for a phone-only complaint with no written record (Rule 4513 only
treats written complaints as reportable).

## 3. Nightly Scenario — Escalation & Retention Housekeeping

```
[Schedule trigger — nightly]
  └─▶ HTTP POST → complaint-escalation-check
        Body: {} (empty JSON)
  └─▶ [Router]
        Branch A (alertsSent > 0): log to compliance tracker
        Branch B (errors > 0):     alert admin
```

`complaint-escalation-check`:
- Sends day-15 and day-25 reminders, and a day-30 overdue alert, to
  `COMPLIANCE_ALERT_WEBHOOK` for any flagged complaint not yet
  `reported_finra` — each alert is logged in `complaint_escalation_alerts`
  so a re-run never double-sends.
- Runs `archive_old_complaints()`: moves complaints older than 2 years to
  the `cold_storage` tier. Rows are never deleted — FINRA Rule 4513
  requires 4-year minimum retention (2-year readily accessible).

## 4. Quarterly FINRA Gateway Report

```
[Schedule trigger — 1st of month after quarter close: Apr 1 / Jul 1 / Oct 1 / Jan 1]
  └─▶ HTTP POST → complaint-quarterly-report
        Body: {} (defaults to the most recently closed quarter)
  └─▶ Generate CSV/PDF (Make.com Google Sheets / PDF module) from the JSON response
  └─▶ Email compliance officer with the file-by date and copies-required checklist
```

Filing deadline is the 15th calendar day after quarter close (Apr 15 / Jul
15 / Oct 15 / Jan 15) — running the scenario on the 1st gives two weeks of
lead time. Consult FINRA/securities counsel before the first live filing to
confirm the Gateway submission format.

## 5. Retool Dashboard

Connect Retool to Supabase using the built-in Supabase resource connector.

| Retool View | Supabase View/Table |
|---|---|
| All Complaints | `complaints_dashboard` (filter by `status`, `category`) |
| FINRA 30-Day Clock | `complaints_finra_clock` — red/yellow/green via `finra_due_badge` |
| Escrow-Responsible | `complaints_escrow_responsible` |
| Dashboard Summary | `complaints_summary` |
| Quarterly Report | `complaints_quarterly_report` |

Detail view per complaint should write `resolution_summary`, `resolved_at`,
and `status` back to `complaints`. A "Mark as reported to FINRA" action sets
`finra_reported_at = now()` and `status = 'reported_finra'`.

## Environment Variables

See `.env.example` for the full list. Complaint-platform-specific:

```
COMPLIANCE_ALERT_WEBHOOK        = Make.com webhook — compliance officer alerts
ESCROW_AGENT_ALERT_WEBHOOK      = Make.com webhook — escrow agent notifications
COMPLAINANT_CONFIRMATION_WEBHOOK = Make.com webhook — auto-reply to complainant
```
