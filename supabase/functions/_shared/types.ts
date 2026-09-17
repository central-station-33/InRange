export type Market = 'nyc' | 'nj';

// Which lead-gen segment a property belongs to. 'distressed_seller' is the
// original segment (tax liens, foreclosures, etc); 'rental_landlord' targets
// landlords with unrepresented ("for rent by owner") rental units.
export type Segment = 'distressed_seller' | 'rental_landlord';

export type DistressType =
  | 'tax_lien'
  | 'foreclosure'
  | 'sheriff_sale'
  | 'probate'
  | 'code_violation'
  | 'vacant'
  | 'tax_delinquent'
  // Rental / landlord motivation signals
  | 'frbo_unrepresented'
  | 'long_dom_rental'
  | 'portfolio_landlord';

export type Tier = 1 | 2 | 3 | 4;

export type ClaimStatus = 'unclaimed' | 'claimed';

export interface DistressFlag {
  type: DistressType;
  detail: string;
  source: string;
  date?: string;
}

export interface Property {
  id?: string;
  source: Market;
  segment: Segment;
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
  claim_status?: ClaimStatus;
  claimed_by?: string | null;
  claimed_at?: string | null;
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

export interface EdgeFnResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
