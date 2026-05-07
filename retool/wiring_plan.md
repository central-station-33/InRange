# InRange Retool Dashboard – Wiring Plan

## 0. Prerequisites

1. **Add Supabase resource** in Retool → Resources → New Resource → PostgreSQL
   - Host: `aws-0-us-west-2.pooler.supabase.com`
   - Port: `5432`
   - Database: `postgres`
   - Username: `postgres.omzugrtgwsjypekuzgtn`
   - Password: (your Supabase DB password from project Settings → Database)
   - Name the resource: **`InRange Supabase`**
   - Enable SSL

2. Create a new Retool App named **"InRange Dashboard"**

---

## 1. Page Layout (3 Tabs)

```
┌──────────────────────────────────────────────────────────────┐
│  INRANGE DASHBOARD            [Leads] [Ingest] [Analytics]  │
├──────────────────────────────────────────────────────────────┤
│  [Stat cards row: Tier1 | Tier2 | Tier3 | Total | New Today] │
├──────────────────────────────────────────────────────────────┤
│ TAB: Leads                                                   │
│  [Search] [Tier filter] [Enrich filter] [Sort]              │
│  ┌──────────────────────────────┬─────────────────────────┐  │
│  │ leadsTable                   │ Detail Panel (right)    │  │
│  │ (scrollable, 15 rows/page)   │ shows on row select     │  │
│  └──────────────────────────────┴─────────────────────────┘  │
│  [pagination controls]                                       │
├──────────────────────────────────────────────────────────────┤
│ TAB: Ingest                                                  │
│  [Bar chart: records per source]  [Raw pipeline table]      │
├──────────────────────────────────────────────────────────────┤
│ TAB: Analytics                                               │
│  [Score distribution histogram]   [Tier trend line chart]   │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Queries to Create

| Retool Query Name        | SQL File         | Trigger        |
|--------------------------|------------------|----------------|
| `get_pipeline_stats`     | queries.sql Q1   | Load + manual  |
| `get_leads_table`        | queries.sql Q2   | On filter change |
| `get_lead_count`         | queries.sql Q3   | On filter change |
| `get_property_detail`    | queries.sql Q4   | Row click      |
| `get_contact_history`    | queries.sql Q5   | Row click      |
| `get_raw_pipeline`       | queries.sql Q6   | Load           |
| `get_source_breakdown`   | queries.sql Q7   | Load           |
| `get_score_distribution` | queries.sql Q8   | Load           |
| `get_tier_trend`         | queries.sql Q9   | Load           |
| `update_deal_status`     | queries.sql Q10  | Button click   |
| `log_contact_activity`   | queries.sql Q11  | Button click   |

All queries: Resource = **InRange Supabase**, Run mode = **Manual**.

---

## 3. Component List and Bindings

### 3.1 Stat Cards (Text + Number components)

Create 5 stat cards in a horizontal frame at the top:

| Card label       | Value binding                              | Color    |
|------------------|--------------------------------------------|----------|
| Tier 1 Leads     | `{{ formatStatsRow.data.tier1 }}`          | `#dc2626`|
| Tier 2 Leads     | `{{ formatStatsRow.data.tier2 }}`          | `#ea580c`|
| Tier 3 Leads     | `{{ formatStatsRow.data.tier3 }}`          | `#ca8a04`|
| Total Leads      | `{{ formatStatsRow.data.totalLeads }}`     | `#1d4ed8`|
| New Today        | `{{ formatStatsRow.data.newToday }}`       | `#16a34a`|

**Transformer**: Create JS transformer `formatStatsRow`, paste block from `transformers.js`.

---

### 3.2 Filter Controls (Leads tab)

| Component name    | Type         | Options / Binding                                   |
|-------------------|--------------|-----------------------------------------------------|
| `searchInput`     | Text Input   | Placeholder: "Search address or owner…"             |
| `tierFilter`      | Select       | Options: All, Tier 1, Tier 2, Tier 3, Tier 4        |
| `enrichFilter`    | Select       | Options: All, pending, enriched, in_progress, failed|
| `sortField`       | Select       | Options: composite_score, distress_score, equity    |
| `pageSize`        | Select       | Options: 25, 50, 100 (default 25)                   |
| `pageNum`         | Number Input | Default: 1; reset to 1 on filter change             |

Set all 5 filter controls to trigger `get_leads_table` and `get_lead_count` on change.

---

### 3.3 leadsTable (Main table)

- Component type: **Table**
- Data: `{{ formatLeadsTable.data }}`
- **Transformer**: Create JS transformer `formatLeadsTable`, paste from `transformers.js`
- Row click: triggers `get_property_detail` and `get_contact_history`

Column configuration:

| Column key           | Display name      | Notes                                         |
|----------------------|-------------------|-----------------------------------------------|
| `address`            | Address           |                                               |
| `city`               | City              |                                               |
| `priority_tier`      | Tier              | Tag cell, color: `{{ tierBadgeColor(currentRow.priority_tier) }}` |
| `composite_score`    | Score             | Number; sort default                          |
| `distress_score`     | Distress          |                                               |
| `equity`             | Equity            | Pre-formatted `$X,XXX`                        |
| `owner_name`         | Owner             |                                               |
| `enrichment_status`  | Enrichment        | Tag cell, color: `{{ enrichmentBadgeColor(currentRow.enrichment_status) }}` |
| `created_at`         | Added             |                                               |

Hide columns: `id`, `state`, `zip`, `county`, `property_type`, `distress_indicators`, raw scores except composite.

