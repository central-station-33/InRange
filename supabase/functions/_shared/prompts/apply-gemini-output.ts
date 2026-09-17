/**
 * Shared write-path for a Gemini response, used by both
 * enrichment-gemini-normalize and enrichment-gemini-brief so the
 * evidence-writing logic exists once, not twice.
 *
 * Deliberate mapping decisions (see docs/ai-lead-enrichment-blueprint.md
 * §1/§9/§10 for the underlying rules):
 *
 * - `confirmed_facts` in Gemini's response are NOT written as new
 *   lead_evidence rows. They are Gemini's own reflection of facts that
 *   were already in the evidence packet it was given (their evidence_ids
 *   point back to existing rows) — writing them again would be circular,
 *   and more importantly, an AI model is never allowed to author a
 *   'confirmed_fact' row (see the ai_extraction_never_confirmed_fact
 *   CHECK). The full response is still preserved in
 *   ai_enrichment_runs.output for audit.
 * - `source_supported_signals` ARE written as new rows, but at
 *   confidence='hypothesis', not 'source_supported_signal' — despite
 *   Gemini's own label for them. 'source_supported_signal' in this
 *   schema means a deterministic, rule-derived comparison; an LLM's own
 *   claim about what's "source-supported" is still an LLM claim, and
 *   this repo's confidence taxonomy is a statement about what THIS
 *   system trusts, not a pass-through of whatever a model calls itself.
 * - `data_conflicts` are written as one new row per conflict, flagged
 *   needs_human_review with review_priority='high', superseding the
 *   first referenced evidence_id (supersedes_id is singular; the full
 *   referenced set is preserved in source_detail).
 * - `missing_information` is not written anywhere — its absence from
 *   lead_evidence IS the missing-data state, by design (§10).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { GeminiLeadBriefResponse } from './gemini-enrichment.ts';

// Matches the confidence-threshold default proposed in
// docs/ai-lead-enrichment-blueprint.md §8 (Open decisions) pending JRA
// tuning against real output.
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

export interface ApplyGeminiOutputResult {
  signalsWritten: number;
  conflictsWritten: number;
  writeErrors: string[];
}

export async function applyGeminiOutput(
  supabase: SupabaseClient,
  leadId: string,
  runId: string,
  parsed: GeminiLeadBriefResponse,
): Promise<ApplyGeminiOutputResult> {
  let signalsWritten = 0;
  let conflictsWritten = 0;
  const writeErrors: string[] = [];

  for (const signal of parsed.source_supported_signals ?? []) {
    const lowConfidence = signal.confidence < LOW_CONFIDENCE_THRESHOLD;
    const { error } = await supabase.from('lead_evidence').insert({
      lead_id: leadId,
      field_name: signal.signal_type,
      field_value: signal.summary,
      confidence: 'hypothesis',
      source_type: 'ai_extraction',
      source_detail: `Gemini run ${runId}; evidence: ${(signal.evidence_ids ?? []).join(', ') || 'none'}`,
      ai_run_id: runId,
      needs_human_review: lowConfidence,
      review_reason: lowConfidence ? `Low-confidence Gemini extraction (${signal.confidence})` : null,
      review_priority: lowConfidence ? 'normal' : null,
    });
    if (error) {
      writeErrors.push(`signal "${signal.signal_type}": ${error.message}`);
    } else {
      signalsWritten++;
    }
  }

  for (const conflict of parsed.data_conflicts ?? []) {
    const { error } = await supabase.from('lead_evidence').insert({
      lead_id: leadId,
      field_name: conflict.field,
      field_value: '(conflicting — see review_queue for details)',
      confidence: 'hypothesis',
      source_type: 'ai_extraction',
      source_detail: `Gemini-flagged conflict, run ${runId}; evidence: ${(conflict.evidence_ids ?? []).join(', ') || 'none'}`,
      ai_run_id: runId,
      supersedes_id: conflict.evidence_ids?.[0] ?? null,
      needs_human_review: true,
      review_reason: conflict.description,
      review_priority: 'high',
    });
    if (error) {
      writeErrors.push(`conflict "${conflict.field}": ${error.message}`);
    } else {
      conflictsWritten++;
    }
  }

  return { signalsWritten, conflictsWritten, writeErrors };
}
