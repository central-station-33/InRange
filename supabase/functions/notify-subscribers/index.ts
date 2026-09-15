/**
 * notify-subscribers — Queues (never sends) notifications for Tier 1–2
 * properties to matching subscribers.
 *
 * Outreach controls: this function NEVER dispatches an email, SMS, call,
 * or webhook on its own. For every subscriber/property match it runs a
 * campaign eligibility check and a consent/DNC check, then inserts a
 * `notifications` row with status='pending_approval'. Actual delivery only
 * happens through the `approve-notification` function, which requires a
 * human agent identifier. Every decision (queued, blocked, and why) is
 * written to `activity_log`.
 *
 * Accepts optional POST body:
 *   { max_tier?: number; limit?: number }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import { checkCampaignEligibility, checkConsent, logActivity } from '../_shared/outreachControls.ts';
import type { Market, Subscriber } from '../_shared/types.ts';

interface ScoredProperty {
  id: string;
  source: Market;
  address: string;
  city: string;
  state: string;
  county: string | null;
  owner_name: string | null;
  assessed_value: number | null;
  market_value: number | null;
  distress_flags: Array<{ type: string; detail: string }>;
  composite_score: number;
  tier: number;
  ai_summary: string | null;
}

function buildPayload(prop: ScoredProperty, sub: Subscriber) {
  const flagSummary = prop.distress_flags
    .map((f) => f.type.replace(/_/g, ' '))
    .join(', ');

  return {
    subscriber_id:  sub.id,
    subscriber_name: sub.name ?? 'Subscriber',
    email:          sub.email,
    phone:          sub.phone,
    property_id:    prop.id,
    tier:           prop.tier,
    score:          prop.composite_score,
    address:        `${prop.address}, ${prop.city}, ${prop.state}`,
    county:         prop.county,
    owner:          prop.owner_name,
    assessed_value: prop.assessed_value,
    market_value:   prop.market_value,
    distress_flags: flagSummary,
    ai_summary:     prop.ai_summary,
    source:         prop.source.toUpperCase(),
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { max_tier?: number; limit?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const maxTier = body.max_tier ?? 2;
  const limit   = body.limit   ?? 100;

  const supabase = getServiceClient();

  try {
    // Fetch active subscribers
    const { data: subscribers, error: subErr } = await supabase
      .from('subscribers')
      .select('*')
      .eq('active', true);
    if (subErr) throw subErr;
    if (!subscribers || subscribers.length === 0) {
      return jsonResponse({ success: true, queued: 0, message: 'No active subscribers' });
    }

    // Only properties whose enrichment cleared the model-routing quality bar
    // (review_status not 'pending'/'human_review') are eligible for outreach.
    const { data: properties, error: propErr } = await supabase
      .from('campaign_eligible_properties')
      .select(
        'id, source, address, city, state, county, owner_name, assessed_value,' +
        'market_value, distress_flags, composite_score, tier, ai_summary',
      )
      .lte('tier', maxTier)
      .order('composite_score', { ascending: false })
      .limit(limit);
    if (propErr) throw propErr;
    if (!properties || properties.length === 0) {
      return jsonResponse({ success: true, queued: 0, message: 'No campaign-eligible properties' });
    }

    let queued  = 0;
    let blocked = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const sub of subscribers as Subscriber[]) {
      // Campaign eligibility check: is this subscriber even a candidate for
      // these properties (tier/market/active)? Non-matches are simply not
      // candidates for this campaign — no notification row is created for
      // them, same as before this policy was enforced.
      const matchingProps = (properties as ScoredProperty[]).filter(
        (p) => checkCampaignEligibility(sub, p).eligible,
      );
      if (matchingProps.length === 0) continue;

      // Consent/DNC check: for candidates that DO match, has a human
      // cleared this subscriber to be contacted? A failure here is a real
      // outreach-control decision and is logged per matched property.
      const consentCheck = checkConsent(sub);

      for (const prop of matchingProps) {
        const channel = sub.webhook_url ? 'webhook' : sub.email ? 'email' : 'sms';

        const { data: inserted, error: insertErr } = await supabase
          .from('notifications')
          .insert({
            subscriber_id:       sub.id,
            property_id:         prop.id,
            channel,
            status:               consentCheck.eligible ? 'pending_approval' : 'blocked',
            eligibility_checked:  true,
            consent_verified:     consentCheck.eligible,
            block_reason:         consentCheck.eligible ? null : consentCheck.reason,
            payload:              buildPayload(prop, sub),
          })
          .select('id')
          .single();

        if (insertErr) {
          // Unique constraint violation = already queued/handled for this pair, skip silently
          if (insertErr.code === '23505') { skipped++; continue; }
          errors.push(`Insert ${sub.id}/${prop.id}: ${insertErr.message}`);
          continue;
        }

        try {
          if (consentCheck.eligible) {
            await logActivity(supabase, {
              entity_type: 'notification',
              entity_id: inserted.id,
              action: 'queued_for_approval',
              detail: { subscriber_id: sub.id, property_id: prop.id, channel },
            });
            queued++;
          } else {
            await logActivity(supabase, {
              entity_type: 'notification',
              entity_id: inserted.id,
              action: `blocked_${consentCheck.reason}`,
              detail: { subscriber_id: sub.id, property_id: prop.id, channel },
            });
            blocked++;
          }
        } catch (e) {
          errors.push(`activity_log ${sub.id}/${prop.id}: ${(e as Error).message}`);
        }
      }
    }

    return jsonResponse({
      success: true,
      queued,
      blocked,
      skipped,
      errors,
      note: 'Notifications are queued with status=pending_approval. Nothing is sent until a human agent calls approve-notification.',
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
