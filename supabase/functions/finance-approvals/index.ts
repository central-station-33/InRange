/**
 * finance-approvals — The human-in-the-loop gate. This is the ONLY place
 * an agent_recommendations row moves out of 'pending'. Approving a
 * recommendation does not execute anything by itself — it marks the
 * linked plan/action as authorized so a human can go act on it (make the
 * payment, apply for the tradeline, etc.). No downstream automation reads
 * 'approved' and fires off a real-world action in this codebase.
 *
 * POST body:
 *   {
 *     recommendation_id: string;
 *     decision: 'approve' | 'reject';
 *     decided_by: string;     -- who is approving, for the audit trail
 *     notes?: string;
 *   }
 *
 * To see what's awaiting review, query the `finance.pending_recommendations`
 * view directly (e.g. from a dashboard) rather than through this function.
 */

import { getServiceClient, jsonResponse, verifySecret } from '../_shared/supabase-client.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifySecret(req, 'FINANCE_WEBHOOK_SECRET', 'x-finance-secret');
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { recommendation_id?: string; decision?: 'approve' | 'reject'; decided_by?: string; notes?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  if (!body.recommendation_id) return jsonResponse({ error: 'recommendation_id is required' }, 400);
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    return jsonResponse({ error: "decision must be 'approve' or 'reject'" }, 400);
  }
  if (!body.decided_by) return jsonResponse({ error: 'decided_by is required (who is making this decision)' }, 400);

  const supabase = getServiceClient();

  try {
    const { data: rec, error: fetchErr } = await supabase
      .schema('finance').from('agent_recommendations').select('*').eq('id', body.recommendation_id).single();
    if (fetchErr || !rec) return jsonResponse({ success: false, error: 'Recommendation not found' }, 404);
    if (rec.status !== 'pending') {
      return jsonResponse({ success: false, error: `Recommendation is already '${rec.status}', not 'pending'` }, 409);
    }

    const newStatus = body.decision === 'approve' ? 'approved' : 'rejected';
    const now = new Date().toISOString();

    const { error: updateErr } = await supabase
      .schema('finance').from('agent_recommendations')
      .update({ status: newStatus, decided_at: now, decided_by: body.decided_by, decision_notes: body.notes ?? null })
      .eq('id', body.recommendation_id);
    if (updateErr) throw updateErr;

    await supabase.schema('finance').from('recommendation_events').insert({
      recommendation_id: body.recommendation_id,
      event_type: newStatus === 'approved' ? 'approved' : 'rejected',
      actor: body.decided_by,
      detail: body.notes ?? null,
    });

    if (rec.related_plan_id) {
      await supabase.schema('finance').from('debt_payoff_plans')
        .update(
          newStatus === 'approved'
            ? { status: 'approved', approved_at: now, approved_by: body.decided_by }
            : { status: 'rejected' },
        )
        .eq('id', rec.related_plan_id);
    }

    if (rec.related_credit_action_id) {
      await supabase.schema('finance').from('credit_building_actions')
        .update({ status: newStatus === 'approved' ? 'in_progress' : 'skipped' })
        .eq('id', rec.related_credit_action_id);
    }

    return jsonResponse({ success: true, recommendation_id: body.recommendation_id, status: newStatus });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
