/**
 * Evidence packet: what a Gemini/Claude enrichment call is allowed to see.
 *
 * Per docs/ai-lead-enrichment-blueprint.md §9 (Security & Data Handling):
 * only property/score/public-record data, current lead_evidence rows, and
 * the prior Gemini output when Claude is reviewing it. NEVER lead_contacts
 * (phone, email, mailing address) or any other raw consumer contact data —
 * classification and review don't need it, so it's never fetched here in
 * the first place, not merely filtered out afterward.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface EvidencePacketFact {
  evidence_id: string;
  field_name: string;
  field_value: string;
  confidence: string;
  source_type: string;
  source_detail: string | null;
}

export interface EvidencePacket {
  lead_id: string;
  category: string;
  owner_type: string;
  address: string;
  city: string;
  state: string;
  zip: string | null;
  county: string | null;
  current_facts: EvidencePacketFact[];
}

/**
 * Builds the evidence packet for a lead from lead_evidence_current +
 * lead_records + properties. Throws if the lead doesn't exist.
 */
export async function buildEvidencePacket(
  supabase: SupabaseClient,
  leadId: string,
): Promise<EvidencePacket> {
  const { data: lead, error: leadErr } = await supabase
    .from('lead_records')
    .select('id, category, owner_type, property_id')
    .eq('id', leadId)
    .single();
  if (leadErr) throw leadErr;
  if (!lead) throw new Error(`lead_records: no row for id=${leadId}`);

  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('address, city, state, zip, county')
    .eq('id', lead.property_id)
    .single();
  if (propErr) throw propErr;

  const { data: facts, error: factsErr } = await supabase
    .from('lead_evidence_current')
    .select('id, field_name, field_value, confidence, source_type, source_detail')
    .eq('lead_id', leadId);
  if (factsErr) throw factsErr;

  return {
    lead_id: lead.id,
    category: lead.category,
    owner_type: lead.owner_type,
    address: property?.address ?? '',
    city: property?.city ?? '',
    state: property?.state ?? '',
    zip: property?.zip ?? null,
    county: property?.county ?? null,
    current_facts: (facts ?? []).map((f: Record<string, unknown>) => ({
      evidence_id: f.id as string,
      field_name: f.field_name as string,
      field_value: f.field_value as string,
      confidence: f.confidence as string,
      source_type: f.source_type as string,
      source_detail: (f.source_detail as string | null) ?? null,
    })),
  };
}

export function formatEvidencePacketForPrompt(packet: EvidencePacket): string {
  const facts = packet.current_facts
    .map(
      (f) =>
        `• [${f.evidence_id}] ${f.field_name} = "${f.field_value}" ` +
        `(confidence: ${f.confidence}, source: ${f.source_type}${f.source_detail ? ` — ${f.source_detail}` : ''})`,
    )
    .join('\n');

  return `=== Lead ${packet.lead_id} ===
Category:   ${packet.category}
Owner type: ${packet.owner_type}
Address:    ${packet.address}, ${packet.city}, ${packet.state}${packet.zip ? ` ${packet.zip}` : ''}${packet.county ? ` (${packet.county} County)` : ''}

=== Current Evidence ===
${facts || 'No structured evidence recorded yet.'}`;
}
