/**
 * ingest-nj — Triggered by Make.com on a schedule.
 * Fetches distressed property data from NJ open-data APIs and upserts into Supabase.
 *
 * Data sources:
 *   - NJGIN / NJOGIS ArcGIS Feature Service — MOD-IV tax assessment data
 *   - NJ Tax Court ArcGIS layer            — properties with active appeals / delinquency
 *
 * Note on sheriff sales: NJ sheriff sale data is county-fragmented with no
 * centralised API. See docs/data-sources.md for manual scraping guidance.
 * When a Make.com HTTP module delivers sheriff-sale rows via webhook, this
 * function also accepts an optional `sheriff_sales` array in the POST body.
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import type { DistressFlag, Property } from '../_shared/types.ts';

// NJOGIS ArcGIS REST — MOD-IV parcel layer (statewide, public)
const NJGIN_BASE =
  'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/MOD4_Assessment_Statewide/FeatureServer/0/query';

interface ArcGISFeature {
  attributes: Record<string, string | number | null>;
}

// ─── Fetch: MOD-IV via NJOGIS ─────────────────────────────────────────────────

async function fetchModIV(
  county: string,
  offset = 0,
  limit = 1000,
): Promise<Property[]> {
  const where  = encodeURIComponent(`COUNTY_NAME='${county.toUpperCase()}'`);
  const url    = `${NJGIN_BASE}?where=${where}&outFields=*&resultOffset=${offset}&resultRecordCount=${limit}&f=json`;
  const res    = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`NJOGIS fetch (${county}) ${res.status}`);

  const json: { features: ArcGISFeature[] } = await res.json();
  if (!json.features) return [];

  return json.features.map((f) => {
    const a = f.attributes;

    // MOD-IV fields: PAMS_PIN, ADDL_LOTS, PROPERTY_LOCATION, OWNER, MUN_NAME, etc.
    const pin         = String(a.PAMS_PIN ?? a.PIN ?? a.BLOCK_LOT ?? '');
    const taxDelinq   = Number(a.DELINQUENT_TAXES ?? 0) > 0;
    const taxYrs      = Number(a.YEARS_DELINQUENT ?? 0);

    const flags: DistressFlag[] = [];

    if (taxDelinq) {
      flags.push({
        type:   'tax_delinquent',
        detail: `Delinquent ${taxYrs} year(s), amount: $${a.DELINQUENT_TAXES ?? 'unknown'}`,
        source: 'NJ MOD-IV (NJOGIS)',
      });
    }

    return {
      source:         'nj',
      parcel_id:      pin,
      address:        String(a.PROPERTY_LOCATION ?? a.STREET_ADDRESS ?? 'Unknown'),
      city:           String(a.MUN_NAME ?? a.CITY ?? 'Unknown'),
      state:          'NJ',
      zip:            a.ZIP_CODE ? String(a.ZIP_CODE) : null,
      county:         county,
      owner_name:     a.OWNER ? String(a.OWNER) : null,
      property_type:  a.PROPERTY_CLASS ? String(a.PROPERTY_CLASS) : null,
      assessed_value: a.TOTAL_ASSESS ? Number(a.TOTAL_ASSESS) : null,
      market_value:   a.SALES_PRICE  ? Number(a.SALES_PRICE)  : null,
      distress_flags: flags,
      raw_data:       a as Record<string, unknown>,
    };
  });
}

// Target NJ counties
const TARGET_COUNTIES = [
  'BERGEN', 'HUDSON', 'ESSEX', 'MORRIS', 'SUSSEX',
];

// ─── Parse: Sheriff sales pushed from Make.com ────────────────────────────────

interface SheriffSaleRow {
  county: string;
  parcel_id: string;
  address: string;
  city: string;
  zip?: string;
  owner_name?: string;
  sale_date?: string;
  case_number?: string;
}

function sheriffSaleToProperty(row: SheriffSaleRow): Property {
  return {
    source:         'nj',
    parcel_id:      row.parcel_id,
    address:        row.address,
    city:           row.city,
    state:          'NJ',
    zip:            row.zip ?? null,
    county:         row.county,
    owner_name:     row.owner_name ?? null,
    property_type:  null,
    assessed_value: null,
    market_value:   null,
    distress_flags: [
      {
        type:   'sheriff_sale',
        detail: `Sale date: ${row.sale_date ?? 'unknown'}, case: ${row.case_number ?? 'unknown'}`,
        source: 'NJ Sheriff Sale',
        date:   row.sale_date,
      },
    ],
    raw_data: row as unknown as Record<string, unknown>,
  };
}

// ─── Upsert helper ────────────────────────────────────────────────────────────

function toDbRow(p: Property) {
  return {
    source:         p.source,
    parcel_id:      p.parcel_id,
    address:        p.address,
    city:           p.city,
    state:          p.state,
    zip:            p.zip,
    county:         p.county,
    owner_name:     p.owner_name,
    property_type:  p.property_type,
    assessed_value: p.assessed_value,
    market_value:   p.market_value,
    distress_flags: p.distress_flags,
    raw_data:       p.raw_data,
    updated_at:     new Date().toISOString(),
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  // Optional: Make.com can POST sheriff_sale rows it scraped from county sites
  let body: { sheriff_sales?: SheriffSaleRow[]; counties?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — we'll fetch NJOGIS directly
  }

  const supabase = getServiceClient();
  const runId    = crypto.randomUUID();
  await supabase.from('ingestion_runs').insert({ id: runId, source: 'nj', status: 'running' });

  try {
    const properties: Property[] = [];

    // 1) Fetch MOD-IV for each target county (sequential to avoid rate-limiting)
    const counties = body.counties ?? TARGET_COUNTIES;
    for (const county of counties) {
      try {
        const batch = await fetchModIV(county);
        // Only keep properties with at least one distress flag from NJOGIS
        const distressed = batch.filter((p) => p.distress_flags.length > 0);
        properties.push(...distressed);
      } catch (e) {
        console.warn(`NJOGIS ${county} failed:`, (e as Error).message);
      }
    }

    // 2) Merge sheriff sale rows pushed by Make.com
    if (Array.isArray(body.sheriff_sales)) {
      for (const row of body.sheriff_sales) {
        properties.push(sheriffSaleToProperty(row));
      }
    }

    // 3) Batch upsert
    let upserted = 0;
    const BATCH = 100;
    for (let i = 0; i < properties.length; i += BATCH) {
      const batch = properties.slice(i, i + BATCH).map(toDbRow);
      const { error } = await supabase
        .from('properties')
        .upsert(batch, { onConflict: 'source,parcel_id' });
      if (error) throw error;
      upserted += batch.length;
    }

    await supabase.from('ingestion_runs').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      records_fetched: properties.length,
      records_upserted: upserted,
    }).eq('id', runId);

    return jsonResponse({ success: true, records_fetched: properties.length, records_upserted: upserted });
  } catch (err) {
    const msg = (err as Error).message;
    await supabase.from('ingestion_runs').update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: msg,
    }).eq('id', runId);
    return jsonResponse({ success: false, error: msg }, 500);
  }
});
