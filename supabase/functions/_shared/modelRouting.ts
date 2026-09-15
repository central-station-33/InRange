/**
 * Model routing — Gemini is the default enrichment model; Claude is a
 * selective escalation model, invoked only when one of the documented
 * conditions applies. Never run both on every record.
 */

export interface EscalationSignals {
  tier: number;                    // 1 (hottest) – 4; tier 1 == "priority A"
  manuallyStrategic?: boolean;
  estimatedDealValue: number | null;
  geminiConfidence: number;        // 0..1
  sourcesConflict?: boolean;       // two authoritative records disagree
  complexOwnershipChain?: boolean;
  multipleRelatedProperties?: boolean;
  llcUnclearBeneficialOwner?: boolean;
  agentRequestedBrief?: boolean;
  outreachSequenceNeeded?: boolean;
  secondPassReview?: boolean;
}

const DEFAULT_DEAL_VALUE_THRESHOLD = 400_000;

function dealValueThreshold(): number {
  const raw = Deno.env.get('CLAUDE_ESCALATION_DEAL_VALUE_THRESHOLD');
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEAL_VALUE_THRESHOLD;
}

/**
 * Returns the escalation reason if Claude should review this record,
 * or null if Gemini's first-pass output is sufficient.
 */
export function shouldEscalateToClaude(signals: EscalationSignals): string | null {
  const threshold = dealValueThreshold();

  if (signals.estimatedDealValue != null && signals.estimatedDealValue > threshold) {
    return `deal_value_above_threshold (${signals.estimatedDealValue} > ${threshold})`;
  }
  if (signals.tier === 1 || signals.manuallyStrategic) {
    return 'priority_a_or_strategic';
  }
  if (signals.geminiConfidence < 0.80) {
    return `gemini_confidence_below_0.80 (${signals.geminiConfidence.toFixed(2)})`;
  }
  if (signals.sourcesConflict) {
    return 'conflicting_authoritative_sources';
  }
  if (signals.complexOwnershipChain) {
    return 'complex_ownership_chain';
  }
  if (signals.multipleRelatedProperties) {
    return 'multiple_related_properties';
  }
  if (signals.llcUnclearBeneficialOwner) {
    return 'llc_unclear_beneficial_owner';
  }
  if (signals.agentRequestedBrief) {
    return 'agent_requested_strategy_brief';
  }
  if (signals.outreachSequenceNeeded) {
    return 'polished_outreach_sequence_needed';
  }
  if (signals.secondPassReview) {
    return 'second_pass_quality_review';
  }
  return null;
}

export type ReviewStatus = 'auto_accepted' | 'agent_review' | 'claude_review' | 'human_review';

/**
 * Confidence-band routing per policy thresholds. Note this reflects the
 * FINAL confidence (post-Claude if escalated, otherwise Gemini's), and
 * 'human_review' records must be excluded from campaign eligibility
 * (enforced separately by the campaign_eligible_properties view).
 */
export function classifyReviewStatus(confidence: number): ReviewStatus {
  if (confidence >= 0.90) return 'auto_accepted';
  if (confidence >= 0.80) return 'agent_review';
  if (confidence >= 0.70) return 'claude_review';
  return 'human_review';
}
