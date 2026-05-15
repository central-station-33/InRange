/**
 * enrich-leads — Claude AI enrichment for ISA leads.
 *
 * For each unenriched lead (ai_summary IS NULL), calls Claude to:
 *   1. Write a 2-sentence ISA brief
 *   2. Generate 3 specific talking points for first contact
 *   3. Score BANT (0–12) and motivation (1–5) and set routing
 *
 * POST body: { limit?: number, segment?: string }
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from '../_shared/supabase-client.ts';
import type { Lead, LeadRouting, EdgeFnResponse } from '../_shared/types.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const MAKE_SECRET       = Deno.env.get('MAKE_WEBHOOK_SECRET') ?? '';

serve(async (req) => {
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (MAKE_SECRET && req.headers.get('x-make-secret') !== MAKE_SECRET) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const limit: number   = body.limit   ?? 30;
  const segment: string = body.segment ?? '';

  const supabase = createClient();

  // Fetch unenriched leads
  let query = supabase
    .from('leads')
    .select('*')
    .is('ai_summary', null)
    .neq('outreach_status', 'dead')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (segment) query = query.eq('segment', segment);

  const { data: leads, error: fetchError } = await query;
  if (fetchError) return json({ success: false, error: fetchError.message }, 500);
  if (!leads || leads.length === 0) return json({ success: true, data: { enriched: 0 } });

  let enriched = 0;
  const errors: string[] = [];

  for (const lead of leads as Lead[]) {
    try {
      const prompt = buildPrompt(lead);
      const aiResult = await callClaude(prompt);

      const { bant_score, motivation_score, routing, ai_summary, isa_talking_points } = aiResult;

      const { error: updateError } = await supabase
        .from('leads')
        .update({
          ai_summary,
          isa_talking_points,
          bant_score,
          motivation_score,
          routing,
          updated_at: new Date().toISOString(),
        })
        .eq('id', lead.id);

      if (updateError) errors.push(`Update failed for ${lead.id}: ${updateError.message}`);
      else enriched++;
    } catch (err) {
      errors.push(`Enrichment failed for ${lead.id}: ${(err as Error).message}`);
    }
  }

  return json({ success: true, data: { enriched, errors } });
});

function buildPrompt(lead: Lead): string {
  return `You are an expert real estate ISA coach. Analyze this prospect and return a JSON object.

PROSPECT DATA:
Segment: ${lead.segment}
Market: ${lead.market}
Name: ${lead.full_name ?? lead.entity_name ?? 'Unknown'}
${lead.team_name    ? `Team: ${lead.team_name}`                    : ''}
${lead.sport        ? `Sport: ${lead.sport}`                       : ''}
${lead.contract_value ? `Contract Value: $${lead.contract_value.toLocaleString()}` : ''}
${lead.employer     ? `Employer: ${lead.employer}`                 : ''}
${lead.origin_country ? `Origin Country: ${lead.origin_country}`  : ''}
${lead.production_name ? `Production: ${lead.production_name}`    : ''}
${lead.property_address ? `Property: ${lead.property_address}`    : ''}
Motivation Signals: ${JSON.stringify(lead.motivation_signals)}
Source: ${lead.source_name ?? 'unknown'}

TASK: Return ONLY valid JSON with these exact keys:
{
  "ai_summary": "<2 sentences: who this is and why they're a real estate prospect right now>",
  "isa_talking_points": [
    "<talking point 1 — specific, not generic>",
    "<talking point 2>",
    "<talking point 3>"
  ],
  "bant_score": <integer 0-12>,
  "motivation_score": <integer 1-5>,
  "routing": "<hot|warm|nurture|cold>"
}

ROUTING RULES:
- hot: bant_score >= 9 AND motivation_score >= 4
- warm: bant_score >= 7 OR motivation_score >= 3
- nurture: bant_score >= 4
- cold: everything else

Be specific. Reference the actual person, team, contract, or situation in your talking points.`;
}

async function callClaude(prompt: string): Promise<{
  ai_summary: string;
  isa_talking_points: string[];
  bant_score: number;
  motivation_score: number;
  routing: LeadRouting;
}> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);

  const data = await res.json();
  const text = data.content[0]?.text ?? '{}';

  // Strip markdown code fences if present
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(clean);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
