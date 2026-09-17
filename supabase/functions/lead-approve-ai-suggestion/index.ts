/**
 * lead-approve-ai-suggestion — POST /leads/:id/approve-ai-suggestion
 *
 * A human confirms an AI-authored (or any) evidence row. Per the
 * append-only model, this is a NEW row — confidence='confirmed_fact',
 * source_type='agent_input', supersedes_id=the approved row — never an
 * UPDATE of the original (lead_evidence has no UPDATE path at all; see
 * the migration). Also logs the decision in lead_review_actions with
 * resulting_evidence_id pointing at the new row, so the audit trail
 * connects the decision to its effect.
 *
 * Body: { evidence_id: string, reviewer_id: string, value_override?: string, notes?: string }
 *
 * value_override lets a reviewer approve with a corrected value rather
 * than the exact AI-proposed one — still recorded as this reviewer's own
 * confirmed fact, not a blend of the two.
 */

import { extractIdParam, getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

interface RequestBody {
  evidence_id?: string;
  reviewer_id?: string;
  value_override?: string;
  notes?: string;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyEnrichmentSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const leadId = extractIdParam(req, 'lead_id');
  if (!leadId) return jsonResponse({ error: 'lead_id is required (path segment or ?lead_id=)' }, 400);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.evidence_id) return jsonResponse({ error: 'evidence_id is required' }, 400);
  if (!body.reviewer_id) return jsonResponse({ error: 'reviewer_id is required' }, 400);

  const supabase = getServiceClient();

  try {
    const { data: original, error: fetchErr } = await supabase
      .from('lead_evidence')
      .select('id, lead_id, field_name, field_value, is_current')
      .eq('id', body.evidence_id)
      .single();
    if (fetchErr) throw fetchErr;
    if (original.lead_id !== leadId) {
      return jsonResponse({ error: 'evidence_id does not belong to this lead' }, 400);
    }
    if (!original.is_current) {
      return jsonResponse({ error: 'evidence_id is not the current value for its field — nothing to approve' }, 409);
    }

    const { data: newRow, error: insertErr } = await supabase
      .from('lead_evidence')
      .insert({
        lead_id: leadId,
        field_name: original.field_name,
        field_value: body.value_override ?? original.field_value,
        confidence: 'confirmed_fact',
        source_type: 'agent_input',
        source_detail: body.notes ?? null,
        supersedes_id: original.id,
        verified_by: body.reviewer_id,
        verified_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    const { data: action, error: actionErr } = await supabase
      .from('lead_review_actions')
      .insert({
        lead_id: leadId,
        evidence_id: original.id,
        action: 'approve',
        notes: body.notes ?? null,
        reviewer_id: body.reviewer_id,
        resulting_evidence_id: newRow.id,
      })
      .select()
      .single();
    if (actionErr) throw actionErr;

    return jsonResponse({ success: true, evidence_id: newRow.id, review_action_id: action.id });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
