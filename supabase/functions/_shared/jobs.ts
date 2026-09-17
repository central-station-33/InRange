/**
 * enrichment_jobs queue helpers, shared by every enrichment Edge Function
 * so idempotency/retry/backoff/dead-letter logic is implemented once,
 * tested once, and behaves identically across all 8 job types rather than
 * being reimplemented per function.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type EnrichmentJobType =
  | 'ingestion'
  | 'normalization'
  | 'document_extraction'
  | 'enrichment'
  | 'lead_brief'
  | 'claude_escalation'
  | 'human_review_notifications'
  | 'outreach_draft';

export type EnrichmentJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter';

export interface EnrichmentJob {
  id: string;
  job_type: EnrichmentJobType;
  idempotency_key: string | null;
  lead_id: string | null;
  raw_record_id: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: EnrichmentJobStatus;
  retry_count: number;
  max_retries: number;
  retry_backoff_seconds: number;
  next_retry_at: string | null;
  error_details: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface EnqueueJobParams {
  jobType: EnrichmentJobType;
  idempotencyKey?: string;
  leadId?: string;
  rawRecordId?: string;
  payload?: Record<string, unknown>;
  maxRetries?: number;
  retryBackoffSeconds?: number;
}

/**
 * Enqueues a job. If idempotencyKey collides with an existing job of the
 * same job_type (a Postgres unique-constraint violation, code 23505), the
 * existing row is fetched and returned instead of throwing — callers that
 * re-POST the same enrichment request (a retried Make.com scenario, a
 * duplicate webhook delivery) get the original job back, not a duplicate.
 */
export async function enqueueJob(
  supabase: SupabaseClient,
  params: EnqueueJobParams,
): Promise<{ job: EnrichmentJob; deduped: boolean }> {
  const { data, error } = await supabase
    .from('enrichment_jobs')
    .insert({
      job_type: params.jobType,
      idempotency_key: params.idempotencyKey ?? null,
      lead_id: params.leadId ?? null,
      raw_record_id: params.rawRecordId ?? null,
      payload: params.payload ?? {},
      max_retries: params.maxRetries ?? 3,
      retry_backoff_seconds: params.retryBackoffSeconds ?? 30,
    })
    .select()
    .single();

  if (error) {
    const isUniqueViolation = (error as { code?: string }).code === '23505';
    if (isUniqueViolation && params.idempotencyKey) {
      const { data: existing, error: fetchErr } = await supabase
        .from('enrichment_jobs')
        .select()
        .eq('job_type', params.jobType)
        .eq('idempotency_key', params.idempotencyKey)
        .single();
      if (fetchErr) throw fetchErr;
      return { job: existing as EnrichmentJob, deduped: true };
    }
    throw error;
  }

  return { job: data as EnrichmentJob, deduped: false };
}

/**
 * Atomically claims the next due job of the given type via the
 * claim_enrichment_job Postgres function (FOR UPDATE SKIP LOCKED — see
 * the migration for why this can't be a plain select-then-update from
 * here). Returns null when nothing is claimable.
 */
export async function claimJob(
  supabase: SupabaseClient,
  jobType: EnrichmentJobType,
): Promise<EnrichmentJob | null> {
  const { data, error } = await supabase.rpc('claim_enrichment_job', { p_job_type: jobType });
  if (error) throw error;
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  return (Array.isArray(data) ? data[0] : data) as EnrichmentJob;
}

export async function completeJob(
  supabase: SupabaseClient,
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('enrichment_jobs')
    .update({ status: 'succeeded', result, completed_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) throw error;
}

/**
 * Marks a job failed and schedules a retry with exponential backoff
 * (retry_backoff_seconds * 2^(new retry_count - 1)), or moves it to
 * dead_letter once retry_count exceeds max_retries.
 */
export async function failJob(
  supabase: SupabaseClient,
  jobId: string,
  errorDetails: Record<string, unknown>,
): Promise<void> {
  const { data: job, error: fetchErr } = await supabase
    .from('enrichment_jobs')
    .select('retry_count, max_retries, retry_backoff_seconds')
    .eq('id', jobId)
    .single();
  if (fetchErr) throw fetchErr;

  const retryCount = (job.retry_count as number) + 1;
  const maxRetries = job.max_retries as number;
  const baseBackoff = job.retry_backoff_seconds as number;
  const exhausted = retryCount > maxRetries;
  const backoffSeconds = baseBackoff * Math.pow(2, Math.max(0, retryCount - 1));

  const { error: updateErr } = await supabase
    .from('enrichment_jobs')
    .update({
      status: exhausted ? 'dead_letter' : 'failed',
      retry_count: retryCount,
      error_details: errorDetails,
      next_retry_at: exhausted ? null : new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      completed_at: exhausted ? new Date().toISOString() : null,
    })
    .eq('id', jobId);
  if (updateErr) throw updateErr;
}
