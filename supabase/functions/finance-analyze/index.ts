/**
 * finance-analyze — Reads assets, liabilities, income, and expenses for one
 * entity (or every entity) and writes a financial_snapshots row: net worth,
 * monthly cash flow, debt-to-income, and credit utilization.
 *
 * This agent only reads and writes snapshots/recommendations — it never
 * touches account balances or moves money.
 *
 * Accepts optional POST body:
 *   { entity_id?: string }   -- omit to analyze every entity plus a
 *                                consolidated household+business total
 */

import { getServiceClient, jsonResponse, verifySecret } from '../_shared/supabase-client.ts';
import { toMonthlyAmount, computeDebtToIncome, computeAggregateUtilization } from '../_shared/finance-math.ts';
import type { Account, IncomeOrExpense, AgentRecommendationInput } from '../_shared/finance-types.ts';

interface SnapshotResult {
  entity_id: string | null;
  entity_name: string;
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  monthly_income: number;
  monthly_expenses: number;
  monthly_cash_flow: number;
  debt_to_income: number | null;
  credit_utilization: number | null;
}

// deno-lint-ignore no-explicit-any
async function analyzeEntity(supabase: any, entityId: string | null, entityName: string): Promise<SnapshotResult> {
  let acctQ = supabase.schema('finance').from('accounts').select('*').eq('status', 'active');
  let incQ  = supabase.schema('finance').from('income_sources').select('*').eq('active', true);
  let expQ  = supabase.schema('finance').from('expenses').select('*').eq('active', true);

  if (entityId) {
    acctQ = acctQ.eq('entity_id', entityId);
    incQ  = incQ.eq('entity_id', entityId);
    expQ  = expQ.eq('entity_id', entityId);
  }

  const [{ data: accounts, error: accErr }, { data: income, error: incErr }, { data: expenses, error: expErr }] =
    await Promise.all([acctQ, incQ, expQ]);

  if (accErr) throw accErr;
  if (incErr) throw incErr;
  if (expErr) throw expErr;

  const accts = (accounts ?? []) as Account[];
  const totalAssets      = accts.filter((a) => !a.is_liability).reduce((s, a) => s + Number(a.current_balance), 0);
  const totalLiabilities = accts.filter((a) => a.is_liability).reduce((s, a) => s + Number(a.current_balance), 0);

  const monthlyIncome   = (income as IncomeOrExpense[] ?? []).reduce((s, i) => s + toMonthlyAmount(Number(i.amount), i.frequency), 0);
  const monthlyExpenses = (expenses as IncomeOrExpense[] ?? []).reduce((s, e) => s + toMonthlyAmount(Number(e.amount), e.frequency), 0);
  const monthlyDebtPayments = accts.filter((a) => a.is_liability).reduce((s, a) => s + Number(a.minimum_payment ?? 0), 0);

  const netWorth = totalAssets - totalLiabilities;
  const cashFlow = monthlyIncome - monthlyExpenses;
  const dti = computeDebtToIncome(monthlyDebtPayments, monthlyIncome);
  const utilization = computeAggregateUtilization(accts);

  const { error: insertErr } = await supabase.schema('finance').from('financial_snapshots').insert({
    entity_id: entityId,
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    net_worth: netWorth,
    monthly_income: monthlyIncome,
    monthly_expenses: monthlyExpenses,
    monthly_cash_flow: cashFlow,
    debt_to_income: dti,
    credit_utilization: utilization,
    details: {
      account_count: accts.length,
      income_source_count: (income ?? []).length,
      expense_count: (expenses ?? []).length,
    },
  });
  if (insertErr) throw insertErr;

  const recommendations: AgentRecommendationInput[] = [];

  if (cashFlow < 0) {
    recommendations.push({
      entity_id: entityId,
      agent_name: 'finance-analyze',
      recommendation_type: 'spending_alert',
      title: `Negative monthly cash flow — ${entityName}`,
      rationale: `Monthly expenses ($${monthlyExpenses.toFixed(2)}) exceed monthly income ` +
        `($${monthlyIncome.toFixed(2)}) by $${Math.abs(cashFlow).toFixed(2)}/mo. Review the expense ` +
        `breakdown and consider whether any recurring costs can be trimmed before committing more ` +
        `budget to a debt payoff plan.`,
      details: { monthly_income: monthlyIncome, monthly_expenses: monthlyExpenses, monthly_cash_flow: cashFlow },
      priority: 'high',
    });
  }

  if (utilization !== null && utilization > 0.3) {
    recommendations.push({
      entity_id: entityId,
      agent_name: 'finance-analyze',
      recommendation_type: 'credit_building',
      title: `Credit utilization above 30% — ${entityName}`,
      rationale: `Aggregate revolving utilization is ${(utilization * 100).toFixed(1)}%. Utilization above ` +
        `30% (and especially above 50%) actively drags down credit scores. Paying revolving balances down ` +
        `— or requesting credit-limit increases without adding new debt — should be prioritized.`,
      details: { credit_utilization: utilization },
      priority: utilization > 0.5 ? 'urgent' : 'medium',
    });
  }

  if (recommendations.length > 0) {
    const { error: recErr } = await supabase.schema('finance').from('agent_recommendations').insert(recommendations);
    if (recErr) throw recErr;
  }

  return {
    entity_id: entityId,
    entity_name: entityName,
    total_assets: Math.round(totalAssets * 100) / 100,
    total_liabilities: Math.round(totalLiabilities * 100) / 100,
    net_worth: Math.round(netWorth * 100) / 100,
    monthly_income: Math.round(monthlyIncome * 100) / 100,
    monthly_expenses: Math.round(monthlyExpenses * 100) / 100,
    monthly_cash_flow: Math.round(cashFlow * 100) / 100,
    debt_to_income: dti,
    credit_utilization: utilization,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifySecret(req, 'FINANCE_WEBHOOK_SECRET', 'x-finance-secret');
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { entity_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const supabase = getServiceClient();

  try {
    const results: SnapshotResult[] = [];

    if (body.entity_id) {
      const { data: entity, error } = await supabase
        .schema('finance').from('entities').select('id, name').eq('id', body.entity_id).single();
      if (error || !entity) return jsonResponse({ success: false, error: 'Entity not found' }, 404);
      results.push(await analyzeEntity(supabase, entity.id, entity.name));
    } else {
      const { data: entities, error } = await supabase.schema('finance').from('entities').select('id, name');
      if (error) throw error;
      for (const entity of entities ?? []) {
        results.push(await analyzeEntity(supabase, entity.id, entity.name));
      }
      results.push(await analyzeEntity(supabase, null, 'Consolidated (all entities)'));
    }

    return jsonResponse({ success: true, snapshots: results });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
