import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Server-side only — never import this in client components.
export function getAdminClient() {
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}
