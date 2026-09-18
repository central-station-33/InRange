-- Broker/agent role-based access, replacing the blanket
-- "FOR ALL TO authenticated USING (true)" policies on lead/deal/commission
-- data. Requested directly: two roles, broker (full access) and agent
-- (scoped to their own assigned leads/deals).
--
-- SAFE TO APPLY NOW: at the time of writing, every production write path
-- (all 34 edge functions) uses the service-role key, which bypasses RLS
-- entirely -- this migration cannot break the live pipeline. The only
-- thing that reads through the `authenticated` role today is manual
-- Supabase Studio access; nextjs-inrange has no auth flow yet. This is
-- infrastructure laid down ahead of that dashboard being built, not a
-- change to anything currently running.
--
-- SCOPE: this covers isa_leads, deals, lead_touches, team_agents,
-- agent_routing_rules, and relocation_partners -- the tables with a real
-- per-agent owner (assigned_agent_id) or genuinely sensitive
-- commission/compensation data. properties/owners/scores/outreach/
-- outcomes/contact_activities/notification_log/raw_properties/
-- inrange_leads are left on the existing broad authenticated policy:
-- these are shared property inventory and pipeline data with no
-- assigned-agent column, and siloing them per-agent would be a
-- larger product decision (most brokerages share inventory visibility
-- across all agents) -- not assumed here.
--
-- NOT touched: the new rental_inquiries/landlord_leads/rental_units/etc.
-- leasing-module tables that appeared during this session. That module
-- needs its own dedicated pass; bolting role policies onto schema I
-- haven't fully verified would be guessing.

-- ═══════════════════════════════════════════════════════════════════════
-- Role columns + helper functions
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.team_agents
  ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS role         TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'broker'));

COMMENT ON COLUMN public.team_agents.auth_user_id IS 'Links this agent record to a Supabase Auth login. NULL until someone signs up and is manually linked -- see README for the linking statement. No login can resolve current_team_agent_id()/is_broker() until this is set.';
COMMENT ON COLUMN public.team_agents.role IS 'agent: scoped to own assigned_agent_id rows. broker: unrestricted. Defaults to agent -- promote explicitly, never assume broker.';

-- SECURITY DEFINER + fixed search_path: these run as the function owner so
-- they can resolve a caller's role/agent id without recursing into
-- team_agents' own RLS (which would otherwise need the role to already be
-- known to evaluate itself).

CREATE OR REPLACE FUNCTION public.current_team_agent_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT id FROM team_agents WHERE auth_user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.is_broker()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT EXISTS (SELECT 1 FROM team_agents WHERE auth_user_id = auth.uid() AND role = 'broker');
$function$;

-- ═══════════════════════════════════════════════════════════════════════
-- isa_leads
-- ═══════════════════════════════════════════════════════════════════════
-- Note: a lead with assigned_agent_id IS NULL (unassigned/new) is only
-- visible to brokers under these policies, not to any agent -- that's
-- deliberate: an agent shouldn't see leads that haven't been routed to
-- them yet. Once assign-leads sets assigned_agent_id, it becomes visible
-- to that agent.

DROP POLICY IF EXISTS "auth all isa_leads" ON public.isa_leads;

DROP POLICY IF EXISTS "brokers manage all isa_leads" ON public.isa_leads;
CREATE POLICY "brokers manage all isa_leads" ON public.isa_leads
  FOR ALL TO authenticated USING (is_broker()) WITH CHECK (is_broker());

DROP POLICY IF EXISTS "agents manage own isa_leads" ON public.isa_leads;
CREATE POLICY "agents manage own isa_leads" ON public.isa_leads
  FOR ALL TO authenticated
  USING (assigned_agent_id = current_team_agent_id())
  WITH CHECK (assigned_agent_id = current_team_agent_id());

-- ═══════════════════════════════════════════════════════════════════════
-- deals
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "auth all deals" ON public.deals;

DROP POLICY IF EXISTS "brokers manage all deals" ON public.deals;
CREATE POLICY "brokers manage all deals" ON public.deals
  FOR ALL TO authenticated USING (is_broker()) WITH CHECK (is_broker());

DROP POLICY IF EXISTS "agents manage own deals" ON public.deals;
CREATE POLICY "agents manage own deals" ON public.deals
  FOR ALL TO authenticated
  USING (assigned_agent_id = current_team_agent_id())
  WITH CHECK (assigned_agent_id = current_team_agent_id());

-- ═══════════════════════════════════════════════════════════════════════
-- lead_touches (no assigned_agent_id of its own -- scope via its lead)
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "auth all lead_touches" ON public.lead_touches;

DROP POLICY IF EXISTS "brokers manage all lead_touches" ON public.lead_touches;
CREATE POLICY "brokers manage all lead_touches" ON public.lead_touches
  FOR ALL TO authenticated USING (is_broker()) WITH CHECK (is_broker());

DROP POLICY IF EXISTS "agents manage own lead_touches" ON public.lead_touches;
CREATE POLICY "agents manage own lead_touches" ON public.lead_touches
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM isa_leads il
    WHERE il.id = lead_touches.lead_id AND il.assigned_agent_id = current_team_agent_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM isa_leads il
    WHERE il.id = lead_touches.lead_id AND il.assigned_agent_id = current_team_agent_id()
  ));

-- ═══════════════════════════════════════════════════════════════════════
-- team_agents -- agents can see/edit their own row, not each other's
-- commission splits and YTD figures; brokers manage everyone.
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "auth all team_agents" ON public.team_agents;

DROP POLICY IF EXISTS "brokers manage all team_agents" ON public.team_agents;
CREATE POLICY "brokers manage all team_agents" ON public.team_agents
  FOR ALL TO authenticated USING (is_broker()) WITH CHECK (is_broker());

DROP POLICY IF EXISTS "agents view own team_agents row" ON public.team_agents;
CREATE POLICY "agents view own team_agents row" ON public.team_agents
  FOR SELECT TO authenticated USING (auth_user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════
-- agent_routing_rules -- operational config, broker-only
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "auth all routing" ON public.agent_routing_rules;
DROP POLICY IF EXISTS "brokers manage routing" ON public.agent_routing_rules;
CREATE POLICY "brokers manage routing" ON public.agent_routing_rules
  FOR ALL TO authenticated USING (is_broker()) WITH CHECK (is_broker());

-- ═══════════════════════════════════════════════════════════════════════
-- relocation_partners -- referral-fee terms are broker business terms;
-- agents can still see which partner a lead came from, so read-only.
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "auth all relo_partners" ON public.relocation_partners;

DROP POLICY IF EXISTS "brokers manage relo_partners" ON public.relocation_partners;
CREATE POLICY "brokers manage relo_partners" ON public.relocation_partners
  FOR ALL TO authenticated USING (is_broker()) WITH CHECK (is_broker());

DROP POLICY IF EXISTS "agents read relo_partners" ON public.relocation_partners;
CREATE POLICY "agents read relo_partners" ON public.relocation_partners
  FOR SELECT TO authenticated USING (true);
