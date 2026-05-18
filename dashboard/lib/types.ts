export type Routing = 'hot' | 'warm' | 'nurture' | 'cold' | 'new';
export type OutreachStatus = 'new' | 'attempting' | 'contacted' | 'appointment_set' | 'dead' | 'closed';

export interface PipelineLead {
  id: string;
  segment: string;
  market: string;
  state?: string;
  county?: string;
  commission_source: string;
  full_name?: string;
  entity_name?: string;
  phone?: string;
  email?: string;
  rep_name?: string;
  rep_phone?: string;
  rep_email?: string;
  linkedin_url?: string;
  routing: Routing;
  outreach_status: OutreachStatus;
  bant_score?: number;
  motivation_score?: number;
  ai_summary?: string;
  isa_talking_points?: string[];
  property_address?: string;
  price_range_min?: number;
  price_range_max?: number;
  timeline_months?: number;
  contract_value?: number;
  team_name?: string;
  sport?: string;
  production_name?: string;
  employer?: string;
  origin_country?: string;
  source_name?: string;
  source_url?: string;
  agent_name?: string;
  agent_phone?: string;
  assigned_isa?: string;
  created_at: string;
  touch_count: number;
  last_touched_at?: string;
  last_outcome?: string;
}

export interface FullLead extends PipelineLead {
  inbound_channel?: string;
  inbound_message?: string;
  first_response_at?: string;
  motivation_signals?: string[];
  raw_data?: Record<string, unknown>;
  cadence_step?: number;
  last_cadence_at?: string;
  cadence_paused?: boolean;
}

export interface Touch {
  id: string;
  lead_id: string;
  touch_number: number;
  channel: string;
  outcome?: string;
  notes?: string;
  isa_name?: string;
  touched_at: string;
}

export interface SegmentROI {
  segment: string;
  market: string;
  commission_source: string;
  leads_total: number;
  appointments: number;
  closed: number;
  appt_rate_pct: number;
  total_revenue_to_you?: number;
}
