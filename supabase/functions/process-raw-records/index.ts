/**
 * process-raw-records — Turns immutable `raw_records` into the canonical
 * data model: a `properties` row, a `parties` row for the owner (if any),
 * a `property_party_relationships` row linking them, and a `leads` row
 * carrying a deterministic score. Every run is logged to
 * `enrichment_runs` (provider='internal_rules', task_type='normalize_record'
 * or 'classify_party').
 *
 * This is deterministic, rules-based processing only — the first step of
 * the model routing policy ("deterministic source validation first"). No
 * AI model is called here. AI enrichment of the resulting leads
 * (ai_signal_score, final_priority_score) is a separate, not-yet-wired
 * step — see docs/canonical-data-model.md.
 *
 * Only understands raw_records shaped like the `Property` type that
 * ingest-nyc/ingest-nj write (source, parcel_id, address, city, state,
 * zip, county, owner_name, property_type, assessed_value, market_value,
 * distress_flags). Rows from other sources are left pending.
 *
 * Accepts optional POST body:
 *   { limit?: number; source_name?: 'nyc' | 'nj' }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import { scoreProperty } from '../_shared/scoring.ts';
import type { DistressFlag, Property } from '../_shared/types.ts';

type PriorityTier = 'A' | 'B' | 'C' | 'D';

const TIER_TO_PRIORITY: Record<number, PriorityTier> = { 1: 'A', 2: 'B', 3: 'C', 4: 'D' };

interface RawRecordRow {
  id: string;
  organization_id: string;
  source_name: string;
  raw_payload_json: Property;
}

function normalizedAddress(p: Property): string {
  return [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ').toUpperCase().trim();
}

function normalizedName(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

// Deterministic entity classification — no AI involved. Intentionally
// coarse; ambiguous names fall through to 'individual' rather than
// 'unknown' since most owner_name values in this pipeline are people.
function classifyPartyType(name: string): string {
  const n = name.toUpperCase();
  if (/\bL\.?L\.?C\.?\b/.test(n)) return 'llc';
  if (/\b(INC|CORP|CORPORATION|COMPANY|CO)\b\.?/.test(n)) return 'corporation';
  if (/\bTRUST\b/.test(n)) return 'trust';
  if (/\bESTATE\b/.test(n)) return 'estate';
  if (/\bBANK\b|\bMORTGAGE\b|\bLENDING\b/.test(n)) return 'bank';
  if (/\b(CITY|COUNTY|STATE|MUNICIPAL|HOUSING AUTHORITY|DEPT|DEPARTMENT)\b/.test(n)) return 'government';
  return 'individual';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { limit?: number; source_name?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const limit = body.limit ?? 50;
  const supabase = getServiceClient();

  try {
    let query = supabase
      .from('raw_records')
      .select('id, organization_id, source_name, raw_payload_json')
      .eq('processing_status', 'pending')
      .order('received_at', { ascending: true })
      .limit(limit);
    if (body.source_name) query = query.eq('source_name', body.source_name);

    const { data: rows, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;
    if (!rows || rows.length === 0) {
      return jsonResponse({ success: true, processed: 0, failed: 0, message: 'No pending raw records' });
    }

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const row of rows as RawRecordRow[]) {
      const startedAt = new Date().toISOString();
      try {
        const p = row.raw_payload_json;
        const flags: DistressFlag[] = Array.isArray(p.distress_flags) ? p.distress_flags : [];

        // 1) Canonical property
        const { data: property, error: propErr } = await supabase
          .from('properties')
          .upsert(
            {
              organization_id: row.organization_id,
              normalized_address: normalizedAddress(p),
              address_line_1: p.address,
              city: p.city,
              state: p.state,
              postal_code: p.zip,
              county: p.county,
              parcel_id: p.parcel_id,
              property_type: p.property_type,
              canonical_source: row.source_name,
              source_confidence: 1,
            },
            { onConflict: 'organization_id,canonical_source,parcel_id' },
          )
          .select('id')
          .single();
        if (propErr) throw propErr;

        // 2) Owner party + relationship (only if we have an owner name)
        let partyId: string | null = null;
        if (p.owner_name && p.owner_name.trim().length > 0) {
          const normalized = normalizedName(p.owner_name);
          const { data: party, error: partyErr } = await supabase
            .from('parties')
            .upsert(
              {
                organization_id: row.organization_id,
                party_type: classifyPartyType(p.owner_name),
                legal_name: p.owner_name,
                normalized_name: normalized,
                canonical_source: row.source_name,
                source_confidence: 1,
              },
              { onConflict: 'organization_id,normalized_name' },
            )
            .select('id')
            .single();
          if (partyErr) throw partyErr;
          partyId = party.id;

          const { error: relErr } = await supabase
            .from('property_party_relationships')
            .upsert(
              {
                organization_id: row.organization_id,
                property_id: property.id,
                party_id: partyId,
                relationship_type: 'owner',
                source_record_id: row.id,
                source_reference: row.source_name,
                verification_status: 'source_backed',
                confidence: 1,
              },
              { onConflict: 'property_id,party_id,relationship_type' },
            );
          if (relErr) throw relErr;
        }

        // 3) Deterministic score -> lead. Only deterministic/rules fields
        // are written here — lead_status, assigned_agent_id, next_action,
        // campaign_eligible, and AI fields are left untouched so this
        // never clobbers human or AI work done after the lead was created.
        const { composite_score, tier } = scoreProperty(flags);
        const { data: lead, error: leadErr } = await supabase
          .from('leads')
          .upsert(
            {
              organization_id: row.organization_id,
              property_id: property.id,
              primary_party_id: partyId,
              deterministic_score: composite_score,
              priority_tier: TIER_TO_PRIORITY[tier],
            },
            { onConflict: 'property_id' },
          )
          .select('id')
          .single();
        if (leadErr) throw leadErr;

        await supabase.from('enrichment_runs').insert({
          organization_id: row.organization_id,
          lead_id: lead.id,
          raw_record_id: row.id,
          provider: 'internal_rules',
          task_type: 'normalize_record',
          status: 'succeeded',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          output_json: {
            property_id: property.id,
            party_id: partyId,
            composite_score,
            tier,
            priority_tier: TIER_TO_PRIORITY[tier],
          },
        });

        await supabase
          .from('raw_records')
          .update({ processing_status: 'processed' })
          .eq('id', row.id);

        processed++;
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`${row.id}: ${msg}`);
        failed++;

        await supabase
          .from('raw_records')
          .update({ processing_status: 'failed', processing_error: msg })
          .eq('id', row.id);

        await supabase.from('enrichment_runs').insert({
          organization_id: row.organization_id,
          raw_record_id: row.id,
          provider: 'internal_rules',
          task_type: 'normalize_record',
          status: 'failed',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          error_message: msg,
        });
      }
    }

    return jsonResponse({ success: true, processed, failed, errors });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
