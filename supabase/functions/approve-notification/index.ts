/**
 * approve-notification — The ONLY place in this codebase that dispatches an
 * outbound communication. Every call requires a human agent identifier;
 * there is no automated path to this function's "send" branch.
 *
 * POST body:
 *   { notification_id: string; decision: 'approve' | 'reject'; agent: string }
 *
 * On approve:
 *   - Re-checks consent/DNC/eligibility at the moment of send (state may
 *     have changed since the notification was queued).
 *   - Delivers via subscriber.webhook_url or MAKE_NOTIFY_WEBHOOK.
 *   - Records approved_by / approved_at and logs 'sent_after_approval' or
 *     'delivery_failed'.
 *
 * On reject:
 *   - Records rejected_by / rejected_at and logs 'rejected_by_human'.
 *   - No communication is sent.
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import { checkCampaignEligibility, checkConsent, logActivity, requireHumanActor } from '../_shared/outreachControls.ts';
import type { Market, Subscriber } from '../_shared/types.ts';

const MAKE_NOTIFY_WEBHOOK = Deno.env.get('MAKE_NOTIFY_WEBHOOK') ?? '';

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

  let body: { notification_id?: string; decision?: string; agent?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }

  const { notification_id, decision } = body;
  if (!notification_id || (decision !== 'approve' && decision !== 'reject')) {
    return jsonResponse({ error: '{ notification_id, decision: "approve"|"reject", agent } required' }, 400);
  }

  let agent: string;
  try {
    agent = requireHumanActor(body.agent);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 400);
  }

  const supabase = getServiceClient();

  try {
    const { data: notification, error: fetchErr } = await supabase
      .from('notifications')
      .select('*, subscribers(*)')
      .eq('id', notification_id)
      .single();
    if (fetchErr) throw fetchErr;
    if (!notification) return jsonResponse({ error: 'notification not found' }, 404);

    if (notification.status !== 'pending_approval') {
      return jsonResponse(
        { error: `notification is '${notification.status}', not pending_approval` },
        409,
      );
    }

    if (decision === 'reject') {
      await supabase
        .from('notifications')
        .update({ status: 'rejected', rejected_by: agent, rejected_at: new Date().toISOString() })
        .eq('id', notification_id);

      await logActivity(supabase, {
        entity_type: 'notification',
        entity_id: notification_id,
        action: 'rejected_by_human',
        actor: agent,
      });

      return jsonResponse({ success: true, status: 'rejected' });
    }

    // decision === 'approve' — re-verify eligibility right before sending
    const sub = notification.subscribers as Subscriber;
    const propTier   = notification.payload?.tier ?? 99;
    const propSource = (notification.payload?.source ?? '').toLowerCase() as Market;
    const campaignCheck = checkCampaignEligibility(sub, { tier: propTier, source: propSource });
    const consentCheck  = checkConsent(sub);

    if (!consentCheck.eligible) {
      await supabase
        .from('notifications')
        .update({ status: 'blocked', block_reason: consentCheck.reason })
        .eq('id', notification_id);
      await logActivity(supabase, {
        entity_type: 'notification',
        entity_id: notification_id,
        action: `blocked_${consentCheck.reason}`,
        actor: agent,
        detail: { checked_at_approval: true },
      });
      return jsonResponse({ success: false, status: 'blocked', reason: consentCheck.reason }, 409);
    }
    if (!campaignCheck.eligible) {
      await supabase
        .from('notifications')
        .update({ status: 'blocked', block_reason: campaignCheck.reason })
        .eq('id', notification_id);
      await logActivity(supabase, {
        entity_type: 'notification',
        entity_id: notification_id,
        action: `blocked_${campaignCheck.reason}`,
        actor: agent,
        detail: { checked_at_approval: true },
      });
      return jsonResponse({ success: false, status: 'blocked', reason: campaignCheck.reason }, 409);
    }

    await supabase
      .from('notifications')
      .update({ status: 'approved', approved_by: agent, approved_at: new Date().toISOString() })
      .eq('id', notification_id);
    await logActivity(supabase, {
      entity_type: 'notification',
      entity_id: notification_id,
      action: 'approved_by_human',
      actor: agent,
    });

    let deliveryError: string | null = null;
    try {
      const target = sub.webhook_url || MAKE_NOTIFY_WEBHOOK;
      if (!target) throw new Error('No delivery target configured (webhook_url or MAKE_NOTIFY_WEBHOOK)');
      await sendWebhook(target, { ...notification.payload, approved_by: agent, sent_at: new Date().toISOString() });
    } catch (e) {
      deliveryError = (e as Error).message;
    }

    await supabase
      .from('notifications')
      .update({
        status:        deliveryError ? 'failed' : 'sent',
        sent_at:       deliveryError ? null : new Date().toISOString(),
        error_message: deliveryError,
      })
      .eq('id', notification_id);

    await logActivity(supabase, {
      entity_type: 'notification',
      entity_id: notification_id,
      action: deliveryError ? 'delivery_failed' : 'sent_after_approval',
      actor: agent,
      detail: deliveryError ? { error: deliveryError } : {},
    });

    if (deliveryError) return jsonResponse({ success: false, status: 'failed', error: deliveryError }, 502);
    return jsonResponse({ success: true, status: 'sent' });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
