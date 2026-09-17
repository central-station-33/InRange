/**
 * enrichment-process — POST /enrichment/process
 *
 * Drains up to `limit` due jobs of the given job_type from the queue,
 * dispatching each to its handler. Delegates to the dedicated
 * enrichment-gemini-normalize / enrichment-gemini-brief /
 * enrichment-claude-review / outreach-draft functions via an internal
 * service-role call (see _shared/supabase-client.ts callFunction) instead
 * of duplicating their logic here, so each remains independently callable
 * and independently testable.
 *
 * Body: { job_type: EnrichmentJobType, limit?: number }
 */

import {
  callFunction,
  getServiceClient,
  jsonResponse,
  verifyEnrichmentSecret,
} from '../_shared/supabase-client.ts';
import { claimJob, completeJob, failJob, type EnrichmentJob, type EnrichmentJobType } from '../_shared/jobs.ts';

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

async function processIngestionJob(
  supabase: ReturnType<typeof getServiceClient>,
  job: EnrichmentJob,
): Promise<Record<string, unknown>> {
  if (!job.raw_record_id) throw new Error('ingestion job missing raw_record_id');

  // Marks the raw record processed. Matching it to a property/creating a
  // lead_records row is deliberately NOT done here — that's a
  // classification decision, which per docs/ai-lead-enrichment-blueprint.md
  // belongs to lead-classify (Phase 1's Gemini pass), not to raw ingestion.
  // This function's job is only to confirm the raw record was received and
  // hand off; normalization is a separate job a caller enqueues next.
  const { error } = await supabase
    .from('raw_records')
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq('id', job.raw_record_id);
  if (error) throw error;

  return { raw_record_id: job.raw_record_id, processed: true };
}

async function sendReviewNotification(
  job: EnrichmentJob,
): Promise<Record<string, unknown>> {
  const webhook = Deno.env.get('MAKE_NOTIFY_WEBHOOK');
  if (!webhook) {
    // Matches notify-subscribers' existing convention: no webhook
    // configured is a soft no-op, not a hard failure, in dev.
    return { sent: false, reason: 'MAKE_NOTIFY_WEBHOOK not configured' };
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'human_review_notification', lead_id: job.lead_id, payload: job.payload }),
  });
  if (!res.ok) throw new Error(`MAKE_NOTIFY_WEBHOOK returned ${res.status}`);
  return { sent: true };
}

async function dispatch(
  supabase: ReturnType<typeof getServiceClient>,
  job: EnrichmentJob,
): Promise<Record<string, unknown>> {
  switch (job.job_type) {
    case 'ingestion':
      return await processIngestionJob(supabase, job);

    case 'normalization': {
      if (!job.lead_id) throw new Error('normalization job missing lead_id');
      const r = await callFunction('enrichment-gemini-normalize', { lead_id: job.lead_id });
      if (!r.ok) throw new Error(`enrichment-gemini-normalize returned ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json as Record<string, unknown>;
    }

    case 'enrichment':
    case 'lead_brief': {
      if (!job.lead_id) throw new Error(`${job.job_type} job missing lead_id`);
      const r = await callFunction('enrichment-gemini-brief', { lead_id: job.lead_id });
      if (!r.ok) throw new Error(`enrichment-gemini-brief returned ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json as Record<string, unknown>;
    }

    case 'claude_escalation': {
      if (!job.lead_id) throw new Error('claude_escalation job missing lead_id');
      const r = await callFunction('enrichment-claude-review', { lead_id: job.lead_id });
      if (!r.ok) throw new Error(`enrichment-claude-review returned ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json as Record<string, unknown>;
    }

    case 'outreach_draft': {
      if (!job.lead_id) throw new Error('outreach_draft job missing lead_id');
      const r = await callFunction('outreach-draft', { lead_id: job.lead_id });
      if (!r.ok) throw new Error(`outreach-draft returned ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json as Record<string, unknown>;
    }

    case 'human_review_notifications':
      return await sendReviewNotification(job);

    case 'document_extraction':
      // Honest gap, not a silent no-op: no document/OCR pipeline or
      // Supabase Storage integration exists anywhere in this repo yet.
      // Fails immediately so the job goes to dead_letter rather than
      // looping through retries against work that can never succeed.
      throw new Error(
        'document_extraction is not implemented: no document/Storage extraction pipeline exists in this repo yet',
      );

    default:
      throw new Error(`Unknown job_type: ${job.job_type}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyEnrichmentSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { job_type?: string; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body not allowed for this endpoint — job_type is required */
  }

  if (!body.job_type || !VALID_JOB_TYPES.includes(body.job_type as EnrichmentJobType)) {
    return jsonResponse({ error: `job_type must be one of: ${VALID_JOB_TYPES.join(', ')}` }, 400);
  }

  const jobType = body.job_type as EnrichmentJobType;
  const limit = body.limit ?? 5;
  const supabase = getServiceClient();

  let processed = 0;
  const errors: string[] = [];

  for (let i = 0; i < limit; i++) {
    let job: EnrichmentJob | null;
    try {
      job = await claimJob(supabase, jobType);
    } catch (e) {
      errors.push(`claim failed: ${(e as Error).message}`);
      break;
    }
    if (!job) break; // queue empty (or nothing due for retry)

    try {
      const result = await dispatch(supabase, job);
      await completeJob(supabase, job.id, result);
      processed++;
    } catch (e) {
      await failJob(supabase, job.id, { message: (e as Error).message });
      errors.push(`job ${job.id}: ${(e as Error).message}`);
    }
  }

  return jsonResponse({ success: true, job_type: jobType, processed, errors });
});
