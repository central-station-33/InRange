-- Add 'landlord' as a valid isa_leads segment for the rental-landlord
-- outreach function (unrepresented rental units seeking leasing agents).
--
-- NOTE: this migration targets the LIVE production schema
-- (isa_leads/landlord_leads/rental_units/agent_routing_rules), which is
-- ahead of this repo's own 2024 migrations (properties/property_scores/
-- subscribers/notifications/ingestion_runs) and was applied directly via
-- the Supabase project omzugrtgwsjypekuzgtn, not built up from those
-- earlier migration files. It's included here so the repo stops drifting
-- further from what's actually running.

ALTER TABLE public.isa_leads DROP CONSTRAINT isa_leads_segment_check;
ALTER TABLE public.isa_leads ADD CONSTRAINT isa_leads_segment_check
  CHECK (segment = ANY (ARRAY[
    'athlete', 'expat_relocation', 'investor', 'film_tv', 'motivated_seller',
    'first_time_buyer', 'divorce', 'empty_nester', 'developer', 'homeowner',
    'renter', 'general_inquiry', 'landlord'
  ]));

-- Central Hub "unclaimed" queue: any isa_lead with no assigned agent yet.
-- Deliberately segment-agnostic (any future segment kept out of
-- agent_routing_rules lands here too), but joins in landlord_leads detail
-- since that's this feature's first consumer.
CREATE OR REPLACE VIEW public.unclaimed_leads AS
SELECT
  il.id,
  il.segment,
  il.market,
  il.full_name,
  il.entity_name,
  il.email,
  il.phone,
  il.property_address,
  il.motivation_signals,
  il.motivation_score,
  il.routing,
  il.outreach_status,
  il.source_name,
  il.source_url,
  il.created_at,
  ll.unit_count,
  ll.expected_rent,
  ll.vacancy_date,
  ll.leasing_need,
  ll.pipeline_stage AS landlord_pipeline_stage
FROM public.isa_leads il
LEFT JOIN public.landlord_leads ll ON ll.isa_lead_id = il.id
WHERE il.assigned_agent_id IS NULL
  AND il.outreach_status NOT IN ('dead', 'closed')
ORDER BY il.created_at DESC;

COMMENT ON VIEW public.unclaimed_leads IS
  'Central Hub claim queue: isa_leads with no assigned_agent_id yet. Populated for the landlord segment by not enrolling it in agent_routing_rules, so assign-leads (auto-router) skips it and leads wait for a manual claim via claim-lead.';
