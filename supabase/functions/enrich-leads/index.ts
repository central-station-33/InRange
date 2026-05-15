/**
 * enrich-leads — Claude AI enrichment for ISA leads.
 * Scores BANT, motivation, routing, writes talking points.
 *
 * POST body: { limit?: number, segment?: string, routing?: string }
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const MAKE_SECRET       = Deno.env.get('MAKE_WEBHOOK_SECRET') ?? '';

serve(async (req) => {
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!MAKE_SECRET) return json({ success: false, error: 'Server misconfigured' }, 500);
  if (req.headers.get('x-make-secret') !== MAKE_SECRET) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const limit: number   = body.limit   ?? 30;
  const segment: string = body.segment ?? '';

  const supabase = getServiceClient();

  // Newest-first so freshly ingested hot leads (athletes, new signings)
  // get enriched within hours rather than days behind older nurture leads.
  let query = supabase
    .from('isa_leads')
    .select('*')
    .is('ai_summary', null)
    .not('outreach_status', 'in', '("dead","closed")')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (segment) query = query.eq('segment', segment);

  const { data: leads, error } = await query;
  if (error) return json({ success: false, error: error.message }, 500);
  if (!leads?.length) return json({ success: true, data: { enriched: 0 } });

  let enriched = 0;
  const errors: string[] = [];

  for (const lead of leads) {
    try {
      const result = await callClaude(buildPrompt(lead));
      await supabase.from('isa_leads').update({
        ai_summary:         result.ai_summary,
        isa_talking_points: result.isa_talking_points,
        bant_score:         result.bant_score,
        motivation_score:   result.motivation_score,
        routing:            result.routing,
        updated_at:         new Date().toISOString(),
      }).eq('id', lead.id);
      enriched++;
    } catch (err) {
      errors.push(`${lead.id}: ${(err as Error).message}`);
    }
  }

  return json({ success: true, data: { enriched, errors } });
});

function buildPrompt(lead: Record<string, unknown>): string {
  const signals = (lead.motivation_signals as string[] ?? []).join(', ');
  return `You are an expert NY/NJ real estate ISA coach. Analyze this prospect and return JSON only.

PROSPECT:
Segment: ${lead.segment} | Market: ${lead.market}
Name: ${lead.full_name ?? lead.entity_name ?? 'Unknown'}
${lead.team_name       ? `Team: ${lead.team_name}`                           : ''}
${lead.sport           ? `Sport: ${lead.sport}`                              : ''}
${lead.contract_value  ? `Contract: $${Number(lead.contract_value).toLocaleString()}` : ''}
${lead.employer        ? `Employer: ${lead.employer}`                        : ''}
${lead.origin_country  ? `From: ${lead.origin_country}`                      : ''}
${lead.production_name ? `Production: ${lead.production_name}`               : ''}
${lead.property_address ? `Property: ${lead.property_address}`               : ''}
${lead.price_range_min  ? `Budget: $${Number(lead.price_range_min).toLocaleString()}–$${Number(lead.price_range_max).toLocaleString()}` : ''}
Signals: ${signals || 'None captured'}
Source: ${lead.source_name ?? 'unknown'}

Return ONLY valid JSON:
{
  "ai_summary": "<2 sentences: who this is + why they need real estate NOW>",
  "isa_talking_points": [
    "<specific talking point 1 — reference their actual situation>",
    "<talking point 2>",
    "<talking point 3>"
  ],
  "bant_score": <0-12>,
  "motivation_score": <1-5>,
  "routing": "<hot|warm|nurture|cold>"
}

ROUTING: hot = bant≥9 AND motivation≥4 | warm = bant≥7 OR motivation≥3 | nurture = bant≥4 | cold = else
Be specific — reference the person's actual team, contract, production, or situation.`;
}

async function callClaude(prompt: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  const raw  = (data.content[0]?.text ?? '{}');
  // Robustly extract JSON — strip markdown fences then find first { ... } block.
  const stripped = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const start    = stripped.indexOf('{');
  const end      = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in Claude response');
  return JSON.parse(stripped.slice(start, end + 1));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
