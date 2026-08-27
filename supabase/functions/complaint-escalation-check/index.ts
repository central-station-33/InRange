/**
 * complaint-escalation-check — Nightly job (Make.com scheduler).
 *
 * 1. Sends day-15 and day-25 escalation reminders to the compliance officer
 *    for any complaint still on the FINRA Rule 4530 30-day theft/
 *    misappropriation/forgery clock that hasn't already received that
 *    specific alert (idempotent via complaint_escalation_alerts).
 * 2. Sends an overdue alert for anything past its 30-day due date that
 *    still hasn't been reported to FINRA.
 * 3. Runs retention housekeeping: moves complaints older than 2 years to
 *    the cold-storage tier (never deletes — 4-year minimum retention).
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';

const COMPLIANCE_ALERT_WEBHOOK = Deno.env.get('COMPLIANCE_ALERT_WEBHOOK') ?? '';

async function postWebhook(url: string, payload: unknown): Promise<void> {
  if (!url) return;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Webhook POST ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const supabase = getServiceClient();
  const alertsSent: string[] = [];
  const errors: string[] = [];

  try {
    for (const alertDay of [15, 25, 30]) {
      const { data: due, error } = await supabase.rpc('complaints_needing_escalation_alert', {
        p_alert_day: alertDay,
      });
      if (error) throw error;

      for (const complaint of due ?? []) {
        const label = alertDay === 30 ? 'OVERDUE' : `day ${alertDay}`;
        try {
          await postWebhook(COMPLIANCE_ALERT_WEBHOOK, {
            type: alertDay === 30 ? 'finra_30day_overdue' : 'finra_30day_reminder',
            reference_number: complaint.reference_number,
            complaint_id: complaint.id,
            finra_report_due_date: complaint.finra_report_due_date,
            summary: `[${label}] Complaint ${complaint.reference_number} — FINRA reporting due ${complaint.finra_report_due_date}.`,
          });

          const { error: logErr } = await supabase
            .from('complaint_escalation_alerts')
            .insert({ complaint_id: complaint.id, alert_day: alertDay, channel: 'webhook' });
          // Unique constraint prevents a double-send race; treat as already-sent.
          if (logErr && logErr.code !== '23505') throw logErr;

          alertsSent.push(`${complaint.reference_number} (${label})`);
        } catch (e) {
          errors.push(`${complaint.reference_number} (${label}): ${(e as Error).message}`);
        }
      }
    }

    const { data: archivedCount, error: archiveErr } = await supabase.rpc('archive_old_complaints');
    if (archiveErr) throw archiveErr;

    return jsonResponse({ success: true, alertsSent, archived: archivedCount, errors });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
