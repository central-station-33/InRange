-- InRange: Security hardening
--
-- Addresses findings from the Supabase security advisor:
--   1. RLS enabled with no policy on 6 tables (contact_activities, deals,
--      inrange_leads, notification_log, properties, raw_properties) --
--      completes the same "authenticated" access pattern already used by
--      every other table in this schema (isa_leads, team_agents, outreach,
--      etc. -- see pg_policies). service_role (Edge Functions) bypasses RLS
--      regardless; anon continues to get no access.
--   2. isa_pipeline / segment_roi views were SECURITY DEFINER, running with
--      the view owner's privileges instead of the querying user's. Both
--      views only read tables the "authenticated" role already has direct
--      policy access to, so SECURITY DEFINER wasn't adding real access --
--      switching to SECURITY INVOKER removes the unnecessary privilege
--      escalation flagged by the linter.
--   3. rls_auto_enable() is a DDL event-trigger function (SECURITY DEFINER
--      is required for it to alter tables it doesn't own) but had default
--      PUBLIC EXECUTE, making it directly callable via PostgREST RPC.
--      Revoking EXECUTE from anon/authenticated closes that off; the event
--      trigger itself still invokes it fine.
--   4. Six trigger/helper functions had a mutable search_path.
--   5. pg_trgm was installed in the public schema instead of `extensions`,
--      where Supabase's other extensions already live.

-- ─── 1. RLS policies -- mirrors the "authenticated: true" pattern already
--        used by isa_leads, team_agents, outreach, lead_touches, etc. ──────

CREATE POLICY "auth all properties" ON public.properties
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth read raw_properties" ON public.raw_properties
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth read inrange_leads" ON public.inrange_leads
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth all deals" ON public.deals
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth all contact_activities" ON public.contact_activities
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth read notification_log" ON public.notification_log
  FOR SELECT TO authenticated USING (true);

-- ─── 2. SECURITY DEFINER views → SECURITY INVOKER ──────────────────────────

ALTER VIEW public.isa_pipeline SET (security_invoker = true);
ALTER VIEW public.segment_roi SET (security_invoker = true);

-- ─── 3. Lock down the DDL event-trigger helper ─────────────────────────────

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

-- ─── 4. Pin search_path on trigger/helper functions ────────────────────────
-- (applied as two migrations live -- pause_cadence_on_terminal_status was
-- caught in a follow-up advisor pass -- folded into one file here so the
-- repo's migration history matches what actually ran)

ALTER FUNCTION public.update_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.next_touch_number(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.compute_deal_commission() SET search_path = public, pg_temp;
ALTER FUNCTION public.agent_workload_counts() SET search_path = public, pg_temp;
ALTER FUNCTION public.pause_cadence_on_terminal_status() SET search_path = public, pg_temp;

-- ─── 5. Move pg_trgm out of the public schema ──────────────────────────────
-- `extensions` already exists and holds the project's other extensions
-- (properties.id etc. default via extensions.uuid_generate_v4()); existing
-- indexes (e.g. prop_address_trgm_idx) keep working since Postgres tracks
-- extension objects by OID, not by schema-qualified name.

ALTER EXTENSION pg_trgm SET SCHEMA extensions;
