/**
 * complaint-quarterly-report — Scheduled to run on the 1st of the month
 * after each quarter close (Apr 1 / Jul 1 / Oct 1 / Jan 1), giving the
 * compliance officer two weeks before the 15th-day FINRA Gateway filing
 * deadline.
 *
 * Aggregates the closed quarter from `complaints_quarterly_report` and
 * emails/posts the summary + a copies-required checklist for any
 * theft/misappropriation/forgery complaints. Make.com turns the JSON
 * response into the CSV/PDF summary for manual Gateway entry.
 *
 * Accepts optional POST body: { quarter?: string }  e.g. "Q3-2026"
 * Defaults to the most recently closed calendar quarter.
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';

const COMPLIANCE_ALERT_WEBHOOK = Deno.env.get('COMPLIANCE_ALERT_WEBHOOK') ?? '';

function previousQuarter(today = new Date()): string {
  // Quarter that most recently closed relative to "today".
  const month = today.getUTCMonth(); // 0-indexed
  const year = today.getUTCFullYear();
  const currentQuarter = Math.floor(month / 3) + 1;
  const q = currentQuarter === 1 ? 4 : currentQuarter - 1;
  const y = currentQuarter === 1 ? year - 1 : year;
  return `Q${q}-${y}`;
}

function filingDeadline(quarter: string): string {
  const [, qStr, yStr] = quarter.match(/Q(\d)-(\d{4})/) ?? [];
  const q = Number(qStr);
  const y = Number(yStr);
  const deadlineMonth = { 1: 4, 2: 7, 3: 10, 4: 1 }[q]!;
  const deadlineYear = q === 4 ? y + 1 : y;
  return `${deadlineYear}-${String(deadlineMonth).padStart(2, '0')}-15`;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { quarter?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const quarter = body.quarter ?? previousQuarter();
  const supabase = getServiceClient();

  try {
    const { data: report, error } = await supabase
      .from('complaints_quarterly_report')
      .select('*')
      .eq('quarter_reported', quarter)
      .maybeSingle();
    if (error) throw error;

    const summary = report ?? {
      quarter_reported: quarter,
      total_complaints: 0,
      investment_dispute_count: 0,
      fund_disbursement_count: 0,
      unauthorized_fraud_count: 0,
      misrepresentation_count: 0,
      technical_count: 0,
      other_count: 0,
      theft_misappropriation_forgery_count: 0,
      resolved_count: 0,
      open_count: 0,
    };

    const dueDate = filingDeadline(quarter);

    if (COMPLIANCE_ALERT_WEBHOOK) {
      await fetch(COMPLIANCE_ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'quarterly_finra_gateway_report',
          quarter,
          file_by: dueDate,
          copies_required_count: summary.theft_misappropriation_forgery_count,
          summary,
          checklist: [
            `File by ${dueDate}.`,
            `Complaints with copies required (theft/misappropriation/forgery): ${summary.theft_misappropriation_forgery_count}.`,
            `Open/unresolved complaints in this quarter: ${summary.open_count}.`,
          ],
        }),
      });
    }

    return jsonResponse({ success: true, quarter, file_by: dueDate, summary });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
