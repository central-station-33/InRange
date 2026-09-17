/**
 * Outreach controls — shared guardrails for anything that could result in an
 * external communication (email, SMS, call, voicemail) or a change to a
 * person's consent/DNC/contactable status.
 *
 * Hard rule enforced here: nothing in this codebase sends a message,
 * enrolls someone in a campaign, or changes consent/DNC/contactable state
 * without a human actor attached. Automated code may only check eligibility
 * and queue a notification for approval — never dispatch it.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { Market, Subscriber } from './types.ts';

export interface EligibilityResult {
  eligible: boolean;
  reason: string | null; // set when eligible === false
}

/** Campaign eligibility: is this subscriber even a candidate for this property? */
export function checkCampaignEligibility(
  sub: Subscriber,
  prop: { tier: number; source: Market },
): EligibilityResult {
  if (!sub.active) return { eligible: false, reason: 'subscriber_inactive' };
  if (prop.tier > sub.min_tier) return { eligible: false, reason: 'tier_below_threshold' };
  if (sub.target_markets.length > 0 && !sub.target_markets.includes(prop.source)) {
    return { eligible: false, reason: 'market_not_targeted' };
  }
  return { eligible: true, reason: null };
}

/** Consent + DNC: has a human explicitly cleared this subscriber to be contacted? */
export function checkConsent(sub: Subscriber): EligibilityResult {
  if (sub.dnc) return { eligible: false, reason: 'dnc' };
  if (sub.consent_status !== 'opted_in') return { eligible: false, reason: 'consent_not_opted_in' };
  if (!sub.contactable) return { eligible: false, reason: 'not_marked_contactable' };
  return { eligible: true, reason: null };
}

export interface ActivityLogEntry {
  entity_type: 'notification' | 'subscriber' | 'property_score';
  entity_id: string | null;
  action: string;
  actor?: string; // defaults to 'system' — pass a human identifier for approvals/rejections/opt-outs
  detail?: Record<string, unknown>;
}

export async function logActivity(supabase: SupabaseClient, entry: ActivityLogEntry): Promise<void> {
  const { error } = await supabase.from('activity_log').insert({
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    action: entry.action,
    actor: entry.actor ?? 'system',
    detail: entry.detail ?? {},
  });
  // Logging must never block the outreach-control decision it's recording,
  // but a failure here is worth surfacing to the caller's error list.
  if (error) throw new Error(`activity_log insert failed: ${error.message}`);
}

/**
 * Requires a non-empty, non-generic human identifier for any action that
 * approves, rejects, or changes consent/DNC state. Rejects calls that try
 * to pass "system" or "automation" as the actor for a human-gated action.
 */
export function requireHumanActor(actor: unknown): string {
  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new Error('A human agent identifier (approved_by/rejected_by) is required for this action');
  }
  const normalized = actor.trim().toLowerCase();
  if (['system', 'automation', 'bot', 'ai', 'claude', 'gemini'].includes(normalized)) {
    throw new Error('This action requires a human agent identifier, not an automated actor');
  }
  return actor.trim();
}
