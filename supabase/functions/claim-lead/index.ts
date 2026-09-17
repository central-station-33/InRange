/**
 * claim-lead — Agent-facing endpoint backing the "unclaimed leads" queue.
 *
 * An agent (via Retool button, or any UI wired to this endpoint) POSTs their
 * name and a property_id to claim it. Uses the claim_property() SQL function
 * (see migration 20240101000002) so two agents claiming the same lead at the
 * same time can't both win — only the first UPDATE matches
 * claim_status = 'unclaimed' and returns a row.
 *
 * Body: { "property_id": "<uuid>", "agent_name": "Jane ISA" }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { property_id?: string; agent_name?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.property_id || !body.agent_name) {
    return jsonResponse({ error: 'property_id and agent_name are required' }, 400);
  }

  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('claim_property', {
    p_id:    body.property_id,
    p_agent: body.agent_name,
  });

  if (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }

  if (!data || data.length === 0) {
    // No row matched claim_status = 'unclaimed' — either it's already
    // claimed, or the ID doesn't exist.
    return jsonResponse({ success: false, error: 'Lead already claimed or not found' }, 409);
  }

  return jsonResponse({ success: true, property: data[0] });
});
