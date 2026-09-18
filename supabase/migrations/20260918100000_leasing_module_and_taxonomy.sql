-- Leasing/rentals module + lead taxonomy, reverse-engineered from two live
-- migrations (leasing_module_and_taxonomy, leasing_views_security_invoker_fix)
-- that landed on production during this same session, after the
-- 2026-09-17 baseline snapshot -- confirmation that schema drift against
-- this repo is ongoing, not a one-time historical problem. Same
-- introspection method as the baseline: information_schema + pg_catalog,
-- not a replay of the two migrations' original SQL bodies.
--
-- Adds a full rental/leasing side of the business (landlord leads, rental
-- units, inquiries, matching, tours, applications) alongside the existing
-- sales/investor pipeline, plus a `module`/`lead_role` taxonomy on
-- isa_leads to distinguish which business line a lead belongs to.
--
-- All 8 new tables have zero rows as of this writing and RLS policies
-- still on the old blanket "FOR ALL TO authenticated USING (true)"
-- pattern -- NOT retrofitted with the broker/agent scoping added to the
-- sales-side tables in 20260918030000, since these tables' real ownership
-- model (who's "assigned" a landlord lead vs. a rental inquiry) hasn't
-- been verified. Do that as a deliberate follow-up, not a guess bundled
-- into a schema sync.

-- ═══════════════════════════════════════════════════════════════════════
-- isa_leads taxonomy + content_queue leasing content types
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.isa_leads
  ADD COLUMN IF NOT EXISTS module    TEXT CHECK (module IS NULL OR module = ANY (ARRAY['distressed_investor', 'residential_sale', 'rental_leasing'])),
  ADD COLUMN IF NOT EXISTS lead_role TEXT CHECK (lead_role IS NULL OR lead_role = ANY (ARRAY['buyer', 'seller', 'investor', 'renter', 'landlord', 'referral_partner']));

ALTER TABLE public.content_queue
  ADD COLUMN IF NOT EXISTS linked_rental_unit_id UUID REFERENCES public.rental_units(id);

ALTER TABLE public.content_queue DROP CONSTRAINT IF EXISTS content_queue_content_type_check;
ALTER TABLE public.content_queue ADD CONSTRAINT content_queue_content_type_check
  CHECK (content_type = ANY (ARRAY[
    'blog-post', 'linkedin', 'twitter', 'facebook', 'instagram',
    'rental_listing_video', 'reel', 'tiktok', 'youtube_short', 'carousel',
    'listing_email', 'listing_sms', 'neighborhood_guide',
    'landlord_vacancy_post', 'relocation_guide', 'google_business_post']));

ALTER TABLE public.content_queue DROP CONSTRAINT IF EXISTS content_queue_status_check;
ALTER TABLE public.content_queue ADD CONSTRAINT content_queue_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'needs_fact_review', 'needs_compliance_review', 'approved',
    'scheduled', 'published', 'rejected', 'expired', 'archived']));

