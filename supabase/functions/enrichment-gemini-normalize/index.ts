/**
 * enrichment-gemini-normalize — POST /enrichment/gemini-normalize
 *
 * First-pass extraction/reconciliation over a lead's current evidence.
 * See supabase/functions/_shared/prompts/gemini-enrichment.ts for the
 * prompt contract and supabase/functions/_shared/prompts/apply-gemini-output.ts
 * for exactly what does and doesn't get written to lead_evidence.
 *
 * NOT LIVE-TESTED — see _shared/gemini-client.ts. This function's own
 * logic (evidence packet construction, response validation, evidence
 * writes, audit row) was exercised with a stubbed Gemini call against the
 * local schema; the actual generativelanguage.googleapis.com call was not.
 *
 * Body: { lead_id: string }
 */

import { getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';
import { callGemini, GEMINI_MODEL } from '../_shared/gemini-client.ts';
import { buildEvidencePacket } from '../_shared/prompts/evidence-packet.ts';
import {
  GEMINI_PROMPT_VERSION,
  GEMINI_SYSTEM_INSTRUCTION,
  buildNormalizePrompt,
  parseGeminiLeadBriefResponse,
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
    const prompt = buildNormalizePrompt(packet);

    let rawText: string;
    try {
      rawText = await callGemini(GEMINI_SYSTEM_INSTRUCTION, prompt);
    } catch (e) {
      // Record the failed attempt so it's auditable — a call that never
      // produced usable output is still a run, not a non-event.
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

    return jsonResponse({
      success: true,
      run_id: run.id,
      signals_written: applied.signalsWritten,
      conflicts_written: applied.conflictsWritten,
      write_errors: applied.writeErrors,
      missing_information: parsed.missing_information,
      human_review_required: parsed.human_review_required,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
