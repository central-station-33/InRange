export type EntityType =
  | 'personal'
  | 'family_fund'
  | 'destination_services'
  | 'real_estate_brokerage'
  | 'film_production'
  | 'creative_services'
  | 'professional_services';

export type AccountType =
  | 'checking' | 'savings' | 'investment' | 'other_asset'
  | 'credit_card' | 'line_of_credit' | 'loan' | 'mortgage';

export type Frequency =
  | 'one_time' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | 'irregular';

export type RecommendationType = 'debt_payoff' | 'credit_building' | 'cash_flow' | 'spending_alert' | 'other';
export type RecommendationStatus = 'pending' | 'approved' | 'rejected' | 'completed';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export interface Entity {
  id: string;
  name: string;
  entity_type: EntityType;
  legal_structure: string | null;
  status: 'forming' | 'active' | 'inactive';
}

export interface Account {
  id: string;
  entity_id: string;
  name: string;
  account_type: AccountType;
  is_liability: boolean;
  current_balance: number;
  credit_limit: number | null;
  interest_rate: number | null;
  minimum_payment: number | null;
}

export interface IncomeOrExpense {
  id: string;
  entity_id: string;
  name: string;
  amount: number;
  frequency: Frequency;
  category: string | null;
}

export interface AgentRecommendationInput {
  entity_id: string | null;
  agent_name: 'finance-analyze' | 'finance-debt-payoff' | 'finance-credit-builder';
  recommendation_type: RecommendationType;
  title: string;
  rationale: string;
  details: Record<string, unknown>;
  priority: Priority;
  related_plan_id?: string | null;
  related_credit_action_id?: string | null;
}

export interface EdgeFnResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
