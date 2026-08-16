import type { Frequency } from './finance-types.ts';

/** Converts a recurring amount at a given frequency to a monthly-equivalent figure. */
export function toMonthlyAmount(amount: number, frequency: Frequency): number {
  switch (frequency) {
    case 'weekly':   return amount * 52 / 12;
    case 'biweekly': return amount * 26 / 12;
    case 'monthly':  return amount;
    case 'quarterly': return amount / 3;
    case 'annual':   return amount / 12;
    // one_time isn't recurring; irregular is treated as an already-monthly estimate.
    case 'one_time': return 0;
    case 'irregular': return amount;
    default: return 0;
  }
}

export interface DebtInput {
  accountId: string;
  name: string;
  balance: number;
  apr: number; // decimal, e.g. 0.1999
  minimumPayment: number;
}

export interface DebtPayoffStepResult {
  accountId: string;
  stepOrder: number;
  startingBalance: number;
  monthlyTargetPayment: number;
  projectedPayoffMonth: string; // YYYY-MM-01
  interestPaidEstimate: number;
}

export interface DebtPayoffPlanResult {
  monthsToPayoff: number;
  totalInterestPaid: number;
  totalDebt: number;
  projectedPayoffDate: string;
  steps: DebtPayoffStepResult[];
}

export type PayoffOrder = 'rate_desc' | 'balance_asc';

const MAX_SIMULATION_MONTHS = 600; // 50-year safety cap

/**
 * Simulates a fixed-budget payoff schedule. Avalanche = 'rate_desc' (highest
 * APR first); Snowball = 'balance_asc' (smallest balance first). Every debt's
 * minimum payment is always paid; the remaining budget is thrown at the
 * priority debt, and each payoff frees its minimum to roll into the next one.
 */
export function simulatePayoffPlan(
  debts: DebtInput[],
  monthlyBudget: number,
  order: PayoffOrder,
): DebtPayoffPlanResult {
  const totalMinimums = debts.reduce((sum, d) => sum + d.minimumPayment, 0);
  if (monthlyBudget < totalMinimums) {
    throw new Error(
      `Monthly budget ($${monthlyBudget.toFixed(2)}) is less than the sum of minimum payments ` +
      `($${totalMinimums.toFixed(2)}). Increase the budget or it's not possible to avoid default.`,
    );
  }

  const priority = [...debts].sort((a, b) =>
    order === 'rate_desc' ? b.apr - a.apr : a.balance - b.balance,
  );

  const remaining = new Map(priority.map((d) => [d.accountId, d.balance]));
  const interestPaid = new Map(priority.map((d) => [d.accountId, 0]));
  const payoffMonth = new Map<string, number>();

  let month = 0;
  const startDate = new Date();
  startDate.setUTCDate(1);

  while ([...remaining.values()].some((b) => b > 0.005) && month < MAX_SIMULATION_MONTHS) {
    month++;
    let freeBudget = monthlyBudget - totalMinimums +
      priority
        .filter((d) => payoffMonth.has(d.accountId))
        .reduce((sum, d) => sum + d.minimumPayment, 0);

    for (const d of priority) {
      let bal = remaining.get(d.accountId)!;
      if (bal <= 0) continue;

      const monthlyInterest = bal * (d.apr / 12);
      bal += monthlyInterest;
      interestPaid.set(d.accountId, interestPaid.get(d.accountId)! + monthlyInterest);

      let payment = d.minimumPayment;
      const isPriorityTarget = priority.find((x) => remaining.get(x.accountId)! > 0)?.accountId === d.accountId;
      if (isPriorityTarget) {
        payment += freeBudget;
        freeBudget = 0;
      }

      bal -= payment;
      if (bal <= 0.005) {
        bal = 0;
        if (!payoffMonth.has(d.accountId)) payoffMonth.set(d.accountId, month);
      }
      remaining.set(d.accountId, bal);
    }
  }

  const initialExtra = monthlyBudget - totalMinimums;
  const steps: DebtPayoffStepResult[] = priority.map((d, i) => {
    const monthsOut = payoffMonth.get(d.accountId) ?? month;
    const payoffDate = new Date(startDate);
    payoffDate.setUTCMonth(payoffDate.getUTCMonth() + monthsOut);
    return {
      accountId: d.accountId,
      stepOrder: i + 1,
      startingBalance: d.balance,
      // Step 1 also receives the rolling extra budget until it's paid off, then
      // that extra rolls to step 2, and so on — this is the *starting* target.
      monthlyTargetPayment: d.minimumPayment + (i === 0 ? initialExtra : 0),
      projectedPayoffMonth: payoffDate.toISOString().slice(0, 10),
      interestPaidEstimate: Math.round(interestPaid.get(d.accountId)! * 100) / 100,
    };
  });

  const finalPayoffDate = new Date(startDate);
  finalPayoffDate.setUTCMonth(finalPayoffDate.getUTCMonth() + month);

  return {
    monthsToPayoff: month,
    totalInterestPaid: Math.round([...interestPaid.values()].reduce((a, b) => a + b, 0) * 100) / 100,
    totalDebt: Math.round(debts.reduce((a, d) => a + d.balance, 0) * 100) / 100,
    projectedPayoffDate: finalPayoffDate.toISOString().slice(0, 10),
    steps,
  };
}

export function computeDebtToIncome(monthlyDebtPayments: number, monthlyIncome: number): number | null {
  if (monthlyIncome <= 0) return null;
  return Math.round((monthlyDebtPayments / monthlyIncome) * 10000) / 10000;
}

export function computeAggregateUtilization(
  accounts: Array<{ current_balance: number; credit_limit: number | null; account_type: string }>,
): number | null {
  const revolving = accounts.filter(
    (a) => (a.account_type === 'credit_card' || a.account_type === 'line_of_credit') && a.credit_limit,
  );
  const totalLimit = revolving.reduce((sum, a) => sum + (a.credit_limit ?? 0), 0);
  if (totalLimit <= 0) return null;
  const totalBalance = revolving.reduce((sum, a) => sum + a.current_balance, 0);
  return Math.round((totalBalance / totalLimit) * 10000) / 10000;
}
