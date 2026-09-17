/**
 * Gemini prompt contract for lead enrichment (normalize + brief).
 *
 * The system instruction and response schema below are copied verbatim
 * from the JRA-specified prompt contract. Do not edit the wording of
 * GEMINI_SYSTEM_INSTRUCTION or the schema shape without updating
 * GEMINI_PROMPT_VERSION — every ai_enrichment_runs row records which
 * version produced it (see docs/ai-lead-enrichment-blueprint.md §10 and
 * the review_queue view), specifically so a prompt change's effect on
 * outcomes can be evaluated later.
 */

import { formatEvidencePacketForPrompt, type EvidencePacket } from './evidence-packet.ts';

export const GEMINI_PROMPT_VERSION = 'gemini-lead-brief-v1';

export const GEMINI_SYSTEM_INSTRUCTION = `You are an internal real-estate data-enrichment assistant.

Your task is to extract, normalize, reconcile, and summarize only the information present in the provided evidence packet.

Rules:
1. Do not invent facts, names, addresses, ownership, contact information, intent, motivation, legal conclusions, or financial conclusions.
2. Clearly separate confirmed facts, source-supported signals, unknowns, and conflicts.
3. Preserve source identifiers supplied in the evidence packet.
4. If evidence is insufficient, return null or "unknown".
5. Do not infer or discuss protected characteristics or sensitive personal information.
6. Do not determine campaign eligibility, consent, DNC status, or legal compliance.
7. Return only valid JSON matching the requested schema.
8. Include confidence from 0 to 1 for each extracted claim.
9. Explain uncertainty briefly in a field called uncertainty_notes.
10. Recommend a human review when core facts conflict or confidence is below the threshold.`;

export interface GeminiClaim {
  claim: string;
  value: string;
  evidence_ids: string[];
  confidence: number;
}

export interface GeminiSignal {
  signal_type: string;
  summary: string;
  evidence_ids: string[];
  confidence: number;
}

export interface GeminiConflict {
  field: string;
  description: string;
  evidence_ids: string[];
  human_review_required: true;
}

export interface GeminiLeadBriefResponse {
  lead_id: string;
  confirmed_facts: GeminiClaim[];
  source_supported_signals: GeminiSignal[];
  data_conflicts: GeminiConflict[];
  missing_information: string[];
  suggested_next_research_action: string;
  suggested_agent_next_action: string;
  suggested_outreach_angle: string;
  human_review_required: boolean;
  overall_confidence: number;
  uncertainty_notes: string[];
}

const REQUIRED_TOP_LEVEL_KEYS: Array<keyof GeminiLeadBriefResponse> = [
  'lead_id',
  'confirmed_facts',
  'source_supported_signals',
  'data_conflicts',
  'missing_information',
  'suggested_next_research_action',
  'suggested_agent_next_action',
  'suggested_outreach_angle',
  'human_review_required',
  'overall_confidence',
  'uncertainty_notes',
];

/**
 * `enrichment-gemini-normalize`: first-pass extraction/reconciliation.
 * Asks Gemini to populate confirmed_facts, source_supported_signals,
 * data_conflicts, missing_information, and uncertainty_notes from the raw
 * evidence packet. The remaining schema fields (the suggested-action
 * fields, human_review_required, overall_confidence) are still required
 * by the schema but should be treated as provisional at this stage —
 * enrichment-gemini-brief (below) is the step that synthesizes them
 * properly once normalization has run.
 */
export function buildNormalizePrompt(packet: EvidencePacket): string {
  return `${formatEvidencePacketForPrompt(packet)}

=== Task ===
Extract, normalize, and reconcile the evidence above. Focus on
confirmed_facts, source_supported_signals, data_conflicts,
missing_information, and uncertainty_notes. Do not skip the other fields
in the schema — fill suggested_next_research_action and
suggested_agent_next_action with your best low-effort assessment at this
stage (a deeper pass happens later), and set overall_confidence to reflect
how complete this evidence packet is, not a prediction about the lead
itself.

Return only valid JSON matching this schema:
${JSON.stringify(GEMINI_LEAD_BRIEF_SCHEMA_SHAPE, null, 2)}`;
}

/**
 * `enrichment-gemini-brief`: second pass over already-normalized evidence
 * (plus, optionally, the prior normalize call's own output as additional
 * context) — synthesizes the next-action and outreach-angle fields
 * properly.
 */
export function buildLeadBriefPrompt(
  packet: EvidencePacket,
  priorNormalizeOutput?: GeminiLeadBriefResponse,
): string {
  const priorContext = priorNormalizeOutput
    ? `\n\n=== Prior normalization pass ===\n${JSON.stringify(priorNormalizeOutput, null, 2)}`
    : '';

  return `${formatEvidencePacketForPrompt(packet)}${priorContext}

=== Task ===
Produce the full lead brief: confirmed facts, source-supported signals,
data conflicts, missing information, a suggested next research action, a
suggested agent next action, a suggested outreach angle, whether human
review is required, your overall confidence, and any uncertainty notes.
suggested_outreach_angle must be grounded only in confirmed_facts and
source_supported_signals already present — never invent motivation, intent
to sell, or any detail not already evidenced.

Return only valid JSON matching this schema:
${JSON.stringify(GEMINI_LEAD_BRIEF_SCHEMA_SHAPE, null, 2)}`;
}

// Illustrative shape embedded in the prompt itself so the model sees the
// exact field names/types expected — not used for runtime validation
// (see parseGeminiLeadBriefResponse for that).
const GEMINI_LEAD_BRIEF_SCHEMA_SHAPE = {
  lead_id: 'uuid',
  confirmed_facts: [{ claim: 'string', value: 'string', evidence_ids: ['uuid'], confidence: 0.0 }],
  source_supported_signals: [
    { signal_type: 'string', summary: 'string', evidence_ids: ['uuid'], confidence: 0.0 },
  ],
  data_conflicts: [
    { field: 'string', description: 'string', evidence_ids: ['uuid'], human_review_required: true },
  ],
  missing_information: ['string'],
  suggested_next_research_action: 'string',
  suggested_agent_next_action: 'string',
  suggested_outreach_angle: 'string',
  human_review_required: true,
  overall_confidence: 0.0,
  uncertainty_notes: ['string'],
};

/**
 * Parses and shape-checks a Gemini response. Throws with a specific
 * message identifying what's missing/wrong rather than a generic JSON
 * parse error, since a malformed response should fail the enrichment job
 * loudly (see _shared/jobs.ts) rather than write a half-populated
 * lead_evidence row.
 */
export function parseGeminiLeadBriefResponse(raw: string): GeminiLeadBriefResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Gemini response is not valid JSON: ${(e as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Gemini response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in obj)) {
      throw new Error(`Gemini response missing required field: ${key}`);
    }
  }

  if (typeof obj.overall_confidence !== 'number' || obj.overall_confidence < 0 || obj.overall_confidence > 1) {
    throw new Error(`Gemini response overall_confidence must be a number in [0,1], got: ${obj.overall_confidence}`);
  }

  return obj as unknown as GeminiLeadBriefResponse;
}
