import { createClient } from "npm:@supabase/supabase-js@2";
import { normalizeProperty, generatePropertyHash } from "../_shared/normalization.ts";
import { scoreProperty } from "../_shared/scoring.ts";
import { classifyOwnerKind } from "../_shared/owner-classification.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NYC311_MAP: Record<string, string[]> = {
  "HEAT/HOT WATER":       ["utility_shutoff", "code_violation"],
  "UNSANITARY CONDITION": ["code_violation"],
  "PAINT/PLASTER":        ["code_violation"],
  "WATER SYSTEM":         ["utility_shutoff"],
  "DOOR/WINDOW":          ["code_violation"],
  "ELEVATOR":             ["code_violation"],
  "PLUMBING":             ["code_violation"],
  "PEST CONTROL":         ["code_violation"],
  "MOLD":                 ["code_violation"],
  "LEAD":                 ["code_violation"],
  "STRUCTURAL":           ["condemned"],
  "BUILDING CONDITION":   ["code_violation"],
  "ILLEGAL CONVERSION":   ["code_violation"],
  "GENERAL CONSTRUCTION": ["code_violation"],
  "FLOORING/STAIRS":      ["code_violation"],
  "CEILING":              ["code_violation"],
  "ELECTRIC":             ["code_violation"],
};

const mapNYC311 = (raw: Record<string, unknown>): Record<string, unknown> => {
  const complaint = String(raw.complaint_type || "").toUpperCase();
  const preSet = Array.isArray(raw.distress_indicators)
    ? (raw.distress_indicators as string[])
    : [];
  const indicators: Set<string> = new Set(preSet.length ? preSet : ["code_violation"]);
  for (const [key, vals] of Object.entries(NYC311_MAP)) {
    if (complaint.includes(key)) vals.forEach((v) => indicators.add(v));
  }
  return {
    source:              String(raw.source || "nyc_311"),
    address:             raw.address || raw.incident_address || "",
    city:                raw.city || raw.borough || "NEW YORK",
    state:               "NY",
    zip:                 raw.zip || raw.incident_zip || "",
    property_type:       raw.property_type || raw.building_type || "unknown",
    distress_indicators: [...indicators],
    notice_date:         raw.created_date || raw.notice_date || null,
    process_stage:       String(raw.process_stage || "code violation"),
    estimated_arv:       raw.estimated_arv   || null,
    assessed_value:      raw.assessed_value  || null,
    amount_owed:         raw.amount_owed     || null,
    year_built:          raw.year_built      || null,
    square_footage:      raw.square_footage  || null,
    owner_name:          raw.owner_name      || "",
    owner_phone:         raw.owner_phone     || "",
    owner_email:         raw.owner_email     || "",
    owner_mailing_address: raw.owner_mailing_address || "",
    owner_type:          raw.owner_type      || "unknown",
    owner_state:         raw.owner_state     || "",
    case_number:         raw.case_number     || "",
  };
};

const NJ_CLASS_MAP: Record<string, string> = {
  "1": "land", "2": "single_family", "3A": "farm", "3B": "farm",
  "4A": "commercial", "4B": "industrial", "4C": "apartment",
  "15A": "single_family", "15B": "multifamily", "15C": "condo",
  "15D": "mobile_home",
};

const mapNJMODIV = (raw: Record<string, unknown>): Record<string, unknown> => {
  const indicators: string[] = [];
  if (Number(raw.delinquent_amount) > 0)   indicators.push("tax_delinquent");
  if (Number(raw.delinquent_amount) > 5000) indicators.push("tax_lien");
  if (raw.code_violations)                  indicators.push("code_violation");
  if (Number(raw.years_owned) >= 15)        indicators.push("burnt_out_landlord");
  if (raw.out_of_state_owner)               indicators.push("out_of_state_owner");
  if (!indicators.length)                   indicators.push("code_violation");

  const ownerState = raw.owner_state
    || (raw.owner_mailing_address ? extractStateFromAddress(String(raw.owner_mailing_address)) : "")
    || "";

  return {
    source:              "nj_mod_iv",
    address:             raw.address || raw.property_address || "",
    city:                raw.city || raw.municipality || "",
    state:               "NJ",
    zip:                 raw.zip || raw.postal_code || "",
    county:              raw.county || "",
    property_type:       njPropertyType(raw),
    distress_indicators: indicators,
    estimated_arv:       raw.estimated_arv  || null,
    assessed_value:      raw.assessed_value || null,
    taxes_owed:          raw.delinquent_amount || null,
    owner_name:          raw.owner_name    || "",
    owner_mailing_address: raw.owner_mailing_address || "",
    owner_type:          raw.owner_type    || "unknown",
    owner_state:         ownerState,
    year_built:          raw.year_built    || null,
    process_stage:       raw.process_stage || "",
  };
};