-- ═══════════════════════════════════════════════════════════════════════
-- New tables (dependency order)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.landlord_leads (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  isa_lead_id               UUID        NOT NULL UNIQUE REFERENCES public.isa_leads(id) ON DELETE CASCADE,
  owner_id                  UUID        REFERENCES public.owners(owner_id),
  property_address          TEXT,
  city                      TEXT,
  county                    TEXT,
  state                     CHAR(2),
  zip                       TEXT,
  unit_count                SMALLINT,
  unit_details              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  expected_rent             NUMERIC,
  vacancy_date              DATE,
  current_status            TEXT,
  leasing_need              TEXT,
  preferred_contact_method  TEXT        CHECK (preferred_contact_method IS NULL OR preferred_contact_method = ANY (ARRAY['call', 'text', 'email'])),
  pipeline_stage            TEXT        NOT NULL DEFAULT 'new_lead' CHECK (pipeline_stage = ANY (ARRAY[
                                          'new_lead', 'consultation_scheduled', 'consultation_complete',
                                          'listing_agreement_sent', 'listing_agreement_signed', 'active_listing',
                                          'tenant_placed', 'recurring_relationship', 'lost'])),
  lost_reason               TEXT,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.rental_units (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_lead_id           UUID        REFERENCES public.landlord_leads(id),
  owner_id                   UUID        REFERENCES public.owners(owner_id),
  building_id                TEXT,
  address                    TEXT        NOT NULL,
  unit_number                TEXT,
  city                       TEXT,
  county                     TEXT,
  state                      CHAR(2)     NOT NULL DEFAULT 'NY',
  zip                        TEXT,
  neighborhood               TEXT,
  lat                        NUMERIC,
  lng                        NUMERIC,
  listing_status             TEXT        NOT NULL DEFAULT 'draft' CHECK (listing_status = ANY (ARRAY['draft', 'active', 'pending', 'rented', 'withdrawn', 'expired'])),
  available_date             DATE,
  monthly_rent               NUMERIC,
  estimated_move_in_costs    NUMERIC,
  fee_structure              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  bedrooms                   SMALLINT,
  bathrooms                  NUMERIC,
  square_footage             INTEGER,
  pet_policy                 TEXT,
  parking                    TEXT,
  laundry                    TEXT,
  amenities                  TEXT[]      NOT NULL DEFAULT '{}',
  furnished_status           TEXT        CHECK (furnished_status IS NULL OR furnished_status = ANY (ARRAY['furnished', 'unfurnished', 'either'])),
  lease_term_options         TEXT[]      NOT NULL DEFAULT '{}',
  description                TEXT,
  photos                     TEXT[]      NOT NULL DEFAULT '{}',
  video_url                  TEXT,
  floor_plan_url             TEXT,
  showing_instructions       TEXT,
  application_instructions   TEXT,
  listing_source              TEXT,
  last_verified_at            TIMESTAMPTZ,
  listing_expiration_date     DATE,
  assigned_agent_id           UUID        REFERENCES public.team_agents(id),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.rental_inquiries (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  isa_lead_id               UUID        NOT NULL UNIQUE REFERENCES public.isa_leads(id) ON DELETE CASCADE,
  move_date                 DATE,
  move_date_flexible        BOOLEAN     NOT NULL DEFAULT FALSE,
  target_locations          TEXT[]      NOT NULL DEFAULT '{}',
  max_rent                  NUMERIC,
  min_bedrooms               SMALLINT,
  preferred_bedrooms         SMALLINT,
  bathrooms_needed           NUMERIC,
  household_size             SMALLINT,
  pets                       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  parking_needed              BOOLEAN,
  laundry_needed               BOOLEAN,
  accessibility_notes          TEXT,
  unit_style                    TEXT        CHECK (unit_style IS NULL OR unit_style = ANY (ARRAY['furnished', 'unfurnished', 'short_term', 'long_term', 'corporate_housing', 'relocation'])),
  tour_availability              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  additional_notes                TEXT,
  pipeline_stage                   TEXT        NOT NULL DEFAULT 'new_inquiry' CHECK (pipeline_stage = ANY (ARRAY[
                                     'new_inquiry', 'contacted', 'awaiting_details', 'qualified', 'matching_inventory',
                                     'matches_sent', 'tour_requested', 'tour_booked', 'tour_completed',
                                     'application_started', 'application_submitted', 'approved', 'lease_signed',
                                     'nurture', 'lost', 'duplicate', 'invalid_spam'])),
  lost_reason                       TEXT,
  ai_conversation_summary            TEXT,
  ai_missing_info                     TEXT[]      NOT NULL DEFAULT '{}',
  ai_confidence                        SMALLINT    CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 1 AND 5),
  ai_escalation_needed                  BOOLEAN     NOT NULL DEFAULT FALSE,
  ai_escalation_reason                   TEXT,
  ai_model                                TEXT,
  ai_enriched_at                           TIMESTAMPTZ,
  created_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.rental_matches (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_inquiry_id   UUID        NOT NULL REFERENCES public.rental_inquiries(id) ON DELETE CASCADE,
  rental_unit_id      UUID        NOT NULL REFERENCES public.rental_units(id) ON DELETE CASCADE,
  fit_score           SMALLINT    CHECK (fit_score IS NULL OR fit_score BETWEEN 0 AND 100),
  match_reasons       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  match_conflicts     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  recommended_rank    SMALLINT,
  match_sent_at       TIMESTAMPTZ,
  renter_response     TEXT,
  tour_status         TEXT,
  final_result        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rental_inquiry_id, rental_unit_id)
);

CREATE TABLE IF NOT EXISTS public.tours (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_inquiry_id   UUID        NOT NULL REFERENCES public.rental_inquiries(id) ON DELETE CASCADE,
  rental_unit_id      UUID        NOT NULL REFERENCES public.rental_units(id) ON DELETE CASCADE,
  scheduled_at        TIMESTAMPTZ,
  status              TEXT        NOT NULL DEFAULT 'requested' CHECK (status = ANY (ARRAY['requested', 'booked', 'completed', 'no_show', 'cancelled'])),
  agent_id            UUID        REFERENCES public.team_agents(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.rental_applications (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_inquiry_id   UUID        NOT NULL REFERENCES public.rental_inquiries(id) ON DELETE CASCADE,
  rental_unit_id      UUID        NOT NULL REFERENCES public.rental_units(id) ON DELETE CASCADE,
  status              TEXT        NOT NULL DEFAULT 'started' CHECK (status = ANY (ARRAY['started', 'submitted', 'approved', 'denied', 'withdrawn'])),
  submitted_at        TIMESTAMPTZ,
  decided_at          TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.lead_source_events (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  isa_lead_id              UUID        REFERENCES public.isa_leads(id) ON DELETE CASCADE,
  source_channel           TEXT,
  source_platform          TEXT,
  campaign                 TEXT,
  ad_creative_id           TEXT,
  utm_source               TEXT,
  utm_medium               TEXT,
  utm_campaign             TEXT,
  utm_content              TEXT,
  landing_page             TEXT,
  referrer_url             TEXT,
  first_touch_at           TIMESTAMPTZ,
  latest_touch_at          TIMESTAMPTZ,
  rental_unit_id           UUID        REFERENCES public.rental_units(id),
  session_id               TEXT,
  phone_tracking_number    TEXT,
  qr_code_id               TEXT,
  relocation_partner_id    UUID        REFERENCES public.relocation_partners(id),
  cost_cents               INTEGER,
  conversion_outcome       TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.lead_tasks (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  isa_lead_id         UUID        NOT NULL REFERENCES public.isa_leads(id) ON DELETE CASCADE,
  task_type           TEXT        NOT NULL,
  due_at              TIMESTAMPTZ,
  assigned_agent_id   UUID        REFERENCES public.team_agents(id),
  status              TEXT        NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open', 'completed', 'cancelled'])),
  completed_at        TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_landlord_leads_pipeline_stage ON public.landlord_leads USING btree (pipeline_stage);

CREATE INDEX IF NOT EXISTS idx_lead_source_events_campaign ON public.lead_source_events USING btree (campaign);
CREATE INDEX IF NOT EXISTS idx_lead_source_events_lead ON public.lead_source_events USING btree (isa_lead_id);

CREATE INDEX IF NOT EXISTS idx_lead_tasks_due ON public.lead_tasks USING btree (due_at) WHERE (status = 'open');
CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead ON public.lead_tasks USING btree (isa_lead_id);

CREATE INDEX IF NOT EXISTS idx_rental_applications_inquiry ON public.rental_applications USING btree (rental_inquiry_id);

CREATE INDEX IF NOT EXISTS idx_rental_inquiries_pipeline_stage ON public.rental_inquiries USING btree (pipeline_stage);

CREATE INDEX IF NOT EXISTS idx_rental_matches_inquiry ON public.rental_matches USING btree (rental_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_rental_matches_unit ON public.rental_matches USING btree (rental_unit_id);

CREATE INDEX IF NOT EXISTS idx_rental_units_city ON public.rental_units USING btree (city);
CREATE INDEX IF NOT EXISTS idx_rental_units_landlord_lead ON public.rental_units USING btree (landlord_lead_id);
CREATE INDEX IF NOT EXISTS idx_rental_units_status ON public.rental_units USING btree (listing_status);

CREATE INDEX IF NOT EXISTS idx_tours_inquiry ON public.tours USING btree (rental_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_tours_scheduled ON public.tours USING btree (scheduled_at);

-- ═══════════════════════════════════════════════════════════════════════
-- RLS (left on the broad authenticated-only pattern -- see header note)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.landlord_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_source_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_tasks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_inquiries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_matches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_units        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tours               ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth all landlord_leads" ON public.landlord_leads;
CREATE POLICY "auth all landlord_leads" ON public.landlord_leads FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all lead_source_events" ON public.lead_source_events;
CREATE POLICY "auth all lead_source_events" ON public.lead_source_events FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all lead_tasks" ON public.lead_tasks;
CREATE POLICY "auth all lead_tasks" ON public.lead_tasks FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all rental_applications" ON public.rental_applications;
CREATE POLICY "auth all rental_applications" ON public.rental_applications FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all rental_inquiries" ON public.rental_inquiries;
CREATE POLICY "auth all rental_inquiries" ON public.rental_inquiries FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all rental_matches" ON public.rental_matches;
CREATE POLICY "auth all rental_matches" ON public.rental_matches FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all rental_units" ON public.rental_units;
CREATE POLICY "auth all rental_units" ON public.rental_units FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all tours" ON public.tours;
CREATE POLICY "auth all tours" ON public.tours FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════
-- Function + triggers
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.flag_content_on_unit_status_change()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.listing_status IS DISTINCT FROM OLD.listing_status
     AND NEW.listing_status IN ('rented', 'withdrawn', 'expired') THEN
    UPDATE content_queue
    SET status = 'needs_fact_review'
    WHERE linked_rental_unit_id = NEW.id
      AND status IN ('approved', 'scheduled', 'published');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_landlord_leads_updated_at ON public.landlord_leads;
CREATE TRIGGER trg_landlord_leads_updated_at BEFORE UPDATE ON public.landlord_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_rental_applications_updated_at ON public.rental_applications;
CREATE TRIGGER trg_rental_applications_updated_at BEFORE UPDATE ON public.rental_applications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_rental_inquiries_updated_at ON public.rental_inquiries;
CREATE TRIGGER trg_rental_inquiries_updated_at BEFORE UPDATE ON public.rental_inquiries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_rental_units_updated_at ON public.rental_units;
CREATE TRIGGER trg_rental_units_updated_at BEFORE UPDATE ON public.rental_units
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_flag_content_on_unit_status_change ON public.rental_units;
CREATE TRIGGER trg_flag_content_on_unit_status_change AFTER UPDATE ON public.rental_units
  FOR EACH ROW EXECUTE FUNCTION public.flag_content_on_unit_status_change();

DROP TRIGGER IF EXISTS trg_tours_updated_at ON public.tours;
CREATE TRIGGER trg_tours_updated_at BEFORE UPDATE ON public.tours
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- Views
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.rental_leasing_pipeline
  WITH (security_invoker = true) AS
SELECT
  il.id AS isa_lead_id, il.full_name, il.email, il.phone, il.market, il.routing,
  il.outreach_status, il.assigned_agent_id,
  ri.pipeline_stage, ri.move_date, ri.max_rent, ri.min_bedrooms,
  ri.ai_confidence, ri.ai_escalation_needed, ri.created_at
FROM isa_leads il
JOIN rental_inquiries ri ON ri.isa_lead_id = il.id
WHERE il.module = 'rental_leasing' AND il.lead_role = 'renter';

CREATE OR REPLACE VIEW public.landlord_leasing_pipeline
  WITH (security_invoker = true) AS
SELECT
  il.id AS isa_lead_id, il.full_name, il.email, il.phone, il.market, il.assigned_agent_id,
  ll.pipeline_stage, ll.property_address, ll.expected_rent, ll.vacancy_date, ll.created_at
FROM isa_leads il
JOIN landlord_leads ll ON ll.isa_lead_id = il.id
WHERE il.module = 'rental_leasing' AND il.lead_role = 'landlord';

CREATE OR REPLACE VIEW public.distressed_investor_pipeline
  WITH (security_invoker = true) AS
SELECT
  id AS isa_lead_id, full_name, email, phone, market, routing, outreach_status,
  bant_score, motivation_score, assigned_agent_id, created_at
FROM isa_leads
WHERE module = 'distressed_investor';

CREATE OR REPLACE VIEW public.residential_sale_pipeline
  WITH (security_invoker = true) AS
SELECT
  id AS isa_lead_id, full_name, email, phone, market, lead_role, routing,
  outreach_status, bant_score, motivation_score, assigned_agent_id, created_at
FROM isa_leads
WHERE module = 'residential_sale';

CREATE OR REPLACE VIEW public.leads_needing_module_triage
  WITH (security_invoker = true) AS
SELECT id, full_name, segment, market, created_at
FROM isa_leads
WHERE module IS NULL;

-- unclaimed_leads: live without security_invoker as of this writing --
-- replicated as-is, not "fixed", since I can't confirm that's not
-- deliberate (e.g. if it deliberately needs elevated read access across
-- RLS-restricted rows for an operational dashboard).
CREATE OR REPLACE VIEW public.unclaimed_leads AS
SELECT
  il.id, il.segment, il.market, il.full_name, il.entity_name, il.email, il.phone,
  il.property_address, il.motivation_signals, il.motivation_score, il.routing,
  il.outreach_status, il.source_name, il.source_url, il.created_at,
  ll.unit_count, ll.expected_rent, ll.vacancy_date, ll.leasing_need,
  ll.pipeline_stage AS landlord_pipeline_stage
FROM isa_leads il
LEFT JOIN landlord_leads ll ON ll.isa_lead_id = il.id
WHERE il.assigned_agent_id IS NULL AND il.outreach_status <> ALL (ARRAY['dead', 'closed'])
ORDER BY il.created_at DESC;

-- Retrofit security_invoker onto the pre-existing views from the baseline
-- snapshot -- live production applied this to all views in one pass
-- (leasing_views_security_invoker_fix), including ones unrelated to
-- leasing. Matching that here.
ALTER VIEW public.isa_pipeline SET (security_invoker = true);
ALTER VIEW public.agent_commission_summary SET (security_invoker = true);
ALTER VIEW public.segment_roi SET (security_invoker = true);
