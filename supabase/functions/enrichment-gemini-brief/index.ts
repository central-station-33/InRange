/**
 * enrichment-gemini-brief — POST /enrichment/gemini-brief
 *
 * Second-stage Gemini pass: synthesizes next-action and outreach-angle
 * guidance from a lead's (by now normalized) evidence, optionally given
 * the prior enrichment-gemini-normalize run's output as extra context.
 * Unlike normalize, this also updates lead_records — but never
 * next_action_code directly from the model: that stays resolved from
 * compliance_playbook by category+jurisdiction, per this repo's core rule
 * that AI output never decides the compliant next action (see
 * docs/ai-lead-enrichment-blueprint.md §1/§5).
 *
 * NOT LIVE-TESTED — see _shared/gemini-client.ts.
 *
 * Body: { lead_id: string }
 */

import { getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';
import { callGemini, GEMINI_MODEL } from '../_shared/gemini-client.ts';
import { buildEvidencePacket } from '../_shared/prompts/evidence-packet.ts';
import {
  GEMINI_PROMPT_VERSION,
  GEMINI_SYSTEM_INSTRUCTION,
  buildLeadBriefPrompt,
  parseGeminiLeadBriefResponse,
  type GeminiLeadBriefResponse,
} from '../_shared/prompts/gemini-enrichment.ts';
import { applyGeminiOutput } from '../_shared/prompts/apply-gemini-output.ts';

interface RequestBody {
  lead_id?: string;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyEnrichmentSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.lead_id) return jsonResponse({ error: 'lead_id is required' }, 400);

  const supabase = getServiceClient();

  try {
    const packet = await buildEvidencePacket(supabase, body.lead_id);
    const evidenceIds = packet.current_facts.map((f) => f.evidence_id);

    const { data: priorRun } = await supabase
      .from('ai_enrichment_runs')
      .select('output')
      .eq('lead_id', body.lead_id)
      .eq('run_type', 'primary_extraction')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const priorOutput = (priorRun?.output as GeminiLeadBriefResponse | undefined) ?? undefined;
    const prompt = buildLeadBriefPrompt(packet, priorOutput);

    let rawText: string;
    try {
      rawText = await callGemini(GEMINI_SYSTEM_INSTRUCTION, prompt);
    } catch (e) {
      await supabase.from('ai_enrichment_runs').insert({
        lead_id: body.lead_id,
        model: GEMINI_MODEL,
        run_type: 'primary_extraction',
        prompt_version: GEMINI_PROMPT_VERSION,
        input_ref: { evidence_ids: evidenceIds },
        output: { error: (e as Error).message },
        flagged_for_review: true,
      });
      throw e;
    }

    const parsed = parseGeminiLeadBriefResponse(rawText);

    const { data: run, error: runErr } = await supabase
      .from('ai_enrichment_runs')
      .insert({
        lead_id: body.lead_id,
        model: GEMINI_MODEL,
        run_type: 'primary_extraction',
        prompt_version: GEMINI_PROMPT_VERSION,
        input_ref: { evidence_ids: evidenceIds },
        output: parsed,
        confidence_score: parsed.overall_confidence,
        flagged_for_review: parsed.human_review_required,
      })
      .select()
      .single();
    if (runErr) throw runErr;

    const applied = await applyGeminiOutput(supabase, body.lead_id, run.id, parsed);

    // Resolve the compliant next action from compliance_playbook — never
    // from parsed.suggested_next_research_action /
    // suggested_agent_next_action directly.
    const { data: lead, error: leadErr } = await supabase
      .from('lead_records')
      .select('id, category, status, property_id')
      .eq('id', body.lead_id)
      .single();
    if (leadErr) throw leadErr;

    const { data: property } = await supabase
      .from('properties')
      .select('state')
      .eq('id', lead.property_id)
      .single();

    const { data: playbookEntry } = await supabase
      .from('compliance_playbook')
      .select('next_action_code')
      .eq('category', lead.category)
      .eq('jurisdiction', property?.state ?? '')
      .maybeSingle();

    const leadUpdate: Record<string, unknown> = {
      rationale: parsed.suggested_agent_next_action,
    };
    if (playbookEntry?.next_action_code) {
      leadUpdate.next_action_code = playbookEntry.next_action_code;
    }
    if (parsed.human_review_required && lead.status === 'new') {
      leadUpdate.status = 'needs_verification';
    }

    const { error: updateErr } = await supabase
      .from('lead_records')
      .update(leadUpdate)
      .eq('id', body.lead_id);
    if (updateErr) throw updateErr;

    return jsonResponse({
      success: true,
      run_id: run.id,
      signals_written: applied.signalsWritten,
      conflicts_written: applied.conflictsWritten,
      write_errors: applied.writeErrors,
      next_action_code: playbookEntry?.next_action_code ?? null,
      human_review_required: parsed.human_review_required,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
