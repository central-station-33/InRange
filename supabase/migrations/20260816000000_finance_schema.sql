-- Finance Agents: Schema
-- Personal + business financial data, AI-agent recommendations, and the
-- human-approval gate. Lives in its own `finance` schema so it stays fully
-- separate from the real-estate lead-gen tables in `public`.
--
-- Design principle: agents READ financial data and WRITE recommendations.
-- Nothing in this schema ever moves money, submits a credit application, or
-- changes an account balance automatically. A human must flip a
-- recommendation to 'approved' via finance-approvals before any action is
-- considered authorized — and even then, execution is a manual step taken
-- by a human outside this system (see docs/finance-approval-workflow.md).

CREATE SCHEMA IF NOT EXISTS finance;

-- ─── Entities ───────────────────────────────────────────────────────────────
-- One row per "book of finances": the personal household plus each business.

CREATE TABLE finance.entities (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL UNIQUE,
  entity_type       TEXT        NOT NULL CHECK (entity_type IN (
                                  'personal', 'family_fund', 'destination_services',
                                  'real_estate_brokerage', 'film_production',
                                  'creative_services', 'professional_services'
                                )),
  legal_structure   TEXT        CHECK (legal_structure IN (
                                  'individual', 'sole_prop', 'llc', 's_corp', 'c_corp', 'partnership'
                                )),
  status            TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('forming', 'active', 'inactive')),
  formed_date       DATE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Plaid integration stub ─────────────────────────────────────────────────
-- Not implemented yet — no live bank connections ship in this pass. This
-- table exists so `accounts.data_source = 'plaid'` has somewhere to point
-- once that integration is built. Never store a plaintext access token here.

