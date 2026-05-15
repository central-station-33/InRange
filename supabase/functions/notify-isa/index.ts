/**
 * notify-isa — delivers newly enriched hot/warm leads to assigned ISAs
 * via Make.com webhook (which routes to SMS via Twilio and email).
 *
 * POST body: { routing?: 'hot'|'warm', limit?: number }
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from '../_shared/supabase-client.ts';
import type { EdgeFnResponse } from '../_shared/types.ts';

const MAKE_WEBHOOK_SECRET = Deno.env.get('MAKE_WEBHOOK_SECRET') ?? '';
const MAKE_ISA_WEBHOOK    = Deno.env.get('MAKE_ISA_WEBHOOK') ?? '';   // separate from property webhook

serve(async (req) => {
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (MAKE_WEBHOOK_SECRET && req.headers.get('x-make-secret') !== MAKE_WEBHOOK_SECRET) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  const body  = await req.json().catch(() => ({}));
  const routing: string = body.routing ?? 'hot';
  const limit: number   = body.limit   ?? 50;

  const supabase = createClient();

  // Pull enriched leads that haven't been notified yet (outreach_status = 'new')
  const { data: leads, error } = await supabase
    .from('isa_leads_dashboard')  // uses the view
    .select('*')
    .eq('outreach_status', 'new')
    .eq('routing', routing)
    .not('ai_summary', 'is', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) return json({ success: false, error: error.message }, 500);
  if (!leads || leads.length === 0) return json({ success: true, data: { sent: 0 } });

  let sent = 0;
  const errors: string[] = [];

  for (const lead of leads) {
    try {
      const payload = buildNotificationPayload(lead);

      // Post to Make.com ISA notification webhook
      const res = await fetch(MAKE_ISA_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        errors.push(`Webhook failed for ${lead.id}: ${res.status}`);
        continue;
      }

      // Mark as attempting so we don't re-notify
      await supabase
        .from('leads')
        .update({ outreach_status: 'attempting', updated_at: new Date().toISOString() })
        .eq('id', lead.id);

      sent++;
    } catch (err) {
      errors.push(`Notify failed for ${lead.id}: ${(err as Error).message}`);
    }
  }

  return json({ success: true, data: { sent, errors } });
});

function buildNotificationPayload(lead: Record<string, unknown>) {
  const name         = (lead.full_name ?? lead.entity_name ?? 'Unknown') as string;
  const talkingPts   = (lead.isa_talking_points as string[] ?? []).join('\n• ');
  const contactLine  = lead.rep_phone
    ? `Agent: ${lead.rep_name} — ${lead.rep_phone}`
    : lead.phone
    ? `Direct: ${lead.phone}`
    : lead.email ?? 'Contact TBD';

  return {
    lead_id:          lead.id,
    segment:          lead.segment,
    market:           lead.market,
    routing:          lead.routing,
    name,
    contact:          contactLine,
    ai_summary:       lead.ai_summary,
    talking_points:   talkingPts,
    assigned_isa:     lead.assigned_isa ?? 'unassigned',
    source:           lead.source_name,
    source_url:       lead.source_url,
    // Pre-built SMS message for Twilio (under 160 chars)
    sms_message:      `InRange [${(lead.segment as string).toUpperCase()}] ${name} — ${lead.routing?.toUpperCase()} — ${lead.market?.toUpperCase()}. Open app for full profile.`,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
