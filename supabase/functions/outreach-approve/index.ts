/**
 * outreach-approve — POST /outreach/:leadId/approve
 *
 * Marks a draft approved. Does not send anything — see outreach-send for
 * why sending is hard-blocked regardless of approval status.
 *
 * Body: { draft_id: string, approver_id: string }
 */

import { extractIdParam, getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

interface RequestBody {
  draft_id?: string;
  approver_id?: string;
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
  if (!body.draft_id) return jsonResponse({ error: 'draft_id is required' }, 400);
  if (!body.approver_id) return jsonResponse({ error: 'approver_id is required' }, 400);

  const supabase = getServiceClient();

  try {
    const { data: draft, error: fetchErr } = await supabase
      .from('outreach_drafts')
      .select('id, lead_id, status')
      .eq('id', body.draft_id)
      .single();
    if (fetchErr) throw fetchErr;
    if (draft.lead_id !== leadId) {
      return jsonResponse({ error: 'draft_id does not belong to this lead' }, 400);
    }
    if (draft.status !== 'draft') {
      return jsonResponse({ error: `Draft is already ${draft.status}` }, 409);
    }

    const { data: updated, error: updateErr } = await supabase
      .from('outreach_drafts')
      .update({ status: 'approved', approved_by: body.approver_id, approved_at: new Date().toISOString() })
      .eq('id', body.draft_id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    return jsonResponse({ success: true, draft: updated });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
