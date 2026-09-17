/**
 * outreach-draft — POST /outreach/:leadId/draft
 *
 * Builds a draft from already-vetted material only: the most recent
 * Gemini brief's suggested_outreach_angle (itself constrained by the
 * prompt contract to be grounded in confirmed_facts/source_supported_signals
 * only — see _shared/prompts/gemini-enrichment.ts) plus the resolved
 * compliance_playbook entry. Deliberately does NOT call any LLM here —
 * no prompt contract was specified for outreach copy generation, and per
 * docs/ai-lead-enrichment-blueprint.md §9, a model call needing contact
 * data would be "a distinct, explicitly-scoped call," which this isn't.
 * It also never reads lead_contacts values — the draft is templated
 * around the lead and property, not the recipient's actual phone/email.
 *
 * Body: { channel: 'phone' | 'email' | 'sms' }
 */

import { extractIdParam, getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

interface RequestBody {
  channel?: string;
}

const VALID_CHANNELS = ['phone', 'email', 'sms'];

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
  if (!body.channel || !VALID_CHANNELS.includes(body.channel)) {
    return jsonResponse({ error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` }, 400);
  }

  const supabase = getServiceClient();

  try {
    const { data: lead, error: leadErr } = await supabase
      .from('lead_workbench')
      .select('address, city, state, next_action_label, compliance_note, counsel_reviewed')
      .eq('lead_id', leadId)
      .maybeSingle();
    if (leadErr) throw leadErr;
    if (!lead) return jsonResponse({ error: `No lead with id=${leadId}` }, 404);

    const { data: latestRun } = await supabase
      .from('ai_enrichment_runs')
      .select('id, output')
      .eq('lead_id', leadId)
      .eq('run_type', 'primary_extraction')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const angle = (latestRun?.output as { suggested_outreach_angle?: string } | undefined)
      ?.suggested_outreach_angle;

    const complianceLine = lead.compliance_note
      ? `\n\nCOMPLIANCE: ${lead.compliance_note}${lead.counsel_reviewed ? '' : ' (placeholder — not yet counsel-reviewed)'}`
      : '';

    const draftText = `[${body.channel.toUpperCase()} DRAFT — ${lead.address}, ${lead.city}, ${lead.state}]\n` +
      `Suggested next action: ${lead.next_action_label ?? 'not yet determined'}\n` +
      `Suggested angle: ${angle ?? 'no enrichment run yet — draft is generic, review before use'}` +
      complianceLine;

    const { data: draft, error: insertErr } = await supabase
      .from('outreach_drafts')
      .insert({
        lead_id: leadId,
        channel: body.channel,
        draft_text: draftText,
        based_on_run_id: latestRun?.id ?? null,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    return jsonResponse({ success: true, draft });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
