/**
 * health-check — daily pipeline health monitor.
 *
 * Runs at 8:00 AM via Make.com S20. Checks that key pipeline
 * processes ran in the last 25 hours. Posts a Slack/email alert
 * if anything looks stale. Returns a status object regardless.
 *
 * POST body: { slack_webhook_url?: string }
 * Env: MAKE_WEBHOOK_SECRET, SLACK_WEBHOOK_URL (optional)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAKE_SECRET       = Deno.env.get('MAKE_WEBHOOK_SECRET') ?? '';
const SLACK_WEBHOOK_URL = Deno.env.get('SLACK_WEBHOOK_URL')   ?? '';

function getServiceClient() {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, { auth: { persistSession: false } });
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!MAKE_SECRET) return json({ error: 'Server misconfigured' }, 500);
  if (req.headers.get('x-make-secret') !== MAKE_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const slackUrl = body.slack_webhook_url ?? SLACK_WEBHOOK_URL;

  const supabase = getServiceClient();
  const since25h = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const now      = new Date();

  const checks = await Promise.all([
    // Leads ingested in last 25h
    supabase.from('isa_leads')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since25h),

    // Touches logged in last 25h (cadence or ISA)
    supabase.from('lead_touches')
      .select('id', { count: 'exact', head: true })
      .gte('touched_at', since25h),

    // Leads enriched in last 25h (ai_summary not null + updated recently)
    supabase.from('isa_leads')
      .select('id', { count: 'exact', head: true })
      .not('ai_summary', 'is', null)
      .gte('updated_at', since25h),

    // Total active pipeline size
    supabase.from('isa_leads')
      .select('id', { count: 'exact', head: true })
      .not('outreach_status', 'in', '("dead","closed")'),

    // Hot leads right now
    supabase.from('isa_leads')
      .select('id', { count: 'exact', head: true })
      .eq('routing', 'hot')
      .not('outreach_status', 'in', '("dead","closed")'),
  ]);

  const [ingestedRes, touchesRes, enrichedRes, activeRes, hotRes] = checks;

  const status = {
    checked_at:         now.toISOString(),
    leads_ingested_24h: ingestedRes.count ?? 0,
    touches_logged_24h: touchesRes.count  ?? 0,
    leads_enriched_24h: enrichedRes.count ?? 0,
    active_pipeline:    activeRes.count   ?? 0,
    hot_leads:          hotRes.count      ?? 0,
    alerts:             [] as string[],
  };

  // Alert conditions
  if (status.leads_ingested_24h === 0) {
    status.alerts.push('No new leads ingested in 24h — check Make.com S1/S5/S13/S14/S15');
  }
  if (status.leads_enriched_24h === 0 && status.active_pipeline > 0) {
    status.alerts.push('No leads enriched in 24h — check enrich-leads function or ANTHROPIC_API_KEY');
  }
  if (status.touches_logged_24h === 0 && status.active_pipeline > 5) {
    status.alerts.push('No touches logged in 24h — cadence may be stalled or ISA not active');
  }
  if (status.hot_leads > 10) {
    status.alerts.push(`${status.hot_leads} hot leads in pipeline — ensure ISAs are working the list`);
  }

  const healthy = status.alerts.length === 0;

  // Post to Slack if there are alerts (or always if configured)
  if (slackUrl && status.alerts.length > 0) {
    const lines = [
      `*InRange Pipeline Alert — ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}*`,
      ...status.alerts.map(a => `• ${a}`),
      `_Active pipeline: ${status.active_pipeline} leads | Hot: ${status.hot_leads} | New today: ${status.leads_ingested_24h}_`,
    ];
    await fetch(slackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    }).catch(() => null);
  }

  return json({ healthy, ...status });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
