/**
 * lead-reject-ai-suggestion — POST /leads/:id/reject-ai-suggestion
 *
 * A human rejects an AI-authored evidence row. New row,
 * confidence='rejected', source_type='agent_input' — 'rejected' can only
 * ever be written by a human (see ai_extraction_never_rejected), which
 * this endpoint satisfies by construction. The original row's value is
 * preserved in field_value for the audit record (what was rejected),
 * not blanked out.
 *
 * Body: { evidence_id: string, reviewer_id: string, notes?: string }
 * notes is effectively required in practice (it's the reason for
 * rejection an agent will want on record) but not enforced server-side —
 * a Phase 4 UI should make it a required field in the form itself.
 */

import { extractIdParam, getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

interface RequestBody {
  evidence_id?: string;
  reviewer_id?: string;
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
      return jsonResponse({ error: 'evidence_id is not the current value for its field — nothing to reject' }, 409);
    }

    const { data: newRow, error: insertErr } = await supabase
      .from('lead_evidence')
      .insert({
        lead_id: leadId,
        field_name: original.field_name,
        field_value: original.field_value,
        confidence: 'rejected',
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
        action: 'reject',
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
