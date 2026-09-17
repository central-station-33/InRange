/**
 * Claude prompt contract for second-pass review escalation.
 *
 * CLAUDE_ESCALATION_SYSTEM_INSTRUCTION is copied verbatim from the
 * JRA-specified prompt contract. The spec gave Claude's instruction but,
 * unlike Gemini's, did not give an explicit response JSON schema — only
 * "Return only valid JSON matching the requested schema" with the schema
 * left implicit. ClaudeEscalationResponse below is this repo's own design,
 * derived directly from the instruction's "Do" list (identify unsupported
 * claims, identify meaningful conflicts, state whether evidence supports
 * the classification, recommend human review, produce a supported-only
 * strategy summary). Flag this for JRA/reviewer sign-off before Phase 2
 * goes live — it is the one part of this file that is inferred, not
 * transcribed.
 */

import { formatEvidencePacketForPrompt, type EvidencePacket } from './evidence-packet.ts';
import type { GeminiLeadBriefResponse } from './gemini-enrichment.ts';

export const CLAUDE_ESCALATION_PROMPT_VERSION = 'claude-escalation-v1';

export const CLAUDE_ESCALATION_SYSTEM_INSTRUCTION = `You are a second-pass reviewer for an internal real-estate lead intelligence system.

Review only the supplied evidence and prior Gemini output.

Do:
- Identify unsupported claims
- Identify meaningful conflicts
- State whether available evidence supports the proposed classification
- Recommend whether a human reviewer should intervene
- Produce an internal agent strategy summary only from supported information

Do not:
- Invent facts
- Make legal, title, credit, fair-housing, or consumer-protection decisions
- Infer sensitive personal information or protected characteristics
- Claim a person is motivated, distressed, divorcing, financially impaired, or likely to sell
- Recommend autonomous outreach

Return only valid JSON matching the requested schema`;

export interface ClaudeUnsupportedClaim {
  claim: string;
  reason: string;
  evidence_ids: string[];
}

export interface ClaudeConflict {
  field: string;
  description: string;
  evidence_ids: string[];
}

export interface ClaudeEscalationResponse {
  lead_id: string;
  unsupported_claims: ClaudeUnsupportedClaim[];
  meaningful_conflicts: ClaudeConflict[];
  classification_supported: boolean;
  classification_notes: string;
  human_review_recommended: boolean;
  human_review_reason: string | null;
  agent_strategy_summary: string;
  confidence: number;
}

const REQUIRED_TOP_LEVEL_KEYS: Array<keyof ClaudeEscalationResponse> = [
  'lead_id',
  'unsupported_claims',
  'meaningful_conflicts',
  'classification_supported',
  'classification_notes',
  'human_review_recommended',
  'human_review_reason',
  'agent_strategy_summary',
  'confidence',
];

const CLAUDE_ESCALATION_SCHEMA_SHAPE = {
  lead_id: 'uuid',
  unsupported_claims: [{ claim: 'string', reason: 'string', evidence_ids: ['uuid'] }],
  meaningful_conflicts: [{ field: 'string', description: 'string', evidence_ids: ['uuid'] }],
  classification_supported: true,
  classification_notes: 'string',
  human_review_recommended: true,
  human_review_reason: 'string | null',
  agent_strategy_summary: 'string',
  confidence: 0.0,
};

/**
 * `enrichment-claude-review`: builds the second-pass review prompt from
 * the evidence packet and Gemini's own output. Never recommends
 * autonomous outreach — the schema has no field for it, by design.
 */
export function buildClaudeEscalationPrompt(
  packet: EvidencePacket,
  geminiOutput: GeminiLeadBriefResponse,
): string {
  return `${formatEvidencePacketForPrompt(packet)}

=== Prior Gemini Output ===
${JSON.stringify(geminiOutput, null, 2)}

=== Task ===
Review the Gemini output above against the evidence it was given. Do not
re-derive facts from outside the evidence packet.

Return only valid JSON matching this schema:
${JSON.stringify(CLAUDE_ESCALATION_SCHEMA_SHAPE, null, 2)}`;
}

export function parseClaudeEscalationResponse(raw: string): ClaudeEscalationResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Claude response is not valid JSON: ${(e as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Claude response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in obj)) {
      throw new Error(`Claude response missing required field: ${key}`);
    }
  }

  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
    throw new Error(`Claude response confidence must be a number in [0,1], got: ${obj.confidence}`);
  }

  return obj as unknown as ClaudeEscalationResponse;
}
