/**
 * enrich-ai — Triggered by Make.com after score-properties completes.
 * For each Tier 1 or Tier 2 property that lacks an AI summary, calls the
 * Claude API to produce a plain-language investment memo and stores it in
 * property_scores.ai_summary.
 *
 * Accepts optional POST body:
 *   { limit?: number; min_tier?: 1 | 2; max_tier?: 1 | 2 }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const CLAUDE_MODEL      = 'claude-sonnet-4-6';
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';

interface UnenrichedRow {
  id: string;          // property_scores.id
  property_id: string;
  address: string;
  city: string;
  state: string;
  county: string | null;
  owner_name: string | null;
  property_type: string | null;
  assessed_value: number | null;
  market_value: number | null;
  distress_flags: Array<{ type: string; detail: string; source: string; date?: string }>;
  composite_score: number;
  tier: number;
  score_components: Array<{ name: string; points: number; reason: string }>;
}

function buildPrompt(row: UnenrichedRow): string {
  const flags = row.distress_flags
    .map((f) => `• ${f.type.replace(/_/g, ' ')}: ${f.detail} (${f.source})`)
    .join('\n');

  const components = row.score_components
    .map((c) => `• ${c.name.replace(/_/g, ' ')}: +${c.points} pts — ${c.reason}`)
    .join('\n');

  return `You are an expert real estate investment analyst specialising in distressed properties.

Analyse the following property and write a concise investment memo (3–5 sentences).
Cover: (1) why this property is distressed, (2) the key risk factors, (3) the investment opportunity,
and (4) any recommended next steps for an investor.
Be direct, factual, and use plain language. Do NOT use bullet points — write in prose.

=== Property Data ===
Address:        ${row.address}, ${row.city}, ${row.state}${row.county ? `, ${row.county} County` : ''}
Owner:          ${row.owner_name ?? 'Unknown'}
Property type:  ${row.property_type ?? 'Unknown'}
Assessed value: ${row.assessed_value != null ? `$${row.assessed_value.toLocaleString()}` : 'Unknown'}
Market value:   ${row.market_value  != null ? `$${row.market_value.toLocaleString()}`  : 'Unknown'}
InRange score:  ${row.composite_score}/100 (Tier ${row.tier})

=== Distress Signals ===
${flags || 'None recorded'}

=== Score Components ===
${components || 'None'}`;
}

async function callClaude(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 512,
      system:     'You are a concise real estate investment analyst. Respond in plain prose, 3–5 sentences.',
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }

  const data: { content: Array<{ type: string; text: string }> } = await res.json();
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';
  return text.trim();
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { limit?: number; min_tier?: number; max_tier?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const limit    = body.limit    ?? 20;   // keep batches small — each call costs tokens
  const minTier  = body.min_tier ?? 1;
  const maxTier  = body.max_tier ?? 2;

  const supabase = getServiceClient();

  try {
    // Pull from unenriched_properties view (tier 1 & 2, no ai_summary yet)
    const { data: rows, error: fetchErr } = await supabase
      .from('unenriched_properties')
      .select(
        'id, property_id, address, city, state, county, owner_name, property_type,' +
        'assessed_value, market_value, distress_flags, composite_score, tier, score_components',
      )
      .gte('tier', minTier)
      .lte('tier', maxTier)
      .order('composite_score', { ascending: false })
      .limit(limit);

    if (fetchErr) throw fetchErr;
    if (!rows || rows.length === 0) {
      return jsonResponse({ success: true, enriched: 0, message: 'No unenriched properties' });
    }

    let enriched = 0;
    const errors: string[] = [];

    for (const row of rows as UnenrichedRow[]) {
      try {
        const summary = await callClaude(buildPrompt(row));
        const { error: updateErr } = await supabase
          .from('property_scores')
          .update({ ai_summary: summary })
          .eq('property_id', row.property_id);
        if (updateErr) throw updateErr;
        enriched++;
      } catch (e) {
        errors.push(`${row.property_id}: ${(e as Error).message}`);
      }

      // Respect Anthropic rate limits — 1 request per second is safe for Sonnet
      await new Promise((r) => setTimeout(r, 1100));
    }

    return jsonResponse({ success: true, enriched, errors });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
