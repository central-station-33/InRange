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

export interface EdgeFnResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