const extractStateFromAddress = (addr: string): string => {
  const m = addr.match(/,?\s+([A-Z]{2})\s+\d{5}(-\d{4})?$/);
  return m ? m[1] : "";
};

const njPropertyType = (raw: Record<string, unknown>): string => {
  const cls  = String(raw.property_class || "").trim();
  const type = String(raw.property_type  || "").trim();
  return NJ_CLASS_MAP[cls] || NJ_CLASS_MAP[type] || type || "unknown";
};

const SOURCE_MAPPERS: Record<string, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  nyc_311:       mapNYC311,
  nyc_hpd:       mapNYC311,
  nyc_evictions: mapNYC311,
  nj_mod_iv:     mapNJMODIV,
  nj_parcels:    mapNJMODIV,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let limit = 50;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.limit) limit = Math.min(Number(body.limit), 200);
  } catch { /* no body is fine */ }

  const { data: rawRecords, error: fetchError } = await supabase
    .from("raw_properties")
    .select("*")
    .is("processed_at", null)
    .order("received_at", { ascending: true })
    .limit(limit);

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (!rawRecords?.length) {
    return new Response(
      JSON.stringify({ processed: 0, message: "No unprocessed records" }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  const results = { processed: 0, upserted: 0, tier1: 0, tier2: 0, skipped: 0, errors: [] as string[] };
  const now = new Date().toISOString();

  for (const record of rawRecords) {
    try {
      const source = String(record.source || "unknown").toLowerCase();
      const rawData = (record.raw_data ?? {}) as Record<string, unknown>;

      const mapper = SOURCE_MAPPERS[source];
      const mapped = mapper ? mapper(rawData) : { ...rawData, source };

      if (!mapped.address && !rawData.address && !rawData.incident_address) {
        results.skipped++;
        await supabase.from("raw_properties").update({ processed_at: now }).eq("id", record.id);
        continue;
      }

      const normalized = normalizeProperty(mapped);
      const scores     = scoreProperty(normalized);
      const hash       = await generatePropertyHash(normalized);

      const enrichmentStatus =
        scores.priority_tier === "Tier 1" ? "pending" : "skipped";

      const { error: upsertError } = await supabase.from("properties").upsert(
        {
          property_hash:           hash,
          source:                  normalized.source,
          address:                 normalized.address,
          city:                    normalized.city,
          state:                   normalized.state,
          zip:                     normalized.zip,
          county:                  normalized.county,
          property_type:           normalized.property_type,
          bedrooms:                normalized.bedrooms,
          bathrooms:               normalized.bathrooms,
          square_footage:          normalized.square_footage,
          year_built:              normalized.year_built,
          estimated_arv:           normalized.estimated_arv,
          amount_owed:             normalized.amount_owed,
          asking_price:            normalized.asking_price,
          equity:                  normalized.equity,
          equity_percentage:       normalized.equity_percentage,
          below_market_percentage: normalized.below_market_percentage,
          assessed_value:          normalized.assessed_value,
          taxes_owed:              normalized.taxes_owed,
          owner_name:              normalized.owner_name,
          owner_phone:             normalized.owner_phone,
          owner_email:             normalized.owner_email,
          owner_mailing_address:   normalized.owner_mailing_address,
          owner_type:              normalized.owner_type,
          owner_state:             normalized.owner_state,
          distress_indicators:     normalized.distress_indicators,
          notice_date:             normalized.notice_date,
          auction_date:            normalized.auction_date,
          process_stage:           normalized.process_stage,
          case_number:             normalized.case_number,
          owner_kind:              classifyOwnerKind(normalized.owner_name as string | null),
          ...scores,
          enrichment_status: enrichmentStatus,
          data_sources: [String(normalized.source)],
        },
        { onConflict: "property_hash" }
      );

      if (upsertError) throw new Error(upsertError.message);

      await supabase.from("raw_properties").update({ processed_at: now }).eq("id", record.id);

      results.processed++;
      results.upserted++;
      if (scores.priority_tier === "Tier 1") results.tier1++;
      if (scores.priority_tier === "Tier 2") results.tier2++;
    } catch (e) {
      results.errors.push(`[${record.id}] ${String(e)}`);
      await supabase.from("raw_properties").update({ processed_at: now }).eq("id", record.id);
    }
  }

  return new Response(
    JSON.stringify({
      ...results,
      message: `Processed ${results.processed} records → ${results.tier1} Tier 1 queued for enrichment, ${results.tier2} Tier 2 (not queued)`,
    }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  );
});
