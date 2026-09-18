import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const start = Date.now();
  let dbStatus = 'ok';
  let propCount = 0;
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { count, error } = await sb.from('properties').select('*', { count: 'exact', head: true });
    if (error) dbStatus = 'error';
    else propCount = count ?? 0;
  } catch { dbStatus = 'error'; }
  return new Response(JSON.stringify({
    status: 'healthy', database: dbStatus, property_count: propCount,
    claude_api: Deno.env.get('ANTHROPIC_API_KEY') ? 'configured' : 'missing',
    latency_ms: Date.now() - start,
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
