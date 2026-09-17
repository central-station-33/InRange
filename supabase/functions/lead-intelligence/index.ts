/**
 * lead-intelligence — GET /leads/:id/intelligence
 *
 * Backs the Lead Intelligence panel directly: lead_workbench for the
 * score/tier/next-action/fact-count summary, lead_evidence_current for
 * the confirmed/source-supported/hypothesis/unverified fact list (already
 * labeled per-row, never blended into prose), review_queue for any open
 * conflicts, and recent ai_enrichment_runs for the model/prompt-version/
 * confidence history. "Missing information" is intentionally not a
 * queried field — see docs/ai-lead-enrichment-blueprint.md §10: it's
 * whatever expected field has no current row, which the caller (this
 * response's consumer) determines from what IS present, not from a
 * separate list this endpoint invents.
 *
 * Invoke as GET /functions/v1/lead-intelligence/<lead_id> or
 * GET /functions/v1/lead-intelligence?lead_id=<lead_id>.
 */

import { extractIdParam, getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

Deno.serve(async (req) => {
  if (req.method !== 'GET') return jsonResponse({ error: 'GET required' }, 405);

  try {
    verifyEnrichmentSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const leadId = extractIdParam(req, 'lead_id');
  if (!leadId) return jsonResponse({ error: 'lead_id is required (path segment or ?lead_id=)' }, 400);

  const supabase = getServiceClient();

  try {
    const { data: workbench, error: workbenchErr } = await supabase
      .from('lead_workbench')
      .select('*')
      .eq('lead_id', leadId)
      .maybeSingle();
    if (workbenchErr) throw workbenchErr;
    if (!workbench) return jsonResponse({ error: `No lead with id=${leadId}` }, 404);

    const { data: currentFacts, error: factsErr } = await supabase
      .from('lead_evidence_current')
      .select(
        'id, field_name, field_value, confidence, source_type, source_detail, ' +
        'needs_human_review, review_reason, review_priority, ai_run_id, verified_by, verified_at, created_at',
      )
      .eq('lead_id', leadId)
      .order('field_name', { ascending: true });
    if (factsErr) throw factsErr;

    const { data: openReview, error: reviewErr } = await supabase
      .from('review_queue')
      .select('*')
      .eq('lead_id', leadId);
    if (reviewErr) throw reviewErr;

    const { data: recentRuns, error: runsErr } = await supabase
      .from('ai_enrichment_runs')
      .select('id, model, run_type, prompt_version, confidence_score, flagged_for_review, reviewed_by, created_at')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(10);
    if (runsErr) throw runsErr;

    return jsonResponse({
      success: true,
      lead: workbench,
      current_facts: currentFacts,
      open_review_items: openReview,
      recent_enrichment_runs: recentRuns,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
