import { createClient } from "npm:@supabase/supabase-js@2";

const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tenVncnRnd3NqeXBla3V6Z3RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1MTM4OTcsImV4cCI6MjA5MzA4OTg5N30.gnKmNOQc_39QDP9v7rvvvwgRRn18M1F8auimgVZfCc0";
const BASE = "https://omzugrtgwsjypekuzgtn.supabase.co/rest/v1/properties";

const probe = async (label: string, qs: string, out: Record<string, unknown>) => {
  const url = `${BASE}?${qs}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ANON}`, apikey: ANON, Prefer: "count=exact" } });
    const text = await res.json().catch(async () => await res.text());
    out[`${label}_status`] = res.status;
    out[`${label}_content_range`] = res.headers.get("content-range");
    out[`${label}_count`] = Array.isArray(text) ? text.length : null;
    out[`${label}_body_if_error`] = Array.isArray(text) ? undefined : text;
  } catch (e) {
    out[`${label}_exception`] = String(e);
  }
};

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const out: Record<string, unknown> = { ran_at: new Date().toISOString() };

  // Exact literal query Make sent (decoded)
  const exact = "select=id,address,city,state,zip,county,owner_name,owner_phone,owner_email,property_type,assessed_value,estimated_arv,equity_percentage&property_type=in.(single_family,multifamily,duplex,triplex,fourplex,apartment,condo)&owner_name=not.is.null&or=(estimated_arv.gte.500000,assessed_value.gte.500000)&order=assessed_value.desc.nullslast&limit=75";
  await probe("exact", exact, out);

  // Drop the owner_name filter
  await probe("no_owner_filter", "select=id,property_type&property_type=in.(single_family,multifamily,duplex,triplex,fourplex,apartment,condo)&or=(estimated_arv.gte.500000,assessed_value.gte.500000)&limit=5", out);

  // Drop the or() filter, just type + limit
  await probe("type_only", "select=id,property_type&property_type=in.(single_family,multifamily,duplex,triplex,fourplex,apartment,condo)&limit=5", out);

  // Just the or() filter alone
  await probe("or_only", "select=id,assessed_value,estimated_arv&or=(estimated_arv.gte.500000,assessed_value.gte.500000)&limit=5", out);

  await supabase.from("raw_properties").upsert({
    property_hash: "diagnostic_rest_filter",
    source: "diagnostic",
    raw_data: out,
    processed_at: new Date().toISOString(),
  }, { onConflict: "property_hash" });

  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
