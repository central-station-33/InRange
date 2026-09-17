/**
 * Helpers for writing to `raw_records`, the immutable ingestion layer the
 * canonical data model reads from. See docs/canonical-data-model.md.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Deterministic stringify (sorted object keys) so the same logical payload
// always hashes the same way regardless of key insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export async function computeChecksum(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface InsertRawRecordParams {
  organization_id: string;
  source_name: string;
  source_record_id?: string | null;
  source_type: string;
  ingestion_batch_id?: string | null;
  raw_payload_json: unknown;
  source_url?: string | null;
  created_by?: string;
}

export interface InsertRawRecordResult {
  id: string | null;   // null when this exact payload was already ingested (dedupe hit)
  inserted: boolean;
}

/**
 * Inserts a raw_records row. A unique-constraint violation on the
 * (source_name, source_record_id, checksum) dedupe index means this exact
 * payload was already ingested — that's an expected no-op, not an error.
 */
export async function insertRawRecord(
  supabase: SupabaseClient,
  params: InsertRawRecordParams,
): Promise<InsertRawRecordResult> {
  const checksum = await computeChecksum(params.raw_payload_json);

  const { data, error } = await supabase
    .from('raw_records')
    .insert({
      organization_id: params.organization_id,
      source_name: params.source_name,
      source_record_id: params.source_record_id ?? null,
      source_type: params.source_type,
      ingestion_batch_id: params.ingestion_batch_id ?? null,
      raw_payload_json: params.raw_payload_json,
      source_url: params.source_url ?? null,
      checksum,
      created_by: params.created_by ?? 'system',
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') return { id: null, inserted: false };
    throw error;
  }
  return { id: data.id, inserted: true };
}
