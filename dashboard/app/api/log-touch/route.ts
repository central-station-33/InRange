import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase';

const STATUS_ADVANCE: Record<string, string> = {
  appointment_set:    'appointment_set',
  interested:         'contacted',
  callback_requested: 'contacted',
  not_interested:     'contacted',
  no_answer:          'attempting',
  voicemail:          'attempting',
  wrong_number:       'attempting',
};

export async function POST(req: NextRequest) {
  const { lead_id, channel, outcome, notes, isa_name } = await req.json();

  if (!lead_id || !channel) {
    return NextResponse.json({ error: 'lead_id and channel required' }, { status: 400 });
  }

  const supabase = getAdminClient();

  const { data: touchNum, error: rpcErr } = await supabase
    .rpc('next_touch_number', { p_lead_id: lead_id });

  if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });

  const { error: touchErr } = await supabase.from('lead_touches').insert({
    lead_id,
    channel,
    outcome,
    notes,
    isa_name,
    touch_number: touchNum as number,
    touched_at:   new Date().toISOString(),
  });

  if (touchErr) return NextResponse.json({ error: touchErr.message }, { status: 500 });

  const newStatus = outcome ? STATUS_ADVANCE[outcome] : null;
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (newStatus) updates.outreach_status = newStatus;
  if (outcome === 'appointment_set') updates.routing = 'hot';

  await supabase.from('isa_leads').update(updates).eq('id', lead_id);

  return NextResponse.json({ success: true, touch_number: touchNum });
}
