/**
 * ingest-raw-record — POST /ingest/raw-record
 *
 * Generic landing zone for any source not already covered by ingest-nyc/
 * ingest-nj (a probate feed, an expired-listing vendor feed, etc.). Writes
 * the raw payload to raw_records untouched, then enqueues an 'ingestion'
 * job to normalize/match it later — this function does not itself
 * classify or write lead_evidence.
 *
 * Body: { source: string, raw_payload: object, property_id?: string, idempotency_key?: string }
 */

import {
  getServiceClient,
  jsonResponse,
  verifyEnrichmentSecret,
} from '../_shared/supabase-client.ts';
import { enqueueJob } from '../_shared/jobs.ts';

interface RequestBody {
  source?: string;
  raw_payload?: Record<string, unknown>;
  property_id?: string;
  idempotency_key?: string;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyEnrichmentSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.source || typeof body.source !== 'string') {
    return jsonResponse({ error: 'source (string) is required' }, 400);
  }
  if (!body.raw_payload || typeof body.raw_payload !== 'object') {
    return jsonResponse({ error: 'raw_payload (object) is required' }, 400);
  }

  const supabase = getServiceClient();

  try {
    const { data: rawRecord, error: insertErr } = await supabase
      .from('raw_records')
      .insert({
        source: body.source,
        raw_payload: body.raw_payload,
        property_id: body.property_id ?? null,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    const { job, deduped } = await enqueueJob(supabase, {
      jobType: 'ingestion',
      idempotencyKey: body.idempotency_key,
      rawRecordId: rawRecord.id,
      payload: { source: body.source },
    });

    return jsonResponse({
      success: true,
      raw_record_id: rawRecord.id,
      job_id: job.id,
      job_deduped: deduped,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
