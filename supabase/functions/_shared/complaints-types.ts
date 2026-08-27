export type ComplaintCategory =
  | 'investment_dispute'
  | 'fund_disbursement'
  | 'unauthorized_fraud'
  | 'misrepresentation'
  | 'technical'
  | 'other';

export type ComplaintStatus =
  | 'open'
  | 'under_review'
  | 'escalated'
  | 'resolved'
  | 'reported_finra';

export type IntakeChannel = 'web_form' | 'email' | 'social_dm' | 'phone' | 'other';

export type ArchivedTier = 'active' | 'cold_storage';

// Keywords that auto-flag a complaint for the FINRA Rule 4530 30-day
// theft/misappropriation/forgery reporting clock, regardless of category.
export const THEFT_KEYWORDS = ['theft', 'stolen', 'steal', 'misappropriat', 'forg'];

export interface ComplaintIntake {
  complainant_name: string;
  complainant_address: string;
  account_number: string;
  email: string;
  phone?: string | null;
  date_of_incident?: string | null;
  category: ComplaintCategory;
  associated_person?: string | null;
  description: string;
  supporting_doc_url?: string | null;
  preferred_resolution?: string | null;
  consent_acknowledged: boolean;
  intake_channel?: IntakeChannel;
  entered_by?: string | null;
  is_written?: boolean;
}

export interface Complaint extends ComplaintIntake {
  id: string;
  reference_number: string;
  date_received: string;
  status: ComplaintStatus;
  involves_theft_misappropriation_forgery: boolean;
  escrow_agent_responsible: boolean;
  resolution_summary: string | null;
  resolved_at: string | null;
  finra_report_due_date: string | null;
  finra_reported_at: string | null;
  quarter_reported: string | null;
  archived_tier: ArchivedTier;
  created_at: string;
  updated_at: string;
}

export const REQUIRED_INTAKE_FIELDS: Array<keyof ComplaintIntake> = [
  'complainant_name',
  'complainant_address',
  'account_number',
  'email',
  'category',
  'description',
];

export function detectsTheftKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return THEFT_KEYWORDS.some((kw) => lower.includes(kw));
}
