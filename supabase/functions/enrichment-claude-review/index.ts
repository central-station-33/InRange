/**
 * enrichment-claude-review — POST /enrichment/claude-review
 *
 * Second-pass reviewer. Requires a prior Gemini primary_extraction run to
 * exist for the lead (per the prompt contract: "Review only the supplied
 * evidence and prior Gemini output" — there's nothing to review without
 * it). Never writes confidence='rejected' or 'confirmed_fact' directly —
 * both are reserved for human review actions (see the
 * ai_extraction_never_rejected / ai_extraction_never_confirmed_fact
 * CHECK constraints); Claude's own findings are written as flagged
 * 'hypothesis' rows for a human to resolve, same pattern as
 * apply-gemini-output.ts uses for Gemini's conflicts.
 *
 * NOT LIVE-TESTED — see _shared/claude-client.ts.
 *
 * Body: { lead_id: string }
 */

import { getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';
import { callClaudeJson, CLAUDE_MODEL } from '../_shared/claude-client.ts';
import { buildEvidencePacket } from '../_shared/prompts/evidence-packet.ts';
import type { GeminiLeadBriefResponse } from '../_shared/prompts/gemini-enrichment.ts';
import {
  CLAUDE_ESCALATION_PROMPT_VERSION,
  CLAUDE_ESCALATION_SYSTEM_INSTRUCTION,
  buildClaudeEscalationPrompt,
  parseClaudeEscalationResponse,
} from '../_shared/prompts/claude-escalation.ts';

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
    const { data: geminiRun, error: geminiRunErr } = await supabase
      .from('ai_enrichment_runs')
      .select('id, output')
      .eq('lead_id', body.lead_id)
      .eq('run_type', 'primary_extraction')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (geminiRunErr) throw geminiRunErr;
    if (!geminiRun) {
      return jsonResponse(
        { error: 'No prior Gemini primary_extraction run exists for this lead — nothing to review' },
        409,
      );
    }

    const packet = await buildEvidencePacket(supabase, body.lead_id);
    const evidenceIds = packet.current_facts.map((f) => f.evidence_id);
    const geminiOutput = geminiRun.output as GeminiLeadBriefResponse;
    const prompt = buildClaudeEscalationPrompt(packet, geminiOutput);

    let rawText: string;
    try {
      rawText = await callClaudeJson(CLAUDE_ESCALATION_SYSTEM_INSTRUCTION, prompt);
    } catch (e) {
      await supabase.from('ai_enrichment_runs').insert({
        lead_id: body.lead_id,
        model: CLAUDE_MODEL,
        run_type: 'second_pass_review',
        prompt_version: CLAUDE_ESCALATION_PROMPT_VERSION,
        input_ref: { evidence_ids: evidenceIds, gemini_run_id: geminiRun.id },
        output: { error: (e as Error).message },
        flagged_for_review: true,
      });
      throw e;
    }

    const parsed = parseClaudeEscalationResponse(rawText);

    const { data: run, error: runErr } = await supabase
      .from('ai_enrichment_runs')
      .insert({
        lead_id: body.lead_id,
        model: CLAUDE_MODEL,
        run_type: 'second_pass_review',
        prompt_version: CLAUDE_ESCALATION_PROMPT_VERSION,
        input_ref: { evidence_ids: evidenceIds, gemini_run_id: geminiRun.id },
        output: parsed,
        confidence_score: parsed.confidence,
        flagged_for_review: parsed.human_review_recommended,
      })
      .select()
      .single();
    if (runErr) throw runErr;

    let flagsWritten = 0;
    const writeErrors: string[] = [];

    for (const claim of parsed.unsupported_claims ?? []) {
      const { error } = await supabase.from('lead_evidence').insert({
        lead_id: body.lead_id,
        field_name: 'claude_review_finding',
        field_value: claim.claim,
        confidence: 'hypothesis',
        source_type: 'ai_extraction',
        source_detail: `Claude second-pass, run ${run.id}; evidence: ${(claim.evidence_ids ?? []).join(', ') || 'none'}`,
        ai_run_id: run.id,
        needs_human_review: true,
        review_reason: `Claude: unsupported claim — ${claim.reason}`,
        review_priority: 'high',
      });
      if (error) writeErrors.push(`unsupported claim "${claim.claim}": ${error.message}`);
      else flagsWritten++;
    }

    for (const conflict of parsed.meaningful_conflicts ?? []) {
      const { error } = await supabase.from('lead_evidence').insert({
        lead_id: body.lead_id,
        field_name: conflict.field,
        field_value: '(conflicting — see review_queue for details)',
        confidence: 'hypothesis',
        source_type: 'ai_extraction',
        source_detail: `Claude-flagged conflict, run ${run.id}; evidence: ${(conflict.evidence_ids ?? []).join(', ') || 'none'}`,
        ai_run_id: run.id,
        supersedes_id: conflict.evidence_ids?.[0] ?? null,
        needs_human_review: true,
        review_reason: conflict.description,
        review_priority: 'high',
      });
      if (error) writeErrors.push(`conflict "${conflict.field}": ${error.message}`);
      else flagsWritten++;
    }

    if (parsed.human_review_recommended) {
      await supabase
        .from('lead_records')
        .update({ status: 'needs_verification' })
        .eq('id', body.lead_id)
        .eq('status', 'new'); // don't downgrade a lead already assigned/working
    }

    return jsonResponse({
      success: true,
      run_id: run.id,
      classification_supported: parsed.classification_supported,
      human_review_recommended: parsed.human_review_recommended,
      flags_written: flagsWritten,
      write_errors: writeErrors,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
