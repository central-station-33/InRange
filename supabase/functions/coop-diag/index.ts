import { createClient } from "npm:@supabase/supabase-js@2";

const PLUTO = "https://data.cityofnewyork.us/resource/64uk-42ks.json";

const fetchOne = async (label: string, params: URLSearchParams, out: Record<string, unknown>) => {
  try {
    const r = await fetch(`${PLUTO}?${params}`, { signal: AbortSignal.timeout(20000) });
    const json = await r.json();
    out[`${label}_status`] = r.status;
    out[`${label}_count`] = Array.isArray(json) ? json.length : 0;
    const rec = Array.isArray(json) ? json[0] : null;
    out[`${label}_summary`] = rec ? {
      address: rec.address, ownername: rec.ownername,
      bldgclass: rec.bldgclass, unitsres: rec.unitsres,
      numfloors: rec.numfloors, yearbuilt: rec.yearbuilt,
    } : null;
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

  // The Dakota -- known co-op, using full-text search since PLUTO's address
  // field format is inconsistent with common abbreviations
  await fetchOne("dakota", new URLSearchParams({
    "$where": "upper(address) like '%1 WEST 72%'",
    "$limit": "3",
  }), out);

  // The Dakota's actual BBL is well documented: 1, block 1119, lot 1
  await fetchOne("dakota_bbl", new URLSearchParams({ bbl: "1011190001" }), out);

  // San Remo -- another famous pre-war co-op, for a third data point
  await fetchOne("sanremo", new URLSearchParams({
    "$where": "upper(address) like '%145 CENTRAL PARK WEST%'",
    "$limit": "3",
  }), out);

  // Known RENTAL (non-coop) large complex for contrast
  await fetchOne("rental", new URLSearchParams({
    "$where": "upper(ownername) like '%MARINA TOWERS%'",
    "$limit": "3",
  }), out);

  // Distribution of bldgclass among all D-prefix (elevator apartment) records
  // with 5+ units, to see the actual code range in use
  try {
    const r = await fetch(`${PLUTO}?${new URLSearchParams({
      "$where": "bldgclass like 'D%' and unitsres > 5",
      "$select": "bldgclass, count(*) as n",
      "$group": "bldgclass",
      "$order": "n DESC",
      "$limit": "20",
    })}`, { signal: AbortSignal.timeout(20000) });
    out.d_class_distribution_status = r.status;
    out.d_class_distribution = await r.json();
  } catch (e) {
    out.d_class_distribution_exception = String(e);
  }

  await supabase.from("raw_properties").upsert({
    property_hash: "diagnostic_coop_fields",
    source: "diagnostic",
    raw_data: out,
    processed_at: new Date().toISOString(),
  }, { onConflict: "property_hash" });

  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
