/**
 * enrichment-queue — POST /enrichment/queue
 *
 * Generic job enqueue endpoint, shared by all 8 job types. Most callers
 * will be other Edge Functions or Make.com scenarios that already know
 * which job_type and lead_id/raw_record_id they need; this function only
 * validates and inserts — dispatch/execution is enrichment-process.
 *
 * Body: {
 *   job_type: EnrichmentJobType,
 *   lead_id?: string,
 *   raw_record_id?: string,
 *   payload?: object,
 *   idempotency_key?: string,
 *   max_retries?: number,
 *   retry_backoff_seconds?: number,
 * }
 */

import { getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';
import { enqueueJob, type EnrichmentJobType } from '../_shared/jobs.ts';

const VALID_JOB_TYPES: EnrichmentJobType[] = [
  'ingestion',
  'normalization',
  'document_extraction',
  'enrichment',
  'lead_brief',
  'claude_escalation',
  'human_review_notifications',
  'outreach_draft',
];

interface RequestBody {
  job_type?: string;
  lead_id?: string;
  raw_record_id?: string;
  payload?: Record<string, unknown>;
  idempotency_key?: string;
  max_retries?: number;
  retry_backoff_seconds?: number;
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

  if (!body.job_type || !VALID_JOB_TYPES.includes(body.job_type as EnrichmentJobType)) {
    return jsonResponse(
      { error: `job_type must be one of: ${VALID_JOB_TYPES.join(', ')}` },
      400,
    );
  }

  const supabase = getServiceClient();

  try {
    const { job, deduped } = await enqueueJob(supabase, {
      jobType: body.job_type as EnrichmentJobType,
      idempotencyKey: body.idempotency_key,
      leadId: body.lead_id,
      rawRecordId: body.raw_record_id,
      payload: body.payload,
      maxRetries: body.max_retries,
      retryBackoffSeconds: body.retry_backoff_seconds,
    });

    return jsonResponse({ success: true, job, deduped });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