Pagination: Custom — previous/next buttons bound to `pageNum`, total label: `{{ get_lead_count.data[0].total }} leads`.

---

### 3.4 Detail Panel (right side, Leads tab)

Show/hide based on: `{{ leadsTable.selectedRow !== null }}`

Use a **Container** component with sections:

**Section: Property**
- Text: `{{ formatPropertyDetail.data.fullAddress }}`
- Badge: `{{ formatPropertyDetail.data.priorityTier }}` (color from tierBadgeColor)
- Label/value pairs for: ARV, Amount Owed, Asking Price, Equity, Equity %, Below Market %

**Section: Scores**
- Progress bars (0–100) for: Composite, Distress, Deal Quality, Contact Likelihood, Timeline Urgency
  ```
  Value: {{ parseFloat(formatPropertyDetail.data.compositeScore) || 0 }}
  ```

**Section: Owner**
- Labels for: Owner Name, Phone, Email
- Phone: link `tel:{{ formatPropertyDetail.data.ownerPhone }}`
- Email: link `mailto:{{ formatPropertyDetail.data.ownerEmail }}`

**Section: AI Analysis**
- Text component: `{{ formatPropertyDetail.data.aiAnalysis }}`
- Only show if enrichment_status === 'enriched'

**Section: Distress Signals**
- Tag list: `{{ formatPropertyDetail.data.distressFlags }}`

**Section: Deal Status**
- Select `dealStatusSelect`: options: None, Researching, Offer Sent, Under Contract, Closed, Dead
  - Default: `{{ formatPropertyDetail.data.dealStatus }}`
- Select `dealTypeSelect`: Wholesale, Buy & Hold, Fix & Flip, Subject-To, Land Contract
- Number Input `offerPriceInput`: Pre-fill: `{{ leadsTable.selectedRow.data.asking_price }}`
- Text Area `dealNotesInput`
- Button "Save Deal" → triggers `update_deal_status` → on success: re-run `get_property_detail`

**Section: Log Contact**
- Select `contactMethodSelect`: Phone, Email, Direct Mail, Door Knock, Text, Skip Trace
- Select `contactOutcomeSelect`: No Answer, Left VM, Spoke - Interested, Spoke - Not Interested, Wrong Number, Follow Up
- Text Area `contactNotesInput`
- Button "Log Contact" → triggers `log_contact_activity` → on success: re-run `get_contact_history`, clear inputs

**Section: Contact History**
- Table `contactHistoryTable`: Data `{{ get_contact_history.data }}`
- Columns: date (contact_date), method (contact_method), outcome, notes

---

### 3.5 Ingest Tab

**Bar Chart: records per source**
- Component: Chart (Bar)
- Data binding:
  ```js
  [{
    type: 'bar',
    x: formatSourceBreakdown.data.labels,
    y: formatSourceBreakdown.data.values,
  }]
  ```
- Title: "Records in Pipeline by Source"

**Raw pipeline table**
- Component: Table
- Data: `{{ get_raw_pipeline.data }}`
- Columns: source, address, city, distress_signals, created_at
- `distress_signals` column: render as `{{ currentRow.distress_signals?.join(', ') || '—' }}`

---

### 3.6 Analytics Tab

**Score Distribution Histogram**
- Component: Chart (Bar)
- Data: `{{ get_score_distribution.data }}`
- X-axis: `score_bucket`, Y-axis: `count`
- Title: "Composite Score Distribution"

**Tier Trend Line Chart**
- Component: Chart (Line)
- Data binding:
  ```js
  formatTierTrend.data.series.map(s => ({
    type: 'scatter',
    mode: 'lines+markers',
    name: s.name,
    x: formatTierTrend.data.labels,
    y: s.data,
  }))
  ```
- Title: "New Leads by Tier (Last 30 Days)"

---

## 4. Event Triggers / Run-on-Load

In App settings → Event Handlers, add on-load queries:

```
get_pipeline_stats     → run on load
get_leads_table        → run on load
get_lead_count         → run on load
get_raw_pipeline       → run on load
get_source_breakdown   → run on load
get_score_distribution → run on load
get_tier_trend         → run on load
```

Set auto-refresh on `get_pipeline_stats` and `get_raw_pipeline`: every **300 seconds** (5 min).

---

## 5. Page-level JavaScript (paste in App's global JS block)

```js
// Helpers exposed globally so column expressions can call them
function tierBadgeColor(tier) {
  return { 'Tier 1': '#dc2626', 'Tier 2': '#ea580c', 'Tier 3': '#ca8a04', 'Tier 4': '#16a34a' }[tier] ?? '#6b7280';
}

function enrichmentBadgeColor(status) {
  return { enriched: '#16a34a', pending: '#ca8a04', failed: '#dc2626', in_progress: '#2563eb' }[status] ?? '#6b7280';
}
```

---

## 6. Verify End-to-End

1. Run `SELECT COUNT(*) FROM inrange_leads;` in Supabase SQL editor — should be > 0 after the 2 AM Make.com run.
2. Run `SELECT COUNT(*) FROM properties;` — populated after Make S3 scoring scenario fires.
3. If `properties` is still empty but `inrange_leads` has rows: manually trigger scenario 4744381 (S3 Scoring) in Make.com.
4. Reload dashboard — stat cards should show non-zero counts.
5. Click a row in leadsTable — detail panel should open with all score fields.
6. Log a contact activity and verify it appears in the Contact History sub-table.
