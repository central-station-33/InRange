export type Role = "pa" | "producer" | "admin";
export type RoleType = "set_pa" | "office_pa" | "coordinator" | "other";
export type LocationState = "NY" | "NJ";
export type RateUnit = "hour" | "day";
export type GigStatus = "open" | "filled" | "cancelled";
export type DispatchStatus = "invited" | "accepted" | "declined" | "expired" | "confirmed";
export type TaxResidencyStatus = "unsubmitted" | "pending" | "verified" | "rejected";
export type PayrollClass = "w2" | "1099";

export type Profile = {
  id: string;
  role: Role;
  full_name: string;
  phone: string | null;
  created_at: string;
  updated_at: string;
};

export type PaProfile = {
  profile_id: string;
  home_state: LocationState | null;
  role_types: RoleType[];
  bio: string | null;
  years_experience: number;
  tax_residency_doc_path: string | null;
  tax_residency_status: TaxResidencyStatus;
  payroll_class: PayrollClass | null;
  course_completed_at: string | null;
  course_score: number | null;
  admin_notes: string | null;
  set_ready: boolean;
  created_at: string;
  updated_at: string;
};

export type Production = {
  id: string;
  producer_id: string;
  name: string;
  company: string | null;
  created_at: string;
};

export type Gig = {
  id: string;
  producer_id: string;
  production_id: string | null;
  title: string;
  role_type: RoleType;
  location_state: LocationState;
  location_detail: string | null;
  call_time: string;
  rate_amount: number | null;
  rate_unit: RateUnit | null;
  headcount: number;
  description: string | null;
  status: GigStatus;
  created_at: string;
};

export type Dispatch = {
  id: string;
  gig_id: string;
  pa_id: string;
  status: DispatchStatus;
  responded_at: string | null;
  created_at: string;
};

export type Notification = {
  id: string;
  recipient_id: string;
  gig_id: string | null;
  message: string;
  read_at: string | null;
  created_at: string;
};

type TableOf<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: TableOf<Profile>;
      pa_profiles: TableOf<PaProfile>;
      productions: TableOf<Production>;
      gigs: TableOf<Gig>;
      dispatches: TableOf<Dispatch>;
      notifications: TableOf<Notification>;
    };
    Views: Record<string, never>;
    Functions: {
      dispatch_gig_to_matches: {
        Args: { p_gig_id: string };
        Returns: number;
      };
      accept_dispatch: {
        Args: { p_dispatch_id: string };
        Returns: undefined;
      };
      decline_dispatch: {
        Args: { p_dispatch_id: string };
        Returns: undefined;
      };
    };
  };
};
