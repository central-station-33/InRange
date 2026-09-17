import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function getServiceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

export function verifyMakeSecret(req: Request): void {
  const secret = Deno.env.get('MAKE_WEBHOOK_SECRET');
  if (!secret) return; // no secret configured — allow (dev mode)
  const provided = req.headers.get('x-make-secret');
  if (provided !== secret) throw new Error('Unauthorized: invalid Make.com secret');
}

// Distinct from MAKE_WEBHOOK_SECRET by design (see
// docs/ai-lead-enrichment-blueprint.md §9): guards the enrichment/leads/
// outreach endpoints specifically, so it can be rotated independently of
// the existing ingest/score/notify pipeline's secret.
export function verifyEnrichmentSecret(req: Request): void {
  const secret = Deno.env.get('ENRICHMENT_WEBHOOK_SECRET');
  if (!secret) return; // no secret configured — allow (dev mode)
  const provided = req.headers.get('x-enrichment-secret');
  if (provided !== secret) throw new Error('Unauthorized: invalid enrichment secret');
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts a :id-style path param from a request whose function was
 * invoked as either /functions/v1/<fn-name>/<id> or
 * /functions/v1/<fn-name>?<queryParam>=<id> — Supabase Edge Functions
 * don't do sub-path routing out of the box, so callers may reasonably use
 * either form; this accepts both rather than picking one and silently
 * rejecting the other.
 */
export function extractIdParam(req: Request, queryParam: string): string | null {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get(queryParam);
  if (fromQuery) return fromQuery;

  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last && UUID_RE.test(last) ? last : null;
}

/**
 * Invokes another Edge Function in this same project using the
 * service-role key, so job dispatch logic (enrichment-process) can call
 * the dedicated gemini-normalize/gemini-brief/claude-review/outreach-draft
 * functions instead of duplicating their logic inline.
 */
export async function callFunction(
  name: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify(body),
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response body is unusual but not fatal here */
  }

  return { ok: res.ok, status: res.status, json };
}
