/**
 * finance-debt-payoff — Given a monthly budget for debt payments, simulates
 * an avalanche (highest APR first) and/or snowball (smallest balance first)
 * payoff schedule across an entity's liability accounts, writes a proposed
 * debt_payoff_plans row + ordered steps, and files an agent_recommendation
 * for human approval. It never changes an account balance or schedules a
 * real payment — approval only marks the plan as authorized to act on.
 *
 * POST body:
 *   {
 *     entity_id?: string;               // omit = across every entity's debts
 *     strategy?: 'avalanche' | 'snowball' | 'both';  // default 'both'
 *     monthly_budget: number;           // required — total available for debt payments
 *   }
 */

import { getServiceClient, jsonResponse, verifySecret } from '../_shared/supabase-client.ts';
import { simulatePayoffPlan, type DebtInput, type PayoffOrder } from '../_shared/finance-math.ts';
import { generateNarrative, hasAnthropicKey } from '../_shared/anthropic-client.ts';
import type { Account, AgentRecommendationInput } from '../_shared/finance-types.ts';

const STRATEGY_ORDER: Record<'avalanche' | 'snowball', PayoffOrder> = {
  avalanche: 'rate_desc',
  snowball: 'balance_asc',
};

function templateRationale(
  strategy: string, months: number, totalInterest: number, totalDebt: number, comparedTo?: { strategy: string; months: number; totalInterest: number },
): string {
  let text = `${strategy[0].toUpperCase()}${strategy.slice(1)} plan: pay off $${totalDebt.toFixed(2)} in ` +
    `debt over ${months} month(s), paying an estimated $${totalInterest.toFixed(2)} in interest.`;
  if (comparedTo) {
    const diff = comparedTo.totalInterest - totalInterest;
    text += ` Compared to ${comparedTo.strategy} (${comparedTo.months} months, ` +
      `$${comparedTo.totalInterest.toFixed(2)} interest), this saves $${diff.toFixed(2)} in interest` +
      (diff < 0 ? ' — but the other strategy wins on interest cost, though it may take longer to see progress.' : '.');
  }
  return text;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifySecret(req, 'FINANCE_WEBHOOK_SECRET', 'x-finance-secret');
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { entity_id?: string; strategy?: 'avalanche' | 'snowball' | 'both'; monthly_budget?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  if (!body.monthly_budget || body.monthly_budget <= 0) {
    return jsonResponse({ error: 'monthly_budget is required and must be > 0' }, 400);
  }

  const strategies: Array<'avalanche' | 'snowball'> =
    body.strategy === 'avalanche' ? ['avalanche'] :
    body.strategy === 'snowball' ? ['snowball'] :
    ['avalanche', 'snowball'];

  const supabase = getServiceClient();

  try {
    let entityName = 'Consolidated (all entities)';
    if (body.entity_id) {
      const { data: entity, error } = await supabase
        .schema('finance').from('entities').select('id, name').eq('id', body.entity_id).single();
      if (error || !entity) return jsonResponse({ success: false, error: 'Entity not found' }, 404);
      entityName = entity.name;
    }

    let acctQ = supabase.schema('finance').from('accounts').select('*')
      .eq('is_liability', true).eq('status', 'active').gt('current_balance', 0);
    if (body.entity_id) acctQ = acctQ.eq('entity_id', body.entity_id);

    const { data: accounts, error: acctErr } = await acctQ;
    if (acctErr) throw acctErr;

    const usable: Array<Account & { interest_rate: number; minimum_payment: number }> = [];
    const skipped: string[] = [];
    for (const a of (accounts ?? []) as Account[]) {
      if (a.interest_rate == null || a.minimum_payment == null) {
        skipped.push(`${a.name} — missing interest_rate or minimum_payment`);
        continue;
      }
      usable.push(a as Account & { interest_rate: number; minimum_payment: number });
    }

    if (usable.length === 0) {
      return jsonResponse({
        success: false,
        error: 'No liability accounts with balance, interest_rate, and minimum_payment set',
        skipped,
      }, 400);
    }

    const debts: DebtInput[] = usable.map((a) => ({
      accountId: a.id, name: a.name, balance: Number(a.current_balance),
      apr: Number(a.interest_rate), minimumPayment: Number(a.minimum_payment),
    }));

    const results: Record<string, ReturnType<typeof simulatePayoffPlan>> = {};
    for (const s of strategies) {
      results[s] = simulatePayoffPlan(debts, body.monthly_budget, STRATEGY_ORDER[s]);
    }

    const planIds: Record<string, string> = {};
    for (const s of strategies) {
      const r = results[s];
      const { data: plan, error: planErr } = await supabase.schema('finance').from('debt_payoff_plans').insert({
        entity_id: body.entity_id ?? null,
        strategy: s,
        monthly_payment_budget: body.monthly_budget,
        total_debt: r.totalDebt,
        months_to_payoff: r.monthsToPayoff,
        projected_payoff_date: r.projectedPayoffDate,
        total_interest_paid: r.totalInterestPaid,
      }).select('id').single();
      if (planErr) throw planErr;
      planIds[s] = plan.id;

      const stepRows = r.steps.map((step) => ({
        plan_id: plan.id,
        account_id: step.accountId,
        step_order: step.stepOrder,
        starting_balance: step.startingBalance,
        monthly_target_payment: step.monthlyTargetPayment,
        projected_payoff_month: step.projectedPayoffMonth,
        interest_paid_estimate: step.interestPaidEstimate,
      }));
      const { error: stepErr } = await supabase.schema('finance').from('debt_payoff_steps').insert(stepRows);
      if (stepErr) throw stepErr;
    }

    // Recommend the lower-interest strategy when both were run.
    const recommended: 'avalanche' | 'snowball' =
      strategies.length === 2
        ? (results.avalanche.totalInterestPaid <= results.snowball.totalInterestPaid ? 'avalanche' : 'snowball')
        : strategies[0];

    let rationale: string;
    const other = strategies.length === 2 ? (recommended === 'avalanche' ? 'snowball' : 'avalanche') : undefined;
    const templated = templateRationale(
      recommended, results[recommended].monthsToPayoff, results[recommended].totalInterestPaid,
      results[recommended].totalDebt,
      other ? { strategy: other, months: results[other].monthsToPayoff, totalInterest: results[other].totalInterestPaid } : undefined,
    );

    if (hasAnthropicKey()) {
      try {
        rationale = await generateNarrative(
          'You are a concise personal/business financial planner. Respond in plain prose, 3-5 sentences, ' +
          'no bullet points. Explain the recommended debt payoff strategy and, if a comparison strategy is ' +
          'given, why the recommended one is preferred (or note the tradeoff if the alternative pays off ' +
          'faster despite costing more interest).',
          `Entity: ${entityName}\nMonthly debt-payment budget: $${body.monthly_budget}\n\n` +
          `Computed plans:\n${JSON.stringify(results, null, 2)}\n\nRecommended strategy: ${recommended}`,
        );
      } catch {
        rationale = templated; // fall back silently — narrative is a nice-to-have, not required
      }
    } else {
      rationale = templated;
    }

    const recInput: AgentRecommendationInput = {
      entity_id: body.entity_id ?? null,
      agent_name: 'finance-debt-payoff',
      recommendation_type: 'debt_payoff',
      title: `${recommended[0].toUpperCase()}${recommended.slice(1)} debt payoff plan — ${entityName}`,
      rationale,
      details: { strategies_computed: results, recommended_strategy: recommended, skipped_accounts: skipped },
      priority: 'medium',
      related_plan_id: planIds[recommended],
    };

    const { data: rec, error: recErr } = await supabase.schema('finance').from('agent_recommendations')
      .insert(recInput).select('id').single();
    if (recErr) throw recErr;

    await supabase.schema('finance').from('recommendation_events').insert({
      recommendation_id: rec.id, event_type: 'created', actor: 'finance-debt-payoff',
      detail: `Generated ${strategies.join(' & ')} plan(s); recommended ${recommended}.`,
    });

    return jsonResponse({
      success: true,
      entity_id: body.entity_id ?? null,
      recommended_strategy: recommended,
      recommendation_id: rec.id,
      plans: results,
      plan_ids: planIds,
      skipped_accounts: skipped,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
