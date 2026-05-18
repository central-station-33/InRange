# Make.com Scenarios

All scenarios live at us2.make.com and call Supabase Edge Functions via HTTP POST.
Add `x-make-secret: <MAKE_WEBHOOK_SECRET>` to every HTTP module.

---

## Property Pipeline (Existing — scenarios 1–5)

### 1 — Ingest NYC (Schedule: Daily, 3 AM ET)

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

### 2 — Ingest NJ (Schedule: Daily, 3:30 AM ET)

```
[Schedule trigger]
  └─▶ HTTP POST → ingest-nj
  └─▶ [Router] — same success/error branches as NYC
```

### 3 — Score Properties (Webhook — triggered by scenario 1 or 2)

```
[Webhook]
  └─▶ HTTP POST → score-properties
        Body: { "limit": 500 }
```

### 4 — AI Enrichment (Schedule: Daily, 6 AM ET)

```
[Schedule trigger]
  └─▶ HTTP POST → enrich-ai
        Body: { "limit": 20, "min_tier": 1, "max_tier": 2 }
```

### 5 — Notify Subscribers (Schedule: Daily, 7 AM ET)

```
[Schedule trigger]
  └─▶ HTTP POST → notify-subscribers
        Body: { "max_tier": 2, "limit": 100 }
  └─▶ [Custom Webhook — Notifications Router]
        Branch: email IS NOT NULL → Gmail / SendGrid
        Branch: phone IS NOT NULL → Twilio SMS
```

---

## ISA Lead Pipeline (New — scenarios 6–13)

All ISA scenarios post leads to `ingest-leads`, which upserts into the `leads` table.
Enrichment (scenario 11) and ISA notification (scenario 12) run after ingestion.

---

### 6 — Prospect Athletes (Schedule: Daily, 4 AM ET)

Pulls ESPN roster transactions for all NY/NJ teams using the Apify actor.

```
[Schedule trigger]
  └─▶ Apify: Run Actor — crawlerbros/espn-rosters-player-stats
        Input: {
          "leagues": ["nfl", "nba", "mlb", "nhl", "mls", "wnba"],
          "teams": [
            "nyg", "nyj",          // NFL
            "ny",  "bkn",          // NBA
            "nyy", "nym",          // MLB
            "nyr", "nyi", "njd",   // NHL
            "nycfc", "rbny"        // MLS
          ],
          "season": {{now.year}},
          "fetchPlayerStats": false,
          "maxItems": 200
        }
  └─▶ [Iterator] — loop over each player transaction
  └─▶ [Filter] — keep only: transaction_type IN ("signed", "traded", "drafted", "claimed")
                           AND team_city IN ("New York", "New Jersey", "Brooklyn")
  └─▶ [Tools: Set variable] — build lead object:
        {
          "segment": "athlete",
          "market": "nyc",
          "full_name": "{{item.player_name}}",
          "team_name": "{{item.team}}",
          "sport": "{{item.league}}",
          "contract_value": {{item.salary ?? null}},
          "motivation_signals": ["New signing — relocating to NY/NJ market"],
          "source_name": "ESPN Transactions",
          "source_url": "https://www.espn.com/{{item.league}}/transactions",
          "routing": "new",
          "outreach_status": "new",
          "raw_data": {{item}}
        }
  └─▶ [Array aggregator] — collect all leads into array
  └─▶ HTTP POST → ingest-leads
        Body: {
          "segment": "athlete",
          "market": "nyc",
          "leads": {{aggregated_array}}
        }
```

**Agent contact enrichment (after ingest):**
For each athlete lead returned with no rep_phone, run a separate branch:
```
  └─▶ Apify: RAG Web Browser
        Query: "{{lead.full_name}} NFL agent 2026 site:spotrac.com OR site:profootballrumors.com"
  └─▶ [Tools: Set variable] — parse agent name, agency from result text
  └─▶ HTTP PATCH → ingest-leads  (update rep fields only)
```

---

### 7 — Prospect Motivated Sellers (Schedule: Daily, 4:30 AM ET)

Scrapes Zillow for long-DOM and off-market listings in target NYC/NJ zips.

```
[Schedule trigger]
  └─▶ Apify: Run Actor — sovereigntaylor/zillow-scraper
        Input: {
          "listingType": "for_sale",
          "location": "New York, NY",
          "maxResults": 100,
          "scrapeDetails": true
        }
  └─▶ [Iterator]
  └─▶ [Filter] — keep: daysOnMarket >= 60 OR listingStatus == "off_market"
  └─▶ [Tools: Set variable] — build lead:
        {
          "segment": "motivated_seller",
          "market": "nyc",
          "full_name": "{{item.ownerName}}",
          "phone": "{{item.ownerPhone ?? null}}",
          "property_address": "{{item.address}}",
          "motivation_signals": ["{{item.daysOnMarket}} days on market", "{{item.listingStatus}}"],
          "source_name": "Zillow",
          "source_url": "{{item.url}}",
          "routing": "new",
          "outreach_status": "new",
          "raw_data": {{item}}
        }
  └─▶ [Array aggregator]
  └─▶ HTTP POST → ingest-leads
        Body: { "segment": "motivated_seller", "market": "nyc", "leads": [...] }
```

Repeat with `location: "New Jersey"` and `market: "nj"` in a second branch.

---

### 8 — Prospect Motivated Sellers NJ (Schedule: Daily, 4:35 AM ET)

