/**
 * finance-import-transactions — Manual/CSV-derived transaction ingestion.
 * This is the concrete implementation of the "manual" data_source; Plaid
 * sync (data_source = 'plaid') is stubbed in the schema but not implemented.
 *
 * The caller (a human, a spreadsheet import script, or a Make.com scenario
 * reading a CSV) is responsible for parsing the source file into rows —
 * this function only validates and upserts.
 *
 * POST body:
 *   {
 *     account_id: string;
 *     update_balance?: number;   -- if provided, sets accounts.current_balance
 *     transactions: Array<{
 *       posted_date: string;     -- YYYY-MM-DD
 *       description: string;
 *       amount: number;          -- negative = outflow, positive = inflow
 *       category?: string;
 *       external_id?: string;    -- pass a stable id (e.g. CSV row hash) to dedupe on re-import
 *     }>;
 *   }
 */

import { getServiceClient, jsonResponse, verifySecret } from '../_shared/supabase-client.ts';

interface TxnInput {
  posted_date: string;
  description: string;
  amount: number;
  category?: string;
  external_id?: string;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifySecret(req, 'FINANCE_WEBHOOK_SECRET', 'x-finance-secret');
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { account_id?: string; update_balance?: number; transactions?: TxnInput[] } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  if (!body.account_id) return jsonResponse({ error: 'account_id is required' }, 400);
  if (!body.transactions || !Array.isArray(body.transactions) || body.transactions.length === 0) {
    return jsonResponse({ error: 'transactions must be a non-empty array' }, 400);
  }

  for (const [i, t] of body.transactions.entries()) {
    if (!t.posted_date || !t.description || typeof t.amount !== 'number') {
      return jsonResponse({ error: `transactions[${i}] requires posted_date, description, and numeric amount` }, 400);
    }
  }

  const supabase = getServiceClient();

  try {
    const { data: account, error: acctErr } = await supabase
      .schema('finance').from('accounts').select('id, entity_id').eq('id', body.account_id).single();
    if (acctErr || !account) return jsonResponse({ success: false, error: 'Account not found' }, 404);

    const rows = body.transactions.map((t) => ({
      account_id: body.account_id,
      entity_id: account.entity_id,
      posted_date: t.posted_date,
      description: t.description,
      amount: t.amount,
      category: t.category ?? null,
      data_source: 'manual',
      external_id: t.external_id ?? null,
    }));

    const withExternalId = rows.filter((r) => r.external_id !== null);
    const withoutExternalId = rows.filter((r) => r.external_id === null);

    let inserted = 0;
    if (withExternalId.length > 0) {
      const { error, count } = await supabase
        .schema('finance').from('transactions')
        .upsert(withExternalId, { onConflict: 'account_id,external_id', count: 'exact' });
      if (error) throw error;
      inserted += count ?? withExternalId.length;
    }
    if (withoutExternalId.length > 0) {
      const { error, count } = await supabase
        .schema('finance').from('transactions').insert(withoutExternalId, { count: 'exact' });
      if (error) throw error;
      inserted += count ?? withoutExternalId.length;
    }

    if (typeof body.update_balance === 'number') {
      const { error: balErr } = await supabase
        .schema('finance').from('accounts')
        .update({ current_balance: body.update_balance, last_synced_at: new Date().toISOString() })
        .eq('id', body.account_id);
      if (balErr) throw balErr;
    }

    return jsonResponse({ success: true, account_id: body.account_id, transactions_processed: inserted });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
