/**
 * notify-isa — pushes newly enriched hot/warm leads to assigned ISAs.
 * Uses the isa_pipeline view. Routes hot leads to SMS+email, warm to Slack.
 *
 * POST body: { routing: 'hot'|'warm', limit?: number }
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const MAKE_SECRET      = Deno.env.get('MAKE_WEBHOOK_SECRET') ?? '';
const MAKE_ISA_WEBHOOK = Deno.env.get('MAKE_ISA_WEBHOOK') ?? '';

const CONCURRENCY = 5; // max parallel webhook calls to Make.com

serve(async (req) => {
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!MAKE_SECRET) return json({ success: false, error: 'Server misconfigured' }, 500);
  if (req.headers.get('x-make-secret') !== MAKE_SECRET) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }
  if (!MAKE_ISA_WEBHOOK) return json({ success: false, error: 'MAKE_ISA_WEBHOOK not configured' }, 500);

  const body    = await req.json().catch(() => ({}));
  const routing: string = body.routing ?? 'hot';
  const limit: number   = body.limit   ?? 50;

  const supabase = getServiceClient();

  const { data: leads, error } = await supabase
    .from('isa_pipeline')
    .select('*')
    .eq('outreach_status', 'new')
    .eq('routing', routing)
    .not('ai_summary', 'is', null)
    .order('bant_score', { ascending: false })
    .limit(limit);

  if (error) return json({ success: false, error: error.message }, 500);
  if (!leads?.length) return json({ success: true, data: { sent: 0 } });

  let sent = 0;
  const errors: string[] = [];

  // Process in batches of CONCURRENCY to avoid edge function timeout
  // (sequential at 50 leads × ~1s/webhook = 50s, which exceeds the 60s limit).
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(lead => notifyOne(lead, routing, supabase))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) sent++;
      else if (r.status === 'rejected') errors.push(r.reason?.message ?? 'Unknown error');
      else if (r.status === 'fulfilled' && !r.value.ok) errors.push(r.value.error);
    }
  }

  return json({ success: true, data: { sent, errors } });
});

async function notifyOne(
  lead: Record<string, unknown>,
  routing: string,
  supabase: ReturnType<typeof getServiceClient>
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(MAKE_ISA_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayload(lead, routing)),
  });

  if (!res.ok) return { ok: false, error: `Webhook ${lead.id}: ${res.status}` };

  await supabase
    .from('isa_leads')
    .update({ outreach_status: 'attempting', updated_at: new Date().toISOString() })
    .eq('id', lead.id);

  return { ok: true };
}

function buildPayload(lead: Record<string, unknown>, routing: string) {
  const name    = (lead.full_name ?? lead.entity_name ?? 'Unknown') as string;
  const pts     = (lead.isa_talking_points as string[] ?? []).join('\n• ');
  const contact = lead.rep_phone
    ? `Rep: ${lead.rep_name} — ${lead.rep_phone}`
    : lead.phone ? `Direct: ${lead.phone}`
    : lead.email ?? 'TBD';

  const splitLabel = (lead.commission_source as string) === 'brokerage_provided'
    ? '50/50 split'
    : (lead.commission_source as string) === 'agent_sourced'
    ? 'Agent split + override'
    : '85% to you (self-sourced)';

  return {
    lead_id:          lead.id,
    segment:          lead.segment,
    market:           ((lead.market as string) ?? '').toUpperCase(),
    routing:          routing.toUpperCase(),
    name,
    contact,
    ai_summary:       lead.ai_summary,
    talking_points:   pts ? `• ${pts}` : '',
    bant_score:       lead.bant_score,
    motivation_score: lead.motivation_score,
    assigned_agent:   lead.agent_name ?? 'Unassigned',
    assigned_isa:     lead.assigned_isa ?? 'Unassigned',
    commission_note:  splitLabel,
    source:           lead.source_name,
    source_url:       lead.source_url,
    sms_message:      `InRange [${(lead.segment as string ?? '').toUpperCase()}] ${name} — ${routing.toUpperCase()} lead, ${((lead.market as string) ?? '').toUpperCase()}. Check app.`,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
