/**
 * lead-request-review — POST /leads/:id/request-review
 *
 * Lead-level review request (distinct from the per-fact conflicts
 * lead_evidence.needs_human_review already surfaces automatically) — an
 * agent flagging "this whole lead needs a second look," not tied to one
 * specific piece of evidence. Records the request in lead_review_actions
 * and moves the lead to 'needs_verification' unless it's already further
 * along (assigned/working/closed) — this never downgrades a lead that's
 * actively being worked.
 *
 * Body: { reviewer_id: string, reason?: string }
 *
 * reviewer_id is trusted from the request body, not verified against a
 * session — this backend layer is secret-gated (ENRICHMENT_WEBHOOK_SECRET),
 * not per-user-authenticated, matching the rest of this repo's Edge
 * Functions. A real CRM UI (Phase 4) should pass its own verified user id
 * here rather than trusting a client-supplied value.
 */

import { extractIdParam, getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

interface RequestBody {
  reviewer_id?: string;
  reason?: string;
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
  if (!body.reviewer_id) return jsonResponse({ error: 'reviewer_id is required' }, 400);

  const supabase = getServiceClient();

  try {
    const { data: action, error: actionErr } = await supabase
      .from('lead_review_actions')
      .insert({
        lead_id: leadId,
        action: 'request_more_research',
        notes: body.reason ?? null,
        reviewer_id: body.reviewer_id,
      })
      .select()
      .single();
    if (actionErr) throw actionErr;

    await supabase
      .from('lead_records')
      .update({ status: 'needs_verification' })
      .eq('id', leadId)
      .eq('status', 'new');

    return jsonResponse({ success: true, review_action_id: action.id });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
