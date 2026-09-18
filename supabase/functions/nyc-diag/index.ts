import { createClient } from "npm:@supabase/supabase-js@2";

const PLUTO        = "https://data.cityofnewyork.us/resource/64uk-42ks.json";
const ACRIS_LEGALS = "https://data.cityofnewyork.us/resource/8h5j-fqxa.json";
const ACRIS_MASTER = "https://data.cityofnewyork.us/resource/bnx9-e6tj.json";
const HPD          = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json";

const probe = async (label: string, url: string, out: Record<string, unknown>) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    out[`${label}_status`] = r.status;
    const text = await r.text();
    if (!r.ok) { out[`${label}_error`] = text.slice(0, 400); return null; }
    const json = JSON.parse(text);
    const first = Array.isArray(json) ? json[0] : json;
    out[`${label}_fields`] = first ? Object.keys(first) : [];
    out[`${label}_sample`] = first ?? null;
    out[`${label}_count`]  = Array.isArray(json) ? json.length : 1;
    return json;
  } catch (e) {
    out[`${label}_exception`] = String(e);
    return null;
  }
};

// BBL = boro(1) + block(5, zero-padded) + lot(4, zero-padded)
const toBBL = (boroid: string, block: string, lot: string): string =>
  `${boroid}${String(block).padStart(5, "0")}${String(lot).padStart(4, "0")}`;

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const out: Record<string, unknown> = { ran_at: new Date().toISOString() };

  // Unfiltered samples reveal true column names
  await probe("pluto",  `${PLUTO}?$limit=1`, out);
  await probe("legals", `${ACRIS_LEGALS}?$limit=1`, out);
  await probe("master", `${ACRIS_MASTER}?$limit=1`, out);

  // Walk the real join path using an actual open Class C violation
  try {
    const vp = new URLSearchParams({
      boro: "BROOKLYN", class: "C", violationstatus: "Open",
      "$limit": "3",
      "$select": "violationid,boroid,block,lot,housenumber,streetname,zip",
    });
    const vios = await (await fetch(`${HPD}?${vp}`, { signal: AbortSignal.timeout(20000) })).json() as Record<string, unknown>[];
    out.hpd_lots = vios;

    const bbls = vios.map((v) => toBBL(String(v.boroid), String(v.block), String(v.lot)));
    out.computed_bbls = bbls;

    if (bbls.length) {
      const list = bbls.map((b) => `'${b}'`).join(",");

      // Does PLUTO join on bbl?
      await probe("pluto_join", `${PLUTO}?${new URLSearchParams({ "$where": `bbl in (${list})`, "$limit": "5" })}`, out);

      // ACRIS legals stores borough/block/lot separately, not bbl
      const v0 = vios[0];
      await probe("legals_join", `${ACRIS_LEGALS}?${new URLSearchParams({
        "$where": `borough=${v0.boroid} AND block=${v0.block} AND lot=${v0.lot}`,
        "$limit": "5",
      })}`, out);
    }
  } catch (e) {
    out.join_exception = String(e);
  }

  await supabase.from("raw_properties").upsert({
    property_hash: "diagnostic_pluto_acris",
    source: "diagnostic",
    raw_data: out,
    processed_at: new Date().toISOString(),
  }, { onConflict: "property_hash" });

  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
