# Finance Agents — Data Model

All tables live in the `finance` Postgres schema (not `public`, which is
InRange's lead-gen schema). Full definitions:
`supabase/migrations/20260816000000_finance_schema.sql` (tables) and
`20260816000001_finance_views.sql` (views).

```
finance.entities
  ├─< finance.accounts (is_liability distinguishes assets from liabilities)
  │     └─< finance.debt_payoff_steps  (via debt_payoff_plans)
  ├─< finance.income_sources
  ├─< finance.expenses
  ├─< finance.transactions (via accounts)
  ├─< finance.financial_snapshots       (entity_id NULL = consolidated)
  ├─< finance.debt_payoff_plans          (entity_id NULL = across all entities)
  │     └─< finance.debt_payoff_steps
  ├─< finance.business_credit_profiles   (1:1, business entities only)
  │     └─< finance.credit_building_actions
  └─< finance.agent_recommendations      (entity_id NULL = household-wide)
        └─< finance.recommendation_events (append-only audit log)

finance.plaid_items  ── stub only, not wired to anything live yet
```

## Tables

| Table | Purpose |
|---|---|
| `entities` | One row per book of finances — household + each business. |
| `accounts` | Bank/credit/loan accounts. `is_liability` + `account_type` determine asset vs. liability. |
| `plaid_items` | Integration stub for future live bank sync — no access tokens are ever stored in plaintext, and nothing reads this table yet. |
| `income_sources` / `expenses` | Recurring amounts at a given `frequency`; normalized to monthly by `finance-math.ts::toMonthlyAmount`. |
| `transactions` | Individual ledger entries, from manual/CSV import today. `external_id` + `UNIQUE(account_id, external_id)` makes re-imports idempotent. |
| `financial_snapshots` | One row per `finance-analyze` run — net worth, cash flow, DTI, utilization at a point in time. |
| `debt_payoff_plans` / `debt_payoff_steps` | One plan per strategy (avalanche/snowball) per `finance-debt-payoff` run, with an ordered per-account schedule. |
| `business_credit_profiles` | One row per business entity — where it stands against the credit-building playbook. |
| `credit_building_actions` | Individual playbook steps, tracked `not_started → recommended → in_progress → completed`. |
| `agent_recommendations` | **The approval gate.** Every actionable output from any agent lands here as `pending` until a human decides. |
| `recommendation_events` | Append-only log of every status change on a recommendation — the audit trail. |

## Views

| View | Purpose |
|---|---|
| `finance.liability_accounts` | Active liability accounts with computed per-account utilization — feeds `finance-debt-payoff`. |
| `finance.entity_balance_sheet` | Assets, liabilities, net worth, rolled up per entity. |
| `finance.pending_recommendations` | What a human needs to review right now, sorted by priority. |
| `finance.credit_building_status` | Per-business credit-building progress summary. |
| `finance.latest_snapshots` | Most recent `financial_snapshots` row per entity (including the consolidated one). |

## Row-Level Security

RLS is enabled on every table in this schema, with **no policies** for
`anon` or `authenticated` yet — only the service role (used by edge
functions) can read/write until real user auth exists for a dashboard. This
is intentionally tighter than InRange's lead-gen tables, which do grant
`authenticated` read access for Retool: financial data across six
businesses and a household is not something to expose by default.

When a dashboard is built, add narrowly-scoped policies (e.g. scoped to a
specific authenticated user/role) rather than the lead-gen pattern's blanket
`USING (true)`.