CREATE TABLE finance.plaid_items (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             UUID        NOT NULL REFERENCES finance.entities(id) ON DELETE CASCADE,
  institution_name      TEXT,
  access_token_encrypted TEXT,
  status                TEXT        NOT NULL DEFAULT 'not_connected'
                                     CHECK (status IN ('not_connected', 'connected', 'error', 'revoked')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Accounts (assets & liabilities) ───────────────────────────────────────

CREATE TABLE finance.accounts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         UUID        NOT NULL REFERENCES finance.entities(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  account_type      TEXT        NOT NULL CHECK (account_type IN (
                                  'checking', 'savings', 'investment', 'other_asset',
                                  'credit_card', 'line_of_credit', 'loan', 'mortgage'
                                )),
  is_liability      BOOLEAN     NOT NULL,
  institution       TEXT,
  data_source       TEXT        NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'plaid')),
  plaid_item_id     UUID        REFERENCES finance.plaid_items(id) ON DELETE SET NULL,
  current_balance   NUMERIC     NOT NULL DEFAULT 0,
  credit_limit      NUMERIC     CHECK (credit_limit IS NULL OR credit_limit >= 0),
  interest_rate     NUMERIC     CHECK (interest_rate IS NULL OR interest_rate >= 0),
  minimum_payment   NUMERIC     CHECK (minimum_payment IS NULL OR minimum_payment >= 0),
  opened_date       DATE,
  status            TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  last_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Income & expenses (recurring, not per-transaction) ────────────────────

CREATE TABLE finance.income_sources (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    UUID        NOT NULL REFERENCES finance.entities(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  amount       NUMERIC     NOT NULL CHECK (amount >= 0),
  frequency    TEXT        NOT NULL CHECK (frequency IN (
                             'one_time', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'irregular'
                           )),
  category     TEXT,
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE finance.expenses (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    UUID        NOT NULL REFERENCES finance.entities(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  amount       NUMERIC     NOT NULL CHECK (amount >= 0),
  frequency    TEXT        NOT NULL CHECK (frequency IN (
                             'one_time', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'irregular'
                           )),
  category     TEXT,
  essential    BOOLEAN     NOT NULL DEFAULT TRUE,
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Transactions (manual/CSV import today; plaid sync later) ─────────────

CREATE TABLE finance.transactions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES finance.accounts(id) ON DELETE CASCADE,
  entity_id    UUID        NOT NULL REFERENCES finance.entities(id) ON DELETE CASCADE,
  posted_date  DATE        NOT NULL,
  description  TEXT        NOT NULL,
  amount       NUMERIC     NOT NULL, -- negative = outflow, positive = inflow
  category     TEXT,
  data_source  TEXT        NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'plaid')),
  external_id  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, external_id)
);

-- ─── Agent output: point-in-time financial snapshots ───────────────────────

CREATE TABLE finance.financial_snapshots (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           UUID        REFERENCES finance.entities(id) ON DELETE CASCADE, -- NULL = consolidated
  snapshot_date       DATE        NOT NULL DEFAULT CURRENT_DATE,
  total_assets        NUMERIC     NOT NULL,
  total_liabilities   NUMERIC     NOT NULL,
  net_worth           NUMERIC     NOT NULL,
  monthly_income      NUMERIC     NOT NULL,
  monthly_expenses    NUMERIC     NOT NULL,
  monthly_cash_flow   NUMERIC     NOT NULL,
  debt_to_income      NUMERIC,
  credit_utilization  NUMERIC,
  details             JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Debt payoff plans (avalanche / snowball / hybrid) ─────────────────────

CREATE TABLE finance.debt_payoff_plans (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id               UUID        REFERENCES finance.entities(id) ON DELETE CASCADE, -- NULL = across all entities
  strategy                TEXT        NOT NULL CHECK (strategy IN ('avalanche', 'snowball', 'hybrid')),
  status                  TEXT        NOT NULL DEFAULT 'proposed'
                                       CHECK (status IN ('proposed', 'approved', 'rejected', 'active', 'completed')),
  monthly_payment_budget  NUMERIC     NOT NULL,
  total_debt              NUMERIC     NOT NULL,
  months_to_payoff        INTEGER     NOT NULL,
  projected_payoff_date   DATE        NOT NULL,
  total_interest_paid     NUMERIC     NOT NULL,
  generated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at             TIMESTAMPTZ,
  approved_by             TEXT
);

CREATE TABLE finance.debt_payoff_steps (
  id                        UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                   UUID     NOT NULL REFERENCES finance.debt_payoff_plans(id) ON DELETE CASCADE,
  account_id                UUID     NOT NULL REFERENCES finance.accounts(id) ON DELETE CASCADE,
  step_order                INTEGER  NOT NULL,
  starting_balance          NUMERIC  NOT NULL,
  monthly_target_payment    NUMERIC  NOT NULL,
  projected_payoff_month    DATE     NOT NULL,
  interest_paid_estimate    NUMERIC  NOT NULL
);

-- ─── Business credit building ───────────────────────────────────────────────

CREATE TABLE finance.business_credit_profiles (
  id                                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                              UUID        NOT NULL UNIQUE REFERENCES finance.entities(id) ON DELETE CASCADE,
  has_ein                                BOOLEAN     NOT NULL DEFAULT FALSE,
  has_dedicated_business_bank_account    BOOLEAN     NOT NULL DEFAULT FALSE,
  has_duns_number                        BOOLEAN     NOT NULL DEFAULT FALSE,
  duns_number                            TEXT,
  entity_age_months                      INTEGER,
  trade_lines_count                      INTEGER     NOT NULL DEFAULT 0,
  business_credit_cards_count            INTEGER     NOT NULL DEFAULT 0,
  reporting_bureaus                      TEXT[]      NOT NULL DEFAULT '{}',
  estimated_stage                        TEXT        NOT NULL DEFAULT 'not_started'
                                          CHECK (estimated_stage IN (
                                            'not_started', 'foundation', 'building', 'established', 'optimizing'
                                          )),
  last_reviewed_at                       TIMESTAMPTZ,
  notes                                  TEXT,
  created_at                             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE finance.credit_building_actions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID        NOT NULL REFERENCES finance.entities(id) ON DELETE CASCADE,
  action_key      TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  description     TEXT        NOT NULL,
  sequence_order  INTEGER     NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'not_started'
                               CHECK (status IN ('not_started', 'recommended', 'in_progress', 'completed', 'skipped')),
  recommended_at  TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_id, action_key)
);

-- ─── Agent recommendations: the human-approval gate ────────────────────────
-- Every action an agent proposes — a debt payoff plan, a credit-building
-- step, a spending alert — lands here as 'pending'. Nothing downstream
-- executes until finance-approvals flips it to 'approved'.

CREATE TABLE finance.agent_recommendations (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                 UUID        REFERENCES finance.entities(id) ON DELETE CASCADE, -- NULL = household-wide
  agent_name                TEXT        NOT NULL CHECK (agent_name IN (
                                          'finance-analyze', 'finance-debt-payoff', 'finance-credit-builder'
                                        )),
  recommendation_type       TEXT        NOT NULL CHECK (recommendation_type IN (
                                          'debt_payoff', 'credit_building', 'cash_flow', 'spending_alert', 'other'
                                        )),
  title                     TEXT        NOT NULL,
  rationale                 TEXT        NOT NULL,
  details                   JSONB       NOT NULL DEFAULT '{}',
  priority                  TEXT        NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status                    TEXT        NOT NULL DEFAULT 'pending'
                                         CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  related_plan_id           UUID        REFERENCES finance.debt_payoff_plans(id) ON DELETE SET NULL,
  related_credit_action_id  UUID        REFERENCES finance.credit_building_actions(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at                TIMESTAMPTZ,
  decided_by                TEXT,
  decision_notes            TEXT
);

CREATE TABLE finance.recommendation_events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id   UUID        NOT NULL REFERENCES finance.agent_recommendations(id) ON DELETE CASCADE,
  event_type          TEXT        NOT NULL CHECK (event_type IN ('created', 'approved', 'rejected', 'completed', 'note')),
  actor               TEXT,
  detail              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX idx_finance_accounts_entity            ON finance.accounts(entity_id);
CREATE INDEX idx_finance_accounts_liability          ON finance.accounts(is_liability);
CREATE INDEX idx_finance_income_entity               ON finance.income_sources(entity_id);
CREATE INDEX idx_finance_expenses_entity             ON finance.expenses(entity_id);
CREATE INDEX idx_finance_transactions_account        ON finance.transactions(account_id);
CREATE INDEX idx_finance_transactions_entity_date     ON finance.transactions(entity_id, posted_date DESC);
CREATE INDEX idx_finance_snapshots_entity_date        ON finance.financial_snapshots(entity_id, snapshot_date DESC);
CREATE INDEX idx_finance_debt_steps_plan              ON finance.debt_payoff_steps(plan_id);
CREATE INDEX idx_finance_credit_actions_entity        ON finance.credit_building_actions(entity_id);
CREATE INDEX idx_finance_recommendations_status       ON finance.agent_recommendations(status);
CREATE INDEX idx_finance_recommendations_entity       ON finance.agent_recommendations(entity_id);
CREATE INDEX idx_finance_recommendation_events_rec_id ON finance.recommendation_events(recommendation_id);

-- ─── Auto-update updated_at ─────────────────────────────────────────────────
-- Reuses the public.set_updated_at() trigger function defined by the
-- lead-gen migration — same database, so no need to redefine it.

CREATE TRIGGER trg_finance_entities_updated_at
  BEFORE UPDATE ON finance.entities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_finance_accounts_updated_at
  BEFORE UPDATE ON finance.accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_finance_income_updated_at
  BEFORE UPDATE ON finance.income_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_finance_expenses_updated_at
  BEFORE UPDATE ON finance.expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_finance_credit_profiles_updated_at
  BEFORE UPDATE ON finance.business_credit_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── Row-Level Security ─────────────────────────────────────────────────────
-- Edge functions use the service role key (bypasses RLS). RLS here is a
-- floor so any future dashboard/anon role can't touch this data without an
-- explicit grant — financial data across 6 businesses + household is not
-- something to expose by default the way the lead-gen tables are.

ALTER TABLE finance.entities                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.accounts                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.plaid_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.income_sources            ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.expenses                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.transactions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.financial_snapshots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.debt_payoff_plans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.debt_payoff_steps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.business_credit_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.credit_building_actions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.agent_recommendations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.recommendation_events     ENABLE ROW LEVEL SECURITY;

-- No policies are created for `authenticated` or `anon` here on purpose.
-- Add explicit, narrowly-scoped policies (e.g. "owner can read their own
-- entities") once real user auth exists for a dashboard. Until then, only
-- the service role (used by edge functions) can read/write this schema.

-- ─── Seed: known entities ───────────────────────────────────────────────────
-- Structural rows only — no real balances, account numbers, or financial
-- figures. Populate actual numbers via finance-import-transactions or
-- direct inserts to finance.accounts / income_sources / expenses.

INSERT INTO finance.entities (name, entity_type, legal_structure, status, notes) VALUES
  ('Household',                                  'personal',              'individual', 'active', 'Personal/household finances'),
  ('BT Capital',                                  'family_fund',           NULL,         'forming', 'Family investment fund — just started'),
  ('The J.E.T Group',                             'destination_services',  NULL,         'active', 'Destination service provider'),
  ('Jet Realty Advisors',                         'real_estate_brokerage', NULL,         'active', 'Real estate brokerage'),
  ('Kei Productions Inc',                         'film_production',       NULL,         'active', 'Film/TV production'),
  ('Keia Bounds Costume Design',                  'creative_services',     NULL,         'active', 'Costume designer'),
  ('James Thompson — Highline Residential',       'professional_services', NULL,         'active', 'Residential association broker')
ON CONFLICT (name) DO NOTHING;
