export type Market = 'nyc' | 'nj';

export type DistressType =
  | 'tax_lien'
  | 'foreclosure'
  | 'sheriff_sale'
  | 'probate'
  | 'code_violation'
  | 'vacant'
  | 'tax_delinquent';

export type Tier = 1 | 2 | 3 | 4;

export type LeadSegment =
  | 'athlete'
  | 'expat_relocation'
  | 'investor'
  | 'film_tv'
  | 'motivated_seller'
  | 'first_time_buyer'
  | 'divorce'
  | 'empty_nester'
  | 'developer';

export type LeadRouting = 'hot' | 'warm' | 'nurture' | 'cold' | 'new';

export type OutreachStatus =
  | 'new'
  | 'attempting'
  | 'contacted'
  | 'qualified'
  | 'appointment_set'
  | 'under_contract'
  | 'closed'
  | 'dead';

export type TouchChannel = 'call' | 'sms' | 'email' | 'dm' | 'voicemail';

export type TouchOutcome =
  | 'no_answer'
  | 'voicemail'
  | 'callback_requested'
  | 'not_interested'
  | 'interested'
  | 'appointment_set';

// ─── Property types (existing) ───────────────────────────────────────────────

export interface DistressFlag {
  type: DistressType;
  detail: string;
  source: string;
  date?: string;
}

export interface Property {
  id?: string;
  source: Market;
  parcel_id: string;
  address: string;
  city: string;
  state: string;
  zip: string | null;
  county: string | null;
  owner_name: string | null;
  property_type: string | null;
  assessed_value: number | null;
  market_value: number | null;
  distress_flags: DistressFlag[];
  raw_data: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ScoreComponent {
  name: string;
  points: number;
  reason: string;
}

export interface PropertyScore {
  property_id: string;
  composite_score: number;
  tier: Tier;
  score_components: ScoreComponent[];
  ai_summary: string | null;
}

export interface Subscriber {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  webhook_url: string | null;
  target_markets: Market[];
  min_tier: number;
  active: boolean;
}

export interface IngestionResult {
  source: Market;
  records_fetched: number;
  records_upserted: number;
  errors: string[];
}

// ─── Lead types (ISA layer) ──────────────────────────────────────────────────

export interface Lead {
  id?: string;
  segment: LeadSegment;
  market: Market;

  // Identity
  full_name?: string;
  entity_name?: string;

  // Direct contact
  email?: string;
  phone?: string;
  linkedin_url?: string;
  instagram_handle?: string;

  // Representative
  rep_name?: string;
  rep_email?: string;
  rep_phone?: string;
  rep_agency?: string;

  // Qualification
  bant_score?: number;
  motivation_score?: number;
  routing: LeadRouting;

  // Workflow
  assigned_isa?: string;
  outreach_status: OutreachStatus;

  // Context
  property_address?: string;
  motivation_signals: string[];
  ai_summary?: string;
  isa_talking_points: string[];
  source_url?: string;
  source_name?: string;

  // Segment-specific
  contract_value?: number;
  team_name?: string;
  sport?: string;
  origin_country?: string;
  employer?: string;
  production_name?: string;
  permit_number?: string;

  raw_data: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface LeadTouch {
  id?: string;
  lead_id: string;
  touch_number: number;
  channel: TouchChannel;
  outcome?: TouchOutcome;
  notes?: string;
  isa_name?: string;
  touched_at?: string;
}

export interface LeadIngestionResult {
  segment: LeadSegment;
  market: Market;
  records_fetched: number;
  records_upserted: number;
  errors: string[];
}

export interface EdgeFnResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
