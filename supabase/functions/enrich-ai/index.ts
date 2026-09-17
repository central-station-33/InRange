/**
 * enrich-ai — Triggered by Make.com after score-properties completes.
 *
 * Model routing (see docs/model-routing.md): Gemini runs first on every
 * Tier 1–2 property and returns structured JSON (summary + confidence +
 * escalation signals). Claude is invoked only when an escalation
 * condition is met (high deal value, Tier 1/strategic, low Gemini
 * confidence, conflicting sources, complex/LLC ownership, an
 * agent-requested brief, or a flagged second-pass review). Gemini and
 * Claude are never both run on a record by default — only escalations
 * get Claude.
 *
 * Accepts optional POST body:
 *   { limit?: number; min_tier?: 1 | 2; max_tier?: 1 | 2; agent_requested?: boolean; second_pass?: boolean }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import { logActivity } from '../_shared/outreachControls.ts';
import { classifyReviewStatus, shouldEscalateToClaude } from '../_shared/modelRouting.ts';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_MODEL    = 'gemini-2.5-flash';
const GEMINI_URL       = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

interface GeminiExtraction {
  summary: string;
  confidence: number;
  estimated_deal_value: number | null;
  sources_conflict: boolean;
  complex_ownership_chain: boolean;
  multiple_related_properties: boolean;
  llc_unclear_beneficial_owner: boolean;
}

function propertyContext(row: UnenrichedRow): string {
  const flags = row.distress_flags
    .map((f) => `• ${f.type.replace(/_/g, ' ')}: ${f.detail} (${f.source})`)
    .join('\n');
  const components = row.score_components
    .map((c) => `• ${c.name.replace(/_/g, ' ')}: +${c.points} pts — ${c.reason}`)
    .join('\n');

  return `Address:        ${row.address}, ${row.city}, ${row.state}${row.county ? `, ${row.county} County` : ''}
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

const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary:                      { type: 'STRING' },
    confidence:                   { type: 'NUMBER' },
    estimated_deal_value:         { type: 'NUMBER', nullable: true },
    sources_conflict:             { type: 'BOOLEAN' },
    complex_ownership_chain:      { type: 'BOOLEAN' },
    multiple_related_properties:  { type: 'BOOLEAN' },
    llc_unclear_beneficial_owner: { type: 'BOOLEAN' },
  },
  required: [
    'summary', 'confidence', 'sources_conflict', 'complex_ownership_chain',
    'multiple_related_properties', 'llc_unclear_beneficial_owner',
  ],
};

async function callGemini(row: UnenrichedRow): Promise<GeminiExtraction> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const prompt = `You are a real estate data analyst. Analyse this distressed property record and
produce: (1) a concise 3-5 sentence plain-prose investment summary covering why it's
distressed, key risks, the opportunity, and next steps; (2) your confidence (0.0-1.0) in
the accuracy/completeness of this summary given the data provided; (3) an estimated deal
value in USD if determinable from assessed/market value, else null; (4) whether the
distress signals suggest conflicting source data; (5) whether the ownership chain looks
complex (trusts, multiple owners, unclear title); (6) whether this property appears linked
to other related properties; (7) whether the owner appears to be an LLC/entity with unclear
beneficial ownership.

=== Property Data ===
${propertyContext(row)}`;

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_RESPONSE_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no structured output');

  const parsed = JSON.parse(text) as Partial<GeminiExtraction>;
  return {
    summary: parsed.summary ?? '',
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    estimated_deal_value: parsed.estimated_deal_value ?? null,
    sources_conflict: parsed.sources_conflict ?? false,
    complex_ownership_chain: parsed.complex_ownership_chain ?? false,
    multiple_related_properties: parsed.multiple_related_properties ?? false,
    llc_unclear_beneficial_owner: parsed.llc_unclear_beneficial_owner ?? false,
  };
}

async function callClaude(row: UnenrichedRow, escalationReason: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const prompt = `You are an expert real estate investment analyst specialising in distressed properties.
This record was escalated to you for review because: ${escalationReason}.

Analyse the following property and write a concise investment memo (3–5 sentences).
Cover: (1) why this property is distressed, (2) the key risk factors, (3) the investment opportunity,
and (4) any recommended next steps for an investor. Be direct, factual, and use plain language.
Do NOT use bullet points — write in prose.

=== Property Data ===
${propertyContext(row)}`;

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
      system:     'You are a concise real estate investment analyst reviewing an escalated record. Respond in plain prose, 3–5 sentences.',
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errBody}`);
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

  let body: { limit?: number; min_tier?: number; max_tier?: number; agent_requested?: boolean; second_pass?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const limit    = body.limit    ?? 20;
  const minTier  = body.min_tier ?? 1;
  const maxTier  = body.max_tier ?? 2;

  const supabase = getServiceClient();

  try {
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
    let escalated = 0;
    const errors: string[] = [];

    for (const row of rows as UnenrichedRow[]) {
      try {
        const gemini = await callGemini(row);

        const escalationReason = shouldEscalateToClaude({
          tier: row.tier,
          estimatedDealValue: gemini.estimated_deal_value,
          geminiConfidence: gemini.confidence,
          sourcesConflict: gemini.sources_conflict,
          complexOwnershipChain: gemini.complex_ownership_chain,
          multipleRelatedProperties: gemini.multiple_related_properties,
          llcUnclearBeneficialOwner: gemini.llc_unclear_beneficial_owner,
          agentRequestedBrief: body.agent_requested ?? false,
          secondPassReview: body.second_pass ?? false,
        });

        let summary = gemini.summary;
        let enrichmentModel = 'gemini';
        let reviewStatus = classifyReviewStatus(gemini.confidence);

        if (escalationReason) {
          summary = await callClaude(row, escalationReason);
          enrichmentModel = 'gemini+claude';
          reviewStatus = 'claude_review';
          escalated++;
          // Anthropic rate limits — only pace requests that actually hit Claude
          await new Promise((r) => setTimeout(r, 1100));
        }

        const { error: updateErr } = await supabase
          .from('property_scores')
          .update({
            ai_summary: summary,
            enrichment_model: enrichmentModel,
            enrichment_confidence: gemini.confidence,
            escalation_reason: escalationReason,
            review_status: reviewStatus,
          })
          .eq('property_id', row.property_id);
        if (updateErr) throw updateErr;

        await logActivity(supabase, {
          entity_type: 'property_score',
          entity_id: row.id,
          action: escalationReason ? 'escalated_to_claude' : 'enriched_by_gemini',
          detail: {
            property_id: row.property_id,
            confidence: gemini.confidence,
            review_status: reviewStatus,
            escalation_reason: escalationReason,
          },
        });

        enriched++;
      } catch (e) {
        errors.push(`${row.property_id}: ${(e as Error).message}`);
      }
    }

    return jsonResponse({ success: true, enriched, escalated_to_claude: escalated, errors });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
