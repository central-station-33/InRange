-- Finance Agents: Views
-- Read-oriented views for edge functions and any future dashboard (Retool
-- or otherwise). Pure SQL — no financial logic lives here beyond simple
-- aggregation; the debt-payoff simulation and credit-building playbook are
-- implemented in the edge functions (supabase/functions/_shared/finance-math.ts)
-- because they need iterative month-by-month simulation, not a single query.

-- Per-account monthly-normalized view is intentionally not a view — frequency
-- normalization (weekly/biweekly/quarterly/annual → monthly) is done in
-- TypeScript (finance-math.ts) so both the analyze agent and the debt-payoff
-- agent share one implementation.

-- ─── Liability accounts, ready for debt-payoff planning ───────────────────

CREATE VIEW finance.liability_accounts AS
SELECT
  a.id,
  a.entity_id,
  e.name           AS entity_name,
  a.name,
  a.account_type,
  a.current_balance,
  a.credit_limit,
  a.interest_rate,
  a.minimum_payment,
  CASE WHEN a.credit_limit IS NOT NULL AND a.credit_limit > 0
       THEN ROUND(a.current_balance / a.credit_limit, 4)
       ELSE NULL END AS utilization
FROM finance.accounts a
JOIN finance.entities e ON e.id = a.entity_id
WHERE a.is_liability = TRUE
  AND a.status = 'active'
  AND a.current_balance > 0;

-- ─── Entity balance sheet summary (assets vs liabilities) ─────────────────

CREATE VIEW finance.entity_balance_sheet AS
SELECT
  e.id                                                                     AS entity_id,
  e.name                                                                   AS entity_name,
  COALESCE(SUM(a.current_balance) FILTER (WHERE a.is_liability = FALSE), 0) AS total_assets,
  COALESCE(SUM(a.current_balance) FILTER (WHERE a.is_liability = TRUE), 0)  AS total_liabilities,
  COALESCE(SUM(a.current_balance) FILTER (WHERE a.is_liability = FALSE), 0)
    - COALESCE(SUM(a.current_balance) FILTER (WHERE a.is_liability = TRUE), 0) AS net_worth
FROM finance.entities e
LEFT JOIN finance.accounts a ON a.entity_id = e.id AND a.status = 'active'
GROUP BY e.id, e.name;

-- ─── Pending recommendations queue (what a human needs to review) ─────────

CREATE VIEW finance.pending_recommendations AS
SELECT
  r.id,
  r.entity_id,
  e.name AS entity_name,
  r.agent_name,
  r.recommendation_type,
  r.title,
  r.rationale,
  r.priority,
  r.details,
  r.created_at
FROM finance.agent_recommendations r
LEFT JOIN finance.entities e ON e.id = r.entity_id
WHERE r.status = 'pending'
ORDER BY
  CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
  r.created_at ASC;

-- ─── Business credit building status, per entity ──────────────────────────

CREATE VIEW finance.credit_building_status AS
SELECT
  p.entity_id,
  e.name AS entity_name,
  p.estimated_stage,
  p.has_ein,
  p.has_dedicated_business_bank_account,
  p.has_duns_number,
  p.trade_lines_count,
  p.business_credit_cards_count,
  p.reporting_bureaus,
  p.last_reviewed_at,
  (SELECT COUNT(*) FROM finance.credit_building_actions ca
    WHERE ca.entity_id = p.entity_id AND ca.status IN ('recommended', 'in_progress')) AS open_actions,
  (SELECT COUNT(*) FROM finance.credit_building_actions ca
    WHERE ca.entity_id = p.entity_id AND ca.status = 'completed') AS completed_actions
FROM finance.business_credit_profiles p
JOIN finance.entities e ON e.id = p.entity_id;

-- ─── Latest snapshot per entity (including the consolidated NULL row) ─────

CREATE VIEW finance.latest_snapshots AS
SELECT DISTINCT ON (COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'))
  s.*
FROM finance.financial_snapshots s
ORDER BY COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'), snapshot_date DESC, created_at DESC;
