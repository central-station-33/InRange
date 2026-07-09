import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase';

const ALLOWED = new Set(['outreach_status', 'routing', 'assigned_isa', 'bant_score', 'motivation_score']);

export async function POST(req: NextRequest) {
  const { lead_id, ...rest } = await req.json();

  if (!lead_id) return NextResponse.json({ error: 'lead_id required' }, { status: 400 });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(rest)) {
    if (ALLOWED.has(k)) updates[k] = v;
  }

  const supabase = getAdminClient();
  const { error } = await supabase.from('isa_leads').update(updates).eq('id', lead_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
