/**
 * notify-unclaimed — Pages agents about new unclaimed leads.
 *
 * Finds properties that are scored, unclaimed, and haven't had an alert
 * sent yet (claim_alert_sent_at IS NULL), POSTs each to MAKE_CLAIM_ALERT_WEBHOOK
 * (a Make.com Custom Webhook — see InRange-lead-claim-sms-alert.json), then
 * stamps claim_alert_sent_at so re-running this on a schedule doesn't spam
 * the same lead twice.
 *
 * This replaces the old "ISA Notify Receiver" pattern in the live Make org,
 * which only logged a fake touch and never actually alerted anyone — see
 * docs/lead-claim-mechanism.md.
 *
 * Accepts optional POST body: { limit?: number; segment?: string }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';

const MAKE_CLAIM_ALERT_WEBHOOK = Deno.env.get('MAKE_CLAIM_ALERT_WEBHOOK') ?? '';

interface UnclaimedLead {
  id: string;
  segment: string;
  address: string;
  city: string;
  state: string;
  county: string | null;
  owner_name: string | null;
  composite_score: number;
  tier: number;
  ai_summary: string | null;
  distress_flags: Array<{ type: string; detail: string }>;
  raw_data?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  if (!MAKE_CLAIM_ALERT_WEBHOOK) {
    return jsonResponse({ success: false, error: 'MAKE_CLAIM_ALERT_WEBHOOK is not configured' }, 500);
  }

  let body: { limit?: number; segment?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const limit = body.limit ?? 25;
  const supabase = getServiceClient();

  try {
    let query = supabase
      .from('unclaimed_leads')
      .select('id, segment, address, city, state, county, owner_name, composite_score, tier, ai_summary, distress_flags')
      .is('claim_alert_sent_at', null)
      .order('composite_score', { ascending: false })
      .limit(limit);

    if (body.segment) query = query.eq('segment', body.segment);

    const { data: leads, error } = await query;
    if (error) throw error;
    if (!leads || leads.length === 0) {
      return jsonResponse({ success: true, alerted: 0, message: 'No new unclaimed leads' });
    }

    let alerted = 0;
    const errors: string[] = [];

    for (const lead of leads as UnclaimedLead[]) {
      const flagSummary = lead.distress_flags.map((f) => f.type.replace(/_/g, ' ')).join(', ');
      const smsMessage =
        `New ${lead.segment.replace('_', ' ')} lead — ${lead.address}, ${lead.city}, ${lead.state} ` +
        `(Tier ${lead.tier}, score ${lead.composite_score}). Signals: ${flagSummary}. ` +
        `Claim it: reply CLAIM ${lead.id.slice(0, 8)}`;

      const payload = {
        property_id:     lead.id,
        segment:         lead.segment,
        address:         `${lead.address}, ${lead.city}, ${lead.state}`,
        county:          lead.county,
        owner_name:      lead.owner_name,
        tier:            lead.tier,
        score:           lead.composite_score,
        ai_summary:      lead.ai_summary,
        distress_flags:  flagSummary,
        sms_message:     smsMessage,
        alerted_at:      new Date().toISOString(),
      };

      try {
        const res = await fetch(MAKE_CLAIM_ALERT_WEBHOOK, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Webhook POST ${res.status}: ${await res.text()}`);

        await supabase
          .from('properties')
          .update({ claim_alert_sent_at: new Date().toISOString() })
          .eq('id', lead.id);

        alerted++;
      } catch (e) {
        errors.push(`Alert ${lead.id}: ${(e as Error).message}`);
      }
    }

    return jsonResponse({ success: true, alerted, errors });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
