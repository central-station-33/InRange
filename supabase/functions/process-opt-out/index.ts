/**
 * process-opt-out — Handles a contact's own explicit opt-out/unsubscribe
 * signal (e.g. an inbound "STOP" SMS or an unsubscribe link click, relayed
 * by Make.com/Twilio).
 *
 * This is NOT the AI deciding to opt someone out — it is deterministic,
 * rule-based processing of the person's own stated request, which the
 * outreach control policy requires ("Opt-out processing where
 * applicable"). It never opts someone IN, and it never runs on anything
 * other than an explicit stop/unsubscribe signal.
 *
 * POST body:
 *   { subscriber_id?: string; email?: string; phone?: string; source: string }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import { logActivity } from '../_shared/outreachControls.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { subscriber_id?: string; email?: string; phone?: string; source?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }

  const { subscriber_id, email, phone, source } = body;
  if (!subscriber_id && !email && !phone) {
    return jsonResponse({ error: 'subscriber_id, email, or phone required' }, 400);
  }
  if (!source) {
    return jsonResponse({ error: 'source is required (e.g. "sms_stop", "unsubscribe_link")' }, 400);
  }

  const supabase = getServiceClient();

  try {
    let query = supabase.from('subscribers').select('id');
    if (subscriber_id) query = query.eq('id', subscriber_id);
    else if (email) query = query.eq('email', email);
    else query = query.eq('phone', phone);

    const { data: matches, error: findErr } = await query;
    if (findErr) throw findErr;
    if (!matches || matches.length === 0) {
      return jsonResponse({ success: true, updated: 0, message: 'No matching subscriber' });
    }

    const ids = matches.map((m) => m.id);
    const { error: updateErr } = await supabase
      .from('subscribers')
      .update({
        consent_status: 'opted_out',
        dnc: true,
        contactable: false,
        consent_source: source,
        consent_updated_by: 'opt_out_signal',
        consent_updated_at: new Date().toISOString(),
      })
      .in('id', ids);
    if (updateErr) throw updateErr;

    for (const id of ids) {
      await logActivity(supabase, {
        entity_type: 'subscriber',
        entity_id: id,
        action: 'opt_out_processed',
        actor: 'opt_out_signal',
        detail: { source },
      });
    }

    return jsonResponse({ success: true, updated: ids.length });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
