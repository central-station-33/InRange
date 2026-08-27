-- BT Capital: Views and helper functions for the Retool complaint dashboard

-- ─── Views ──────────────────────────────────────────────────────────────────

-- Primary Retool table: every complaint, with a due-date badge color and
-- days-until-due for sorting/filtering.
CREATE OR REPLACE VIEW complaints_dashboard AS
SELECT
  c.*,
  CASE
    WHEN c.finra_report_due_date IS NULL THEN NULL
    ELSE (c.finra_report_due_date - CURRENT_DATE)
  END AS days_until_finra_due,
  CASE
    WHEN c.finra_report_due_date IS NULL OR c.status = 'reported_finra' THEN 'none'
    WHEN c.finra_report_due_date - CURRENT_DATE < 0                    THEN 'red'
    WHEN c.finra_report_due_date - CURRENT_DATE <= 10                  THEN 'yellow'
    ELSE 'green'
  END AS finra_due_badge
FROM complaints c
ORDER BY c.date_received DESC;

-- Complaints on the active 30-day theft/misappropriation/forgery clock
-- that have not yet been reported to FINRA.
CREATE OR REPLACE VIEW complaints_finra_clock AS
SELECT *
FROM complaints_dashboard
WHERE involves_theft_misappropriation_forgery = true
  AND status != 'reported_finra'
ORDER BY finra_report_due_date ASC NULLS LAST;

-- Complaints flagged for the qualified third-party escrow agent
-- (BT Capital cannot hold investor funds — FP Rule 300(c)(2)(iv)).
CREATE OR REPLACE VIEW complaints_escrow_responsible AS
SELECT *
FROM complaints_dashboard
WHERE escrow_agent_responsible = true
ORDER BY date_received DESC;

-- Summary stats for the Retool dashboard header.
CREATE OR REPLACE VIEW complaints_summary AS
SELECT
  COUNT(*)                                                          AS total_complaints,
  COUNT(*) FILTER (WHERE status = 'open')                           AS open_count,
  COUNT(*) FILTER (WHERE status = 'under_review')                   AS under_review_count,
  COUNT(*) FILTER (WHERE status = 'escalated')                      AS escalated_count,
  COUNT(*) FILTER (WHERE status = 'resolved')                       AS resolved_count,
  COUNT(*) FILTER (WHERE status = 'reported_finra')                 AS reported_finra_count,
  COUNT(*) FILTER (WHERE involves_theft_misappropriation_forgery)   AS theft_misappropriation_forgery_count,
  COUNT(*) FILTER (WHERE escrow_agent_responsible)                  AS escrow_responsible_count,
  COUNT(*) FILTER (
    WHERE finra_report_due_date IS NOT NULL
      AND status != 'reported_finra'
      AND finra_report_due_date - CURRENT_DATE <= 10
  )                                                                  AS finra_due_soon_count,
  COUNT(*) FILTER (WHERE archived_tier = 'cold_storage')             AS cold_storage_count
FROM complaints;

-- Per-quarter aggregate for the FINRA Gateway quarterly summary report.
CREATE OR REPLACE VIEW complaints_quarterly_report AS
SELECT
  quarter_reported,
  COUNT(*)                                                        AS total_complaints,
  COUNT(*) FILTER (WHERE category = 'investment_dispute')          AS investment_dispute_count,
  COUNT(*) FILTER (WHERE category = 'fund_disbursement')           AS fund_disbursement_count,
  COUNT(*) FILTER (WHERE category = 'unauthorized_fraud')          AS unauthorized_fraud_count,
  COUNT(*) FILTER (WHERE category = 'misrepresentation')           AS misrepresentation_count,
  COUNT(*) FILTER (WHERE category = 'technical')                   AS technical_count,
  COUNT(*) FILTER (WHERE category = 'other')                       AS other_count,
  COUNT(*) FILTER (WHERE involves_theft_misappropriation_forgery)  AS theft_misappropriation_forgery_count,
  COUNT(*) FILTER (WHERE status = 'resolved')                      AS resolved_count,
  COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'reported_finra')) AS open_count
FROM complaints
GROUP BY quarter_reported;

-- ─── Helper Functions ────────────────────────────────────────────────────────

-- Complaints due for a day-15 or day-25 compliance-officer escalation
-- reminder that haven't already received that specific alert.
CREATE OR REPLACE FUNCTION complaints_needing_escalation_alert(p_alert_day INTEGER)
RETURNS SETOF complaints LANGUAGE sql STABLE AS $$
  SELECT c.*
  FROM complaints c
  WHERE c.involves_theft_misappropriation_forgery = true
    AND c.status != 'reported_finra'
    AND c.date_received + (p_alert_day || ' days')::INTERVAL <= now()
    AND NOT EXISTS (
      SELECT 1 FROM complaint_escalation_alerts a
      WHERE a.complaint_id = c.id AND a.alert_day = p_alert_day
    );
$$;
