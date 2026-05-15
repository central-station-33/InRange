/**
 * ingest-leads — receives structured lead payloads from Make.com
 * (which has already run the appropriate Apify actor) and upserts
 * them into the leads table.
 *
 * Called by Make.com after each Apify actor run, once per segment.
 *
 * POST body:
 * {
 *   segment: LeadSegment,
 *   market: 'nyc' | 'nj',
 *   leads: Lead[]         // array of raw lead objects
 * }
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from '../_shared/supabase-client.ts';
import type { Lead, LeadIngestionResult, EdgeFnResponse } from '../_shared/types.ts';

const MAKE_SECRET = Deno.env.get('MAKE_WEBHOOK_SECRET') ?? '';

serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405);
  }

  if (MAKE_SECRET && req.headers.get('x-make-secret') !== MAKE_SECRET) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  let body: { segment: string; market: string; leads: Partial<Lead>[] };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { segment, market, leads } = body;

  if (!segment || !market || !Array.isArray(leads)) {
    return json({ success: false, error: 'segment, market, and leads[] are required' }, 400);
  }

  const supabase = createClient();
  const result: LeadIngestionResult = {
    segment: segment as Lead['segment'],
    market: market as Lead['market'],
    records_fetched: leads.length,
    records_upserted: 0,
    errors: [],
  };

  for (const raw of leads) {
    try {
      const lead: Partial<Lead> = {
        segment: segment as Lead['segment'],
        market: market as Lead['market'],
        routing: raw.routing ?? 'new',
        outreach_status: raw.outreach_status ?? 'new',
        motivation_signals: raw.motivation_signals ?? [],
        isa_talking_points: raw.isa_talking_points ?? [],
        raw_data: raw.raw_data ?? {},
        ...raw,
      };

      // Identify record for upsert — match on segment + market + name/entity
      const identifier = lead.full_name ?? lead.entity_name ?? null;
      if (!identifier) {
        result.errors.push(`Skipped lead with no full_name or entity_name`);
        continue;
      }

      // Check for existing non-dead lead to avoid clobbering active pipeline
      const { data: existing } = await supabase
        .from('leads')
        .select('id, outreach_status')
        .eq('segment', segment)
        .eq('market', market)
        .or(`full_name.eq.${identifier},entity_name.eq.${identifier}`)
        .neq('outreach_status', 'dead')
        .maybeSingle();

      if (existing) {
        // Update motivation signals and raw data but don't reset status
        const { error } = await supabase
          .from('leads')
          .update({
            motivation_signals: lead.motivation_signals,
            raw_data: lead.raw_data,
            source_url: lead.source_url,
            updated_at: new Date().toISOString(),
            // Only update contact fields if they weren't already set
            ...(lead.phone && { phone: lead.phone }),
            ...(lead.email && { email: lead.email }),
            ...(lead.rep_name && { rep_name: lead.rep_name }),
            ...(lead.rep_email && { rep_email: lead.rep_email }),
            ...(lead.rep_phone && { rep_phone: lead.rep_phone }),
          })
          .eq('id', existing.id);

        if (error) result.errors.push(`Update failed for ${identifier}: ${error.message}`);
        else result.records_upserted++;
      } else {
        const { error } = await supabase.from('leads').insert(lead);
        if (error) result.errors.push(`Insert failed for ${identifier}: ${error.message}`);
        else result.records_upserted++;
      }
    } catch (err) {
      result.errors.push(`Unexpected error: ${(err as Error).message}`);
    }
  }

  const response: EdgeFnResponse<LeadIngestionResult> = {
    success: result.errors.length < result.records_fetched,
    data: result,
  };

  return json(response, 200);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
