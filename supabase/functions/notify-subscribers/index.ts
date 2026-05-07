/**
 * notify-subscribers — Final step in the Make.com pipeline.
 * Finds Tier 1–2 properties (with AI summaries) that haven't been sent to
 * matching subscribers yet, then delivers notifications via:
 *   - Webhook (Make.com receives and routes to email/SMS/Slack)
 *   - Direct HTTP POST to subscriber.webhook_url (if set)
 *
 * Accepts optional POST body:
 *   { max_tier?: number; limit?: number }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import type { Market, Subscriber } from '../_shared/types.ts';

// Make.com outbound webhook — receives notification payloads and handles delivery
// Set MAKE_NOTIFY_WEBHOOK in Supabase vault/env to enable this channel.
const MAKE_NOTIFY_WEBHOOK = Deno.env.get('MAKE_NOTIFY_WEBHOOK') ?? '';

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
    sent_at:        new Date().toISOString(),
  };
}

async function sendWebhook(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Webhook POST ${res.status}: ${await res.text()}`);
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
      return jsonResponse({ success: true, sent: 0, message: 'No active subscribers' });
    }

    // Fetch new scored properties (with AI summaries) not yet notified to this subscriber
    const { data: properties, error: propErr } = await supabase
      .from('scored_properties')
      .select(
        'id, source, address, city, state, county, owner_name, assessed_value,' +
        'market_value, distress_flags, composite_score, tier, ai_summary',
      )
      .lte('tier', maxTier)
      .not('ai_summary', 'is', null)
      .order('composite_score', { ascending: false })
      .limit(limit);
    if (propErr) throw propErr;
    if (!properties || properties.length === 0) {
      return jsonResponse({ success: true, sent: 0, message: 'No enriched properties to notify' });
    }

    let sent   = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const sub of subscribers as Subscriber[]) {
      const matchingProps = (properties as ScoredProperty[]).filter(
        (p) =>
          p.tier <= sub.min_tier &&  // min_tier means "notify me at this tier or better"
          (sub.target_markets.length === 0 || sub.target_markets.includes(p.source)),
      );

      for (const prop of matchingProps) {
        // Skip if already notified (unique constraint on subscriber+property+channel)
        const channel = sub.webhook_url ? 'webhook' : sub.email ? 'email' : 'sms';

        // Insert notification record (will fail silently on duplicate due to unique constraint)
        const { data: inserted, error: insertErr } = await supabase
          .from('notifications')
          .insert({
            subscriber_id: sub.id,
            property_id:   prop.id,
            channel,
            status:        'pending',
            payload:       buildPayload(prop, sub),
          })
          .select('id')
          .single();

        if (insertErr) {
          // Unique constraint violation = already notified, skip silently
          if (insertErr.code === '23505') { skipped++; continue; }
          errors.push(`Insert ${sub.id}/${prop.id}: ${insertErr.message}`);
          continue;
        }

        // Deliver the notification
        const payload = buildPayload(prop, sub);
        let deliveryError: string | null = null;

        try {
          if (sub.webhook_url) {
            await sendWebhook(sub.webhook_url, payload);
          } else if (MAKE_NOTIFY_WEBHOOK) {
            // Make.com handles email / SMS routing from here
            await sendWebhook(MAKE_NOTIFY_WEBHOOK, payload);
          }
          // If neither is set, we just log the notification as "sent" for Retool visibility
        } catch (e) {
          deliveryError = (e as Error).message;
        }

        // Update notification status
        await supabase
          .from('notifications')
          .update({
            status:        deliveryError ? 'failed' : 'sent',
            sent_at:       deliveryError ? null : new Date().toISOString(),
            error_message: deliveryError,
          })
          .eq('id', inserted.id);

        if (deliveryError) {
          errors.push(`Delivery ${sub.id}/${prop.id}: ${deliveryError}`);
        } else {
          sent++;
        }
      }
    }

    return jsonResponse({ success: true, sent, skipped, errors });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
