/**
 * leads-feedback — POST /leads/:id/feedback
 *
 * Not one of the endpoints explicitly named in the API list, but the
 * "Agent feedback controls" section requires storing this somewhere for
 * later prompt/rule evaluation, and nothing else in the spec provides a
 * home for it — see docs/ai-lead-enrichment-blueprint.md's Phase 1
 * section for the note on this.
 *
 * Body: { feedback: AgentFeedbackType, agent_id: string, evidence_id?: string, ai_run_id?: string, note?: string }
 */

import { extractIdParam, getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

const VALID_FEEDBACK_TYPES = [
  'accurate',
  'inaccurate',
  'useful',
  'not_useful',
  'wrong_owner',
  'wrong_address',
  'wrong_entity_match',
  'bad_outreach_angle',
  'requires_legal_review',
  'requires_manager_review',
];

interface RequestBody {
  feedback?: string;
  agent_id?: string;
  evidence_id?: string;
  ai_run_id?: string;
  note?: string;
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
  if (!body.feedback || !VALID_FEEDBACK_TYPES.includes(body.feedback)) {
    return jsonResponse({ error: `feedback must be one of: ${VALID_FEEDBACK_TYPES.join(', ')}` }, 400);
  }
  if (!body.agent_id) return jsonResponse({ error: 'agent_id is required' }, 400);

  const supabase = getServiceClient();

  try {
    const { data, error } = await supabase
      .from('lead_feedback')
      .insert({
        lead_id: leadId,
        feedback: body.feedback,
        agent_id: body.agent_id,
        evidence_id: body.evidence_id ?? null,
        ai_run_id: body.ai_run_id ?? null,
        note: body.note ?? null,
      })
      .select()
      .single();
    if (error) throw error;

    return jsonResponse({ success: true, feedback: data });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