Same as Scenario 7 with `location: "New Jersey"` and `market: "nj"`.

---

### 9 — Prospect Film & TV Productions (Schedule: Weekly, Monday 5 AM ET)

Scrapes the NYC Mayor's Office of Media & Entertainment permit feed.

```
[Schedule trigger]
  └─▶ Apify: RAG Web Browser
        Query: "NYC film permit applications this week site:nyc.gov/mome"
        OR fetch URL: https://www.nyc.gov/assets/mome/pdf/production_guide/film_permit_tips.pdf
  └─▶ [Text parser / regex] — extract: production_name, company, location, dates
  └─▶ [Iterator]
  └─▶ [Tools: Set variable] — build lead:
        {
          "segment": "film_tv",
          "market": "nyc",
          "entity_name": "{{item.production_company}}",
          "production_name": "{{item.show_or_film_name}}",
          "property_address": "{{item.filming_location}}",
          "motivation_signals": ["Active NYC film permit", "Housing needed for cast/crew"],
          "source_name": "NYC MOME Film Permits",
          "routing": "new",
          "outreach_status": "new",
          "raw_data": {{item}}
        }
  └─▶ HTTP POST → ingest-leads
        Body: { "segment": "film_tv", "market": "nyc", "leads": [...] }
```

**LinkedIn follow-up (in same scenario):**
```
  └─▶ Apify: LinkedIn People Search — powerai/linkedin-peoples-search-scraper
        Input: {
          "title": "housing coordinator",
          "company": "{{item.production_company}}",
          "geocode_location": "New York"
        }
  └─▶ Patch lead with rep_name, linkedin_url from result
```

---

### 10 — Prospect Expat / Corporate Relocations (Schedule: Weekly, Monday 5:30 AM ET)

```
[Schedule trigger]
  └─▶ Apify: RAG Web Browser
        Query: "company relocating headquarters to New York OR New Jersey 2026 site:businesswire.com OR prnewswire.com"
  └─▶ [Text parser] — extract company name, announcement date, new location
  └─▶ [Iterator]
  └─▶ Apify: LinkedIn People Search
        Input: {
          "title": "relocation coordinator OR HR director",
          "company": "{{item.company_name}}",
          "geocode_location": "New York"
        }
  └─▶ [Tools: Set variable] — build lead:
        {
          "segment": "expat_relocation",
          "market": "nyc",
          "entity_name": "{{item.company_name}}",
          "employer": "{{item.company_name}}",
          "rep_name": "{{linkedin.full_name}}",
          "rep_email": "{{linkedin.email ?? null}}",
          "linkedin_url": "{{linkedin.profile_url}}",
          "motivation_signals": ["Corporate relocation announcement", "New office in NY/NJ"],
          "source_name": "PR Newswire / BusinessWire",
          "source_url": "{{item.article_url}}",
          "routing": "new",
          "outreach_status": "new",
          "raw_data": {{item}}
        }
  └─▶ HTTP POST → ingest-leads
        Body: { "segment": "expat_relocation", "market": "nyc", "leads": [...] }
```

---

### 11 — Enrich ISA Leads (Schedule: Daily, 6:30 AM ET — after ingestion runs)

```
[Schedule trigger]
  └─▶ HTTP POST → enrich-leads
        Body: { "limit": 50 }
        Headers: { x-make-secret: {{env.MAKE_WEBHOOK_SECRET}} }
  └─▶ [Router]
        success: Log enriched count to Slack
        error:   Alert admin
```

---

### 12 — Notify ISAs — Hot Leads (Schedule: Daily, 7:30 AM ET)

```
[Schedule trigger]
  └─▶ HTTP POST → notify-isa
        Body: { "routing": "hot", "limit": 20 }
  └─▶ [Custom Webhook — ISA Notifications Router]
        Body received contains: lead_id, segment, name, contact,
                                ai_summary, talking_points, sms_message
        Branch A: assigned_isa IS NOT NULL AND phone present
          └─▶ Twilio SMS → ISA phone: "New HOT lead assigned: {{name}} [{{segment}}]"
        Branch B: assigned_isa IS NOT NULL AND email present
          └─▶ Gmail/SendGrid → ISA email with full lead card
        Branch C: unassigned
          └─▶ Slack #isa-leads channel → full lead card for team to claim
```

---

### 13 — Notify ISAs — Warm Leads (Schedule: Daily, 8 AM ET)

Same as Scenario 12 with `"routing": "warm"`. Routed to Slack only (not SMS).

---

## Environment Variables in Make.com

Store in Make.com → Organization → Variables:

| Variable | Description |
|----------|-------------|
| `MAKE_WEBHOOK_SECRET` | Shared secret for all Supabase Edge Function calls |
| `MAKE_ISA_WEBHOOK` | Webhook URL for the ISA Notifications Router scenario |
| `APIFY_API_TOKEN` | Apify API token for running actors |

Reference as `{{env.VARIABLE_NAME}}` in all HTTP modules.

---

## Supabase Edge Function URLs

All functions follow the pattern:
```
https://<project-ref>.supabase.co/functions/v1/<function-name>
```

| Function | Scenario(s) |
|----------|------------|
| `ingest-nyc` | 1 |
| `ingest-nj` | 2 |
| `score-properties` | 3 |
| `enrich-ai` | 4 |
| `notify-subscribers` | 5 |
| `ingest-leads` | 6, 7, 8, 9, 10 |
| `enrich-leads` | 11 |
| `notify-isa` | 12, 13 |
