/**
 * enrichment-retry — POST /enrichment/retry
 *
 * Manually re-queues a failed or dead-lettered job. Automatic retry
 * (backoff, dead-letter on exhaustion) is handled by enrichment-process
 * itself via _shared/jobs.ts failJob — this endpoint is for the explicit
 * "retry this one now" action (e.g. from the human review screen's
 * "request more research" control, or an operator clearing a dead-letter
 * job after fixing the underlying cause).
 *
 * Body: { job_id: string, reset_retry_count?: boolean }
 */

import { getServiceClient, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

interface RequestBody {
  job_id?: string;
  reset_retry_count?: boolean;
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

  if (!body.job_id) {
    return jsonResponse({ error: 'job_id is required' }, 400);
  }

  const supabase = getServiceClient();

  try {
    const { data: job, error: fetchErr } = await supabase
      .from('enrichment_jobs')
      .select('id, status, retry_count')
      .eq('id', body.job_id)
      .single();
    if (fetchErr) throw fetchErr;
    if (!job) return jsonResponse({ error: `No job with id=${body.job_id}` }, 404);

    if (job.status !== 'failed' && job.status !== 'dead_letter') {
      return jsonResponse(
        { error: `Job is ${job.status}; only 'failed' or 'dead_letter' jobs can be retried` },
        400,
      );
    }

    const { data: updated, error: updateErr } = await supabase
      .from('enrichment_jobs')
      .update({
        status: 'queued',
        next_retry_at: null,
        started_at: null,
        completed_at: null,
        retry_count: body.reset_retry_count ? 0 : job.retry_count,
      })
      .eq('id', body.job_id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    return jsonResponse({ success: true, job: updated });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
