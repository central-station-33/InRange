/**
 * score-properties — Triggered by Make.com after each ingest run.
 * Reads unscored properties from Supabase, applies the composite scoring
 * algorithm, and writes results to property_scores.
 *
 * Accepts optional POST body:
 *   { source?: 'nyc' | 'nj'; limit?: number }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import { scoreProperty } from '../_shared/scoring.ts';
import type { DistressFlag } from '../_shared/types.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { source?: string; limit?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const supabase = getServiceClient();
  const limit    = body.limit ?? 500;

  try {
    // Pull from the `unscored_properties` view
    let query = supabase
      .from('unscored_properties')
      .select('id, distress_flags')
      .limit(limit);

    if (body.source) query = query.eq('source', body.source);

    const { data: rows, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;
    if (!rows || rows.length === 0) {
      return jsonResponse({ success: true, scored: 0, message: 'No unscored properties' });
    }

    // Score each property and build upsert payload
    const scoreRows = rows.map((row: { id: string; distress_flags: DistressFlag[] }) => {
      const flags = Array.isArray(row.distress_flags) ? row.distress_flags : [];
      const { components, composite_score, tier } = scoreProperty(flags);
      return {
        property_id:      row.id,
        composite_score,
        tier,
        score_components: components,
        ai_summary:       null,
        scored_at:        new Date().toISOString(),
      };
    });

    // Upsert scores in batches
    let scored = 0;
    const BATCH = 100;
    for (let i = 0; i < scoreRows.length; i += BATCH) {
      const { error } = await supabase
        .from('property_scores')
        .upsert(scoreRows.slice(i, i + BATCH), { onConflict: 'property_id' });
      if (error) throw error;
      scored += Math.min(BATCH, scoreRows.length - i);
    }

    // Tier breakdown for the response (useful for Make.com logging)
    const tierCounts = { t1: 0, t2: 0, t3: 0, t4: 0 };
    for (const r of scoreRows) {
      if (r.tier === 1) tierCounts.t1++;
      else if (r.tier === 2) tierCounts.t2++;
      else if (r.tier === 3) tierCounts.t3++;
      else tierCounts.t4++;
    }

    return jsonResponse({ success: true, scored, tier_breakdown: tierCounts });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
