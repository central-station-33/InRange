-- InRange: Baseline schema snapshot, reverse-engineered from the live production
-- Supabase project ("InRange", project ref omzugrtgwsjypekuzgtn) on 2026-09-17.
--
-- WHY THIS FILE EXISTS
-- The two migrations that previously lived in this directory
-- (20240101000000_initial_schema.sql, 20240101000001_views_and_functions.sql)
-- described an early, abandoned version of the schema (properties.source as
-- nyc/nj enum, no owner_id, no isa_leads/deals/outreach/etc). Since then, 30
-- migrations were applied directly to the live project via direct DB access
-- and never committed to this repo. Git and production had completely
-- diverged: this repo had 2 tables' worth of schema, production has 18
-- tables, 3 views, 7 functions, 6 triggers, and an RLS-auto-enable event
-- trigger. This file is a best-effort reconstruction of the CURRENT live
-- state (columns, constraints, indexes, RLS policies, views, functions,
-- triggers), built from introspection (information_schema, pg_catalog), not
-- a replay of the 30 individual historical migrations (their individual SQL
-- bodies aren't recoverable from migration history alone).
--
-- SAFETY: every statement is idempotent (IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS then CREATE) specifically so this file is a harmless
-- no-op if ever run against the live project it was extracted from, and a
-- faithful bootstrap if run against a fresh database (new dev/staging env).
-- It does not include data, RLS grant statements for `anon`, or secrets.
--
-- The `ensure_rls` event trigger at the bottom auto-enables RLS on any new
-- table created in `public` — it requires elevated privileges to install
-- (works fine via the Supabase migration path, may fail in a low-privilege
-- local psql session; that's expected and safe to ignore for local dev).

-- ═══════════════════════════════════════════════════════════════════════
-- Extensions
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp"       WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto          WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm           WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
-- NOTE: pg_net lives in `public` on the live project — the Supabase linter
-- flags this (extension_in_public). Left as-is here to match reality; move
-- it to its own schema in a follow-up migration rather than silently here.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ═══════════════════════════════════════════════════════════════════════
-- Tables (dependency order: referenced tables first)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.owners (
  owner_id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  resolved_name           TEXT,
  owner_type               TEXT,
  email                     TEXT,
  phone                     TEXT,
  mailing_address           TEXT,
  contact_strategy_note     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.team_agents (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         TEXT        NOT NULL,
  email             TEXT        UNIQUE,
  phone             TEXT,
  license_number    TEXT,
  market            TEXT        NOT NULL CHECK (market = ANY (ARRAY['nyc','nj','both'])),
  brokerage         TEXT        NOT NULL CHECK (brokerage = ANY (ARRAY['highline','jet_realty'])),
  status            TEXT        NOT NULL DEFAULT 'active' CHECK (status = ANY (ARRAY['active','inactive','probation'])),
  self_sourced_pct  NUMERIC(5,2) NOT NULL DEFAULT 85.00,
  team_lead_pct     NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  override_pct      NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  ytd_volume        NUMERIC     DEFAULT 0,
  ytd_gci           NUMERIC     DEFAULT 0,
  ytd_deals         INTEGER     DEFAULT 0,
  last_deal_date    DATE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.relocation_partners (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_name      TEXT        NOT NULL UNIQUE,
  your_pct          NUMERIC(5,2) NOT NULL DEFAULT 35.00,
  referral_fee_pct  NUMERIC(5,2) NOT NULL DEFAULT 30.00,
  notes             TEXT,
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.raw_properties (
  id             UUID        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  property_hash  TEXT        NOT NULL,
  source         TEXT        NOT NULL,
  raw_data       JSONB       NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.properties (
  id                          UUID        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  property_hash               TEXT        NOT NULL UNIQUE,
  source                      TEXT,
  data_sources                JSONB       DEFAULT '[]'::jsonb,
  address                     TEXT,
  city                        TEXT,
  state                       CHAR(2),
  zip                         TEXT,
  county                      TEXT,
  lat                         NUMERIC(10,7),
  lng                         NUMERIC(10,7),
  property_type               TEXT,
  bedrooms                    SMALLINT,
  bathrooms                   NUMERIC(4,1),
  square_footage               INTEGER,
  year_built                  SMALLINT,
  estimated_arv                NUMERIC(12,2),
  amount_owed                  NUMERIC(12,2),
  asking_price                 NUMERIC(12,2),
  equity                       NUMERIC(12,2),
  equity_percentage             SMALLINT,
  below_market_percentage       SMALLINT,
  assessed_value                NUMERIC(12,2),
  taxes_owed                    NUMERIC(12,2),
  owner_name                    TEXT,
  owner_phone                   TEXT,
  owner_email                   TEXT,
  owner_mailing_address         TEXT,
  owner_type                    TEXT,
  owner_state                   CHAR(2),
  distress_indicators           JSONB       DEFAULT '[]'::jsonb,
  notice_date                   TIMESTAMPTZ,
  auction_date                  TIMESTAMPTZ,
  process_stage                 TEXT,
  case_number                   TEXT,
  distress_score                 SMALLINT    CHECK (distress_score BETWEEN 0 AND 100),
  deal_quality_score              SMALLINT    CHECK (deal_quality_score BETWEEN 0 AND 100),
  contact_likelihood_score        SMALLINT    CHECK (contact_likelihood_score BETWEEN 0 AND 100),
  timeline_urgency_score          SMALLINT    CHECK (timeline_urgency_score BETWEEN 0 AND 100),
  composite_score                 SMALLINT    CHECK (composite_score BETWEEN 0 AND 100),
  priority_tier                   TEXT        CHECK (priority_tier = ANY (ARRAY['Tier 1','Tier 2','Tier 3','Tier 4'])),
  deal_type                       TEXT,
  burnt_out_landlord_score         SMALLINT    CHECK (burnt_out_landlord_score BETWEEN 0 AND 100),
  burnt_out_signals                JSONB,
  ai_analysis                      JSONB,
  ai_enriched_at                   TIMESTAMPTZ,
  enrichment_status                 TEXT        DEFAULT 'pending' CHECK (enrichment_status = ANY (ARRAY['pending','processing','complete','failed','skipped'])),
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  burnt_out_score                   SMALLINT    CHECK (burnt_out_score BETWEEN 0 AND 100),
  owner_id                          UUID        REFERENCES public.owners(owner_id),
  status                             TEXT        DEFAULT 'new_lead',
  notes                              TEXT,
  tags                               TEXT[]      DEFAULT '{}',
  last_contacted_at                  TIMESTAMPTZ,
  skip_trace_status                  TEXT,
  skip_traced_at                     TIMESTAMPTZ,
  quarantined_at                     TIMESTAMPTZ,
  quarantine_reason                  TEXT,
  owner_kind                         TEXT        CHECK (owner_kind IS NULL OR owner_kind = ANY (ARRAY['individual','entity','unknown'])),
  arv_source                         TEXT        CHECK (arv_source IS NULL OR arv_source = ANY (ARRAY['comps','ingest','ai_refined'])),
  arv_comp_count                     INTEGER,
  arv_computed_at                    TIMESTAMPTZ,
  arv_comp_method                    TEXT        CHECK (arv_comp_method IS NULL OR arv_comp_method = ANY (ARRAY['price_per_sqft','median_sold_price'])),
  zip_source                         TEXT        CHECK (zip_source IS NULL OR zip_source = ANY (ARRAY['ingest','census_geocoded'])),
  zip_geocoded_at                    TIMESTAMPTZ
);
COMMENT ON COLUMN public.properties.quarantined_at IS 'Set when a row must be excluded from every pipeline stage and the dashboard. Non-destructive alternative to deletion.';
COMMENT ON COLUMN public.properties.owner_kind IS 'Computed by classifyOwnerKind() in _shared/owner-classification.ts from owner_name shape. owner_type is not reliable for this -- NJ MOD-IV writes building/program names into owner_name with owner_type=individual regardless.';
COMMENT ON COLUMN public.properties.arv_source IS 'Where estimated_arv came from: comps (estimate-arv-comps, real sold MLS comps), ingest (source data normalization), ai_refined (enrich-property''s Claude estimate). NULL for rows written before this column existed.';
COMMENT ON COLUMN public.properties.zip_source IS 'ingest = whatever the raw source wrote (often wrong for NJ -- see CLAUDE.md), census_geocoded = corrected by backfill-nj-zip. NULL for rows never touched by the backfill.';

CREATE TABLE IF NOT EXISTS public.isa_leads (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  segment               TEXT        NOT NULL CHECK (segment = ANY (ARRAY[
                                      'athlete','expat_relocation','investor','film_tv','motivated_seller',
                                      'first_time_buyer','divorce','empty_nester','developer','homeowner',
                                      'renter','general_inquiry'])),
  market                TEXT        NOT NULL CHECK (market = ANY (ARRAY['nyc','nj'])),
  commission_source     TEXT        NOT NULL DEFAULT 'inrange_generated' CHECK (commission_source = ANY (ARRAY[
                                      'self_sourced','relocation_partner','inrange_generated','brokerage_provided','agent_sourced'])),
  full_name             TEXT,
  entity_name           TEXT,
  email                 TEXT,
  phone                 TEXT,
  linkedin_url          TEXT,
  instagram_handle      TEXT,
  rep_name              TEXT,
  rep_email             TEXT,
  rep_phone             TEXT,
  rep_agency            TEXT,
  bant_score            INTEGER     CHECK (bant_score BETWEEN 0 AND 12),
  motivation_score      INTEGER     CHECK (motivation_score BETWEEN 1 AND 5),
  routing               TEXT        NOT NULL DEFAULT 'new' CHECK (routing = ANY (ARRAY['hot','warm','nurture','cold','new'])),
  assigned_agent_id     UUID        REFERENCES public.team_agents(id),
  assigned_isa          TEXT,
  outreach_status       TEXT        NOT NULL DEFAULT 'new' CHECK (outreach_status = ANY (ARRAY[
                                      'new','attempting','contacted','qualified','appointment_set',
                                      'showing_scheduled','under_contract','closed','dead'])),
  property_address      TEXT,
  motivation_signals    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  ai_summary            TEXT,
  isa_talking_points     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  source_url             TEXT,
  source_name             TEXT,
  contract_value           NUMERIC,
  team_name                TEXT,
  sport                     TEXT,
  origin_country             TEXT,
  employer                   TEXT,
  production_name            TEXT,
  permit_number               TEXT,
  price_range_min              NUMERIC,
  price_range_max               NUMERIC,
  timeline_months                INTEGER,
  raw_data                        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  county                           TEXT,
  state                            CHAR(2)     DEFAULT 'NY',
  relocation_partner_id            UUID        REFERENCES public.relocation_partners(id),
  first_response_at                TIMESTAMPTZ,
  inbound_channel                  TEXT,
  inbound_message                  TEXT,
  cadence_step                     SMALLINT    NOT NULL DEFAULT 0,
  last_cadence_at                  TIMESTAMPTZ,
  cadence_paused                   BOOLEAN     NOT NULL DEFAULT FALSE,
  skip_trace_status                 TEXT,
  skip_traced_at                    TIMESTAMPTZ,
  ai_investment_thesis              TEXT,
  ai_contact_strategy               TEXT,
  ai_bant_budget                    SMALLINT    CHECK (ai_bant_budget IS NULL OR ai_bant_budget BETWEEN 0 AND 3),
  ai_bant_authority                 SMALLINT    CHECK (ai_bant_authority IS NULL OR ai_bant_authority BETWEEN 0 AND 3),
  ai_bant_need                      SMALLINT    CHECK (ai_bant_need IS NULL OR ai_bant_need BETWEEN 0 AND 3),
  ai_bant_timing                    SMALLINT    CHECK (ai_bant_timing IS NULL OR ai_bant_timing BETWEEN 0 AND 3),
  ai_confidence                     SMALLINT    CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 1 AND 5),
  ai_risk_flags                     TEXT[],
  ai_model                          TEXT,
  ai_prompt_version                 TEXT,
  ai_enriched_at                    TIMESTAMPTZ,
  ai_input_tokens                   INTEGER,
  ai_output_tokens                  INTEGER
);
COMMENT ON COLUMN public.isa_leads.first_response_at IS 'Timestamp of the first auto-response sent to this lead. Set once by respond-lead; never overwritten.';
COMMENT ON COLUMN public.isa_leads.inbound_channel IS 'Channel the lead came in on: sms, email, website_form, zillow, etc.';
COMMENT ON COLUMN public.isa_leads.inbound_message IS 'The raw message text the lead sent on first contact.';
COMMENT ON COLUMN public.isa_leads.cadence_step IS '0=not started, 1=day1, 2=day3, 3=day7, 4=day14, 5=day30 (complete)';
COMMENT ON COLUMN public.isa_leads.last_cadence_at IS 'Timestamp of the last auto cadence SMS sent to this lead.';
COMMENT ON COLUMN public.isa_leads.cadence_paused IS 'True when cadence is paused (replied, appointment set, opted out).';
COMMENT ON COLUMN public.isa_leads.ai_prompt_version IS 'ENRICH_PROMPT_VERSION from enrich-leads at write time. Bump it in the function whenever the prompt changes meaning, so superseded assessments are identifiable.';

CREATE TABLE IF NOT EXISTS public.deals (
  id                    UUID        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  property_id           UUID        UNIQUE REFERENCES public.properties(id),
  status                TEXT,
  deal_type             TEXT,
  offer_price           NUMERIC(12,2),
  contract_price        NUMERIC(12,2),
  close_date            DATE,
  profit_estimate       NUMERIC(12,2),
  notes                 TEXT,
  agent_id              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_agent_id     UUID        REFERENCES public.team_agents(id),
  isa_lead_id           UUID        REFERENCES public.isa_leads(id),
  commission_source     TEXT        CHECK (commission_source = ANY (ARRAY[
                                      'self_sourced','relocation_partner','inrange_generated','brokerage_provided','agent_sourced'])),
  sale_price            NUMERIC,
  commission_rate_pct   NUMERIC(5,3) DEFAULT 2.500,
  gross_commission      NUMERIC,
  your_split_pct        NUMERIC(5,2),
  agent_split_pct       NUMERIC(5,2),
  override_pct          NUMERIC(5,2) DEFAULT 0,
  your_gross            NUMERIC,
  agent_gross           NUMERIC,
  your_override         NUMERIC,
  your_total            NUMERIC
);

CREATE TABLE IF NOT EXISTS public.scores (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id        TEXT        NOT NULL,
  property_id      UUID        REFERENCES public.properties(id),
  score            INTEGER     NOT NULL CHECK (score BETWEEN 0 AND 100),
  final_tier       INTEGER     NOT NULL CHECK (final_tier BETWEEN 1 AND 4),
  score_narrative  TEXT,
  scored_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.outreach (
  outreach_id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id                    TEXT        NOT NULL,
  property_id                  UUID        REFERENCES public.properties(id),
  owner_id                     UUID        REFERENCES public.owners(owner_id),
  channel                      TEXT        NOT NULL DEFAULT 'multi' CHECK (channel = ANY (ARRAY['sms','email','mailer','multi'])),
  status                       TEXT        NOT NULL DEFAULT 'pending_review' CHECK (status = ANY (ARRAY['pending_review','approved','sent','failed','skipped'])),
  sms_copy                     TEXT,
  email_subject                TEXT,
  email_body                   TEXT,
  mailer_copy                  TEXT,
  personalization_confidence   INTEGER     CHECK (personalization_confidence BETWEEN 0 AND 100),
  tone_rationale                TEXT,
  agent_id                      TEXT,
  sent_at                        TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.outcomes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  outreach_id    UUID        NOT NULL REFERENCES public.outreach(outreach_id),
  outcome_type   TEXT        NOT NULL,
  notes          TEXT,
  recorded_by    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.contact_activities (
  id              UUID        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  property_id     UUID        REFERENCES public.properties(id),
  contact_method  TEXT,
  contact_date    TIMESTAMPTZ,
  outcome         TEXT,
  notes           TEXT,
  agent_id        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.notification_log (
  id                 UUID        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  property_id        UUID        REFERENCES public.properties(id),
  notification_type  TEXT,
  recipient          TEXT,
  status             TEXT,
  error_message      TEXT,
  sent_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.lead_touches (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID        NOT NULL REFERENCES public.isa_leads(id),
  touch_number  INTEGER     NOT NULL,
  channel       TEXT        NOT NULL CHECK (channel = ANY (ARRAY['call','sms','email','dm','voicemail','mailer'])),
  outcome       TEXT        CHECK (outcome = ANY (ARRAY['no_answer','voicemail','callback_requested','not_interested','interested','appointment_set','wrong_number'])),
  notes         TEXT,
  isa_name      TEXT,
  touched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lead_id, touch_number)
);

CREATE TABLE IF NOT EXISTS public.agent_routing_rules (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID        NOT NULL REFERENCES public.team_agents(id),
  segment          TEXT,
  market           TEXT,
  priority         INTEGER     NOT NULL DEFAULT 10,
  max_active_leads INTEGER     NOT NULL DEFAULT 25,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.skip_trace_confirmations (
  token         TEXT        PRIMARY KEY,
  table_name    TEXT        NOT NULL,
  segment       TEXT,
  record_ids    JSONB       NOT NULL,
  record_count  INTEGER     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.inrange_leads (
  id                UUID        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  source            TEXT        NOT NULL,
  parcel_id         TEXT,
  address           TEXT,
  city              TEXT,
  state             CHAR(2),
  zip               TEXT,
  county            TEXT,
  property_type     TEXT,
  distress_signals  TEXT[],
  raw_payload       JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (parcel_id, source)
);

-- content_queue / automation_settings: not part of the InRange lead pipeline
-- (they back a separate blog/social auto-publishing feature in the same
-- project) but are real, RLS-enabled objects in this database. Included for
-- completeness/accuracy; leave them alone unless that feature is in scope.

CREATE TABLE IF NOT EXISTS public.content_queue (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_for      DATE        NOT NULL DEFAULT CURRENT_DATE,
  status             TEXT        NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending','approved','published','rejected'])),
  content_type       TEXT        NOT NULL CHECK (content_type = ANY (ARRAY['blog-post','linkedin','twitter','facebook','instagram'])),
  title              TEXT,
  body               TEXT        NOT NULL,
  meta_description   TEXT,
  tags               TEXT[],
  platform_data      JSONB       DEFAULT '{}'::jsonb,
  published_at       TIMESTAMPTZ,
  published_url      TEXT,
  agent_run_id       UUID,
  brand              TEXT,
  topic              TEXT,
  audience           TEXT,
  rejection_note     TEXT
);

CREATE TABLE IF NOT EXISTS public.automation_settings (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        REFERENCES auth.users(id),
  brand_name               TEXT        NOT NULL DEFAULT '',
  target_topic             TEXT        NOT NULL DEFAULT '',
  target_audience          TEXT        NOT NULL DEFAULT '',
  wordpress_url            TEXT        NOT NULL DEFAULT '',
  wordpress_username       TEXT        NOT NULL DEFAULT '',
  wordpress_app_password   TEXT        NOT NULL DEFAULT '',
  make_webhook_url         TEXT        NOT NULL DEFAULT '',
  schedule_hour            INTEGER     NOT NULL DEFAULT 8 CHECK (schedule_hour BETWEEN 0 AND 23),
  auto_publish_blog        BOOLEAN     NOT NULL DEFAULT FALSE,
  auto_publish_social      BOOLEAN     NOT NULL DEFAULT FALSE,
  active                   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

-- ═══════════════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_routing_agent ON public.agent_routing_rules USING btree (agent_id);
CREATE INDEX IF NOT EXISTS idx_routing_segment ON public.agent_routing_rules USING btree (segment, market);

CREATE UNIQUE INDEX IF NOT EXISTS automation_settings_user_idx ON public.automation_settings USING btree (user_id);

CREATE INDEX IF NOT EXISTS contact_prop_idx ON public.contact_activities USING btree (property_id);

CREATE INDEX IF NOT EXISTS content_queue_agent_run_idx ON public.content_queue USING btree (agent_run_id);
CREATE INDEX IF NOT EXISTS content_queue_scheduled_idx ON public.content_queue USING btree (scheduled_for DESC);
CREATE INDEX IF NOT EXISTS content_queue_status_idx ON public.content_queue USING btree (status);

CREATE INDEX IF NOT EXISTS idx_isa_leads_agent ON public.isa_leads USING btree (assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_isa_leads_created ON public.isa_leads USING btree (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_isa_leads_dedup ON public.isa_leads USING btree (segment, market, COALESCE(full_name, entity_name, ''))
  WHERE (outreach_status <> ALL (ARRAY['dead','closed']));
CREATE INDEX IF NOT EXISTS idx_isa_leads_market ON public.isa_leads USING btree (market);
CREATE INDEX IF NOT EXISTS idx_isa_leads_routing ON public.isa_leads USING btree (routing);
CREATE INDEX IF NOT EXISTS idx_isa_leads_segment ON public.isa_leads USING btree (segment);
CREATE INDEX IF NOT EXISTS idx_isa_leads_source ON public.isa_leads USING btree (commission_source);
CREATE INDEX IF NOT EXISTS idx_isa_leads_status ON public.isa_leads USING btree (outreach_status);
CREATE INDEX IF NOT EXISTS isa_leads_ai_provenance_idx ON public.isa_leads USING btree (ai_prompt_version, ai_model, ai_enriched_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_touches_lead ON public.lead_touches USING btree (lead_id);

CREATE INDEX IF NOT EXISTS notif_prop_idx ON public.notification_log USING btree (property_id);
CREATE INDEX IF NOT EXISTS notif_status_idx ON public.notification_log USING btree (status);

CREATE INDEX IF NOT EXISTS idx_outcomes_outreach_id ON public.outcomes USING btree (outreach_id);

CREATE INDEX IF NOT EXISTS idx_outreach_owner_id ON public.outreach USING btree (owner_id);
CREATE INDEX IF NOT EXISTS idx_outreach_parcel_id ON public.outreach USING btree (parcel_id);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON public.outreach USING btree (status);

CREATE INDEX IF NOT EXISTS idx_owners_email ON public.owners USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_owners_phone ON public.owners USING btree (phone) WHERE (phone IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_properties_burnt_out_score ON public.properties USING btree (burnt_out_score DESC) WHERE (burnt_out_score IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_properties_owner_id ON public.properties USING btree (owner_id) WHERE (owner_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS prop_address_trgm_idx ON public.properties USING gin (address extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS prop_auction_idx ON public.properties USING btree (auction_date);
CREATE INDEX IF NOT EXISTS prop_county_idx ON public.properties USING btree (county);
CREATE INDEX IF NOT EXISTS prop_created_idx ON public.properties USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS prop_enrich_idx ON public.properties USING btree (enrichment_status);
CREATE INDEX IF NOT EXISTS prop_score_idx ON public.properties USING btree (composite_score DESC);
CREATE INDEX IF NOT EXISTS prop_state_idx ON public.properties USING btree (state);
CREATE INDEX IF NOT EXISTS prop_tier_idx ON public.properties USING btree (priority_tier);
CREATE INDEX IF NOT EXISTS properties_owner_kind_idx ON public.properties USING btree (owner_kind);
CREATE INDEX IF NOT EXISTS properties_quarantined_at_idx ON public.properties USING btree (quarantined_at) WHERE (quarantined_at IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS raw_properties_hash_idx ON public.raw_properties USING btree (property_hash);
CREATE INDEX IF NOT EXISTS raw_properties_unprocessed_idx ON public.raw_properties USING btree (received_at) WHERE (processed_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_scores_parcel_id ON public.scores USING btree (parcel_id);
CREATE INDEX IF NOT EXISTS idx_scores_scored_at ON public.scores USING btree (parcel_id, scored_at DESC);

CREATE INDEX IF NOT EXISTS skip_trace_confirmations_expires_idx ON public.skip_trace_confirmations USING btree (expires_at);

-- ═══════════════════════════════════════════════════════════════════════
-- Row-Level Security
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.agent_routing_rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_activities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_queue            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inrange_leads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.isa_leads                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_touches             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcomes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owners                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raw_properties           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relocation_partners      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scores                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skip_trace_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_agents              ENABLE ROW LEVEL SECURITY;

-- Policies are dropped and recreated so this file stays the single source of
-- truth for policy definitions (idempotent; no ALTER POLICY dance needed).

DROP POLICY IF EXISTS "auth all routing" ON public.agent_routing_rules;
CREATE POLICY "auth all routing" ON public.agent_routing_rules FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "users manage own settings" ON public.automation_settings;
CREATE POLICY "users manage own settings" ON public.automation_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "auth all contact_activities" ON public.contact_activities;
CREATE POLICY "auth all contact_activities" ON public.contact_activities FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated users manage content_queue" ON public.content_queue;
CREATE POLICY "authenticated users manage content_queue" ON public.content_queue FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all deals" ON public.deals;
CREATE POLICY "auth all deals" ON public.deals FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth read inrange_leads" ON public.inrange_leads;
CREATE POLICY "auth read inrange_leads" ON public.inrange_leads FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth all isa_leads" ON public.isa_leads;
CREATE POLICY "auth all isa_leads" ON public.isa_leads FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "auth all lead_touches" ON public.lead_touches;
CREATE POLICY "auth all lead_touches" ON public.lead_touches FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "auth read notification_log" ON public.notification_log;
CREATE POLICY "auth read notification_log" ON public.notification_log FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth read outcomes" ON public.outcomes;
CREATE POLICY "auth read outcomes" ON public.outcomes FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth read outreach" ON public.outreach;
CREATE POLICY "auth read outreach" ON public.outreach FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "auth read owners" ON public.owners;
CREATE POLICY "auth read owners" ON public.owners FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth all properties" ON public.properties;
CREATE POLICY "auth all properties" ON public.properties FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth read raw_properties" ON public.raw_properties;
CREATE POLICY "auth read raw_properties" ON public.raw_properties FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth all relo_partners" ON public.relocation_partners;
CREATE POLICY "auth all relo_partners" ON public.relocation_partners FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "auth read scores" ON public.scores;
CREATE POLICY "auth read scores" ON public.scores FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS deny_all_client_access ON public.skip_trace_confirmations;
CREATE POLICY deny_all_client_access ON public.skip_trace_confirmations FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "auth all team_agents" ON public.team_agents;
CREATE POLICY "auth all team_agents" ON public.team_agents FOR ALL TO authenticated USING (true);

-- ═══════════════════════════════════════════════════════════════════════
-- Functions
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$;

CREATE OR REPLACE FUNCTION public.next_touch_number(p_lead_id uuid)
RETURNS integer LANGUAGE sql SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE(MAX(touch_number), 0) + 1
  FROM lead_touches
  WHERE lead_id = p_lead_id;
$function$;

CREATE OR REPLACE FUNCTION public.agent_workload_counts()
RETURNS TABLE(assigned_agent_id uuid, active_leads bigint)
LANGUAGE sql SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT assigned_agent_id, COUNT(*) AS active_leads
  FROM isa_leads
  WHERE outreach_status NOT IN ('dead', 'closed')
    AND assigned_agent_id IS NOT NULL
  GROUP BY assigned_agent_id;
$function$;

CREATE OR REPLACE FUNCTION public.pause_cadence_on_terminal_status()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  IF NEW.outreach_status IN ('appointment_set', 'dead', 'closed')
     AND (OLD.outreach_status IS DISTINCT FROM NEW.outreach_status) THEN
    NEW.cadence_paused := true;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_deal_commission()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_agent_self_pct NUMERIC;
  v_agent_override NUMERIC;
  v_relo_pct       NUMERIC;
BEGIN
  IF NEW.sale_price IS NOT NULL AND NEW.commission_rate_pct IS NOT NULL THEN
    NEW.gross_commission := ROUND(NEW.sale_price * NEW.commission_rate_pct / 100, 2);
  END IF;

  CASE NEW.commission_source
    WHEN 'self_sourced', 'inrange_generated' THEN
      NEW.your_split_pct := 85.00; NEW.agent_split_pct := 0; NEW.override_pct := 0;
    WHEN 'brokerage_provided' THEN
      NEW.your_split_pct := 50.00; NEW.agent_split_pct := 50.00; NEW.override_pct := 0;
    WHEN 'relocation_partner' THEN
      SELECT rp.your_pct INTO v_relo_pct
      FROM isa_leads il JOIN relocation_partners rp ON rp.id = il.relocation_partner_id
      WHERE il.id = NEW.isa_lead_id;
      NEW.your_split_pct := COALESCE(v_relo_pct, 35.00); NEW.agent_split_pct := 0; NEW.override_pct := 0;
    WHEN 'agent_sourced' THEN
      SELECT ta.self_sourced_pct, ta.override_pct INTO v_agent_self_pct, v_agent_override
      FROM team_agents ta WHERE ta.id = NEW.assigned_agent_id;
      NEW.agent_split_pct := COALESCE(v_agent_self_pct, 85.00);
      NEW.your_split_pct  := 100 - NEW.agent_split_pct;
      NEW.override_pct    := COALESCE(v_agent_override, 0);
    ELSE
      NEW.your_split_pct := 85.00; NEW.agent_split_pct := 0; NEW.override_pct := 0;
  END CASE;

  IF NEW.gross_commission IS NOT NULL THEN
    NEW.your_gross    := ROUND(NEW.gross_commission * COALESCE(NEW.your_split_pct, 85) / 100, 2);
    NEW.agent_gross   := ROUND(NEW.gross_commission * COALESCE(NEW.agent_split_pct, 0) / 100, 2);
    NEW.your_override := ROUND(COALESCE(NEW.agent_gross, 0) * COALESCE(NEW.override_pct, 0) / 100, 2);
    NEW.your_total    := COALESCE(NEW.your_gross, 0) + COALESCE(NEW.your_override, 0);
  END IF;
  RETURN NEW;
END;
$function$;

-- Auto-enables RLS on any new table created in `public`. Installed by the
-- live project's `security_hardening` migration. Requires elevated
-- privileges to create; safe/expected to fail in an unprivileged local
-- session (RLS on individual tables above is still enforced regardless).
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls') THEN
    CREATE EVENT TRIGGER ensure_rls ON ddl_command_end EXECUTE FUNCTION public.rls_auto_enable();
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ensure_rls event trigger not created: insufficient privilege (expected outside the Supabase migration role)';
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Triggers
-- ═══════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_deal_commission ON public.deals;
CREATE TRIGGER trg_deal_commission BEFORE INSERT OR UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.compute_deal_commission();

DROP TRIGGER IF EXISTS trg_pause_cadence ON public.isa_leads;
CREATE TRIGGER trg_pause_cadence BEFORE UPDATE ON public.isa_leads
  FOR EACH ROW EXECUTE FUNCTION public.pause_cadence_on_terminal_status();

DROP TRIGGER IF EXISTS trg_outreach_updated_at ON public.outreach;
CREATE TRIGGER trg_outreach_updated_at BEFORE UPDATE ON public.outreach
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_owners_updated_at ON public.owners;
CREATE TRIGGER trg_owners_updated_at BEFORE UPDATE ON public.owners
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS properties_updated_at ON public.properties;
CREATE TRIGGER properties_updated_at BEFORE UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- Views
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.isa_pipeline AS
SELECT
  l.id, l.segment, l.market, l.state, l.county, l.commission_source,
  l.full_name, l.entity_name, l.phone, l.email,
  l.rep_name, l.rep_phone, l.rep_email, l.linkedin_url,
  l.routing, l.outreach_status, l.bant_score, l.motivation_score,
  l.ai_summary, l.isa_talking_points, l.property_address,
  l.price_range_min, l.price_range_max, l.timeline_months, l.contract_value,
  l.team_name, l.sport, l.production_name, l.employer, l.origin_country,
  l.source_name, l.source_url,
  ta.full_name AS agent_name, ta.phone AS agent_phone,
  l.assigned_isa, l.created_at,
  COUNT(t.id)::integer AS touch_count,
  MAX(t.touched_at) AS last_touched_at,
  (SELECT lt.outcome FROM lead_touches lt WHERE lt.lead_id = l.id ORDER BY lt.touched_at DESC LIMIT 1) AS last_outcome
FROM isa_leads l
LEFT JOIN team_agents ta ON ta.id = l.assigned_agent_id
LEFT JOIN lead_touches t ON t.lead_id = l.id
GROUP BY l.id, ta.full_name, ta.phone;

CREATE OR REPLACE VIEW public.segment_roi AS
SELECT
  l.segment, l.market, l.commission_source,
  COUNT(DISTINCT l.id) AS leads_total,
  COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'appointment_set') AS appointments,
  COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'closed') AS closed,
  ROUND((COUNT(DISTINCT l.id) FILTER (WHERE l.outreach_status = 'appointment_set'))::numeric
        / NULLIF(COUNT(DISTINCT l.id), 0)::numeric * 100, 1) AS appt_rate_pct,
  SUM(d.your_total) AS total_revenue_to_you
FROM isa_leads l
LEFT JOIN deals d ON d.isa_lead_id = l.id AND d.status = 'closed'
GROUP BY l.segment, l.market, l.commission_source
ORDER BY SUM(d.your_total) DESC NULLS LAST;

CREATE OR REPLACE VIEW public.agent_commission_summary AS
SELECT
  ta.id AS agent_id, ta.full_name, ta.brokerage, ta.market,
  COUNT(d.id) AS deals_closed,
  SUM(d.sale_price) AS total_volume,
  SUM(d.gross_commission) AS total_gci,
  SUM(d.your_total) AS total_to_you,
  SUM(d.your_override) AS total_overrides,
  SUM(d.agent_gross) AS total_to_agent
FROM team_agents ta
LEFT JOIN deals d ON d.assigned_agent_id = ta.id
  AND d.status = 'closed'
  AND EXTRACT(year FROM d.close_date) = EXTRACT(year FROM CURRENT_DATE)
GROUP BY ta.id, ta.full_name, ta.brokerage, ta.market;
