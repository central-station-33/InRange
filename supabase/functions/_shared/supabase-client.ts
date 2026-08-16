import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function getServiceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

export function verifySecret(req: Request, envVar: string, header: string): void {
  const secret = Deno.env.get(envVar);
  if (!secret) return; // no secret configured — allow (dev mode)
  const provided = req.headers.get(header);
  if (provided !== secret) throw new Error(`Unauthorized: invalid ${header}`);
}

export function verifyMakeSecret(req: Request): void {
  verifySecret(req, 'MAKE_WEBHOOK_SECRET', 'x-make-secret');
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
