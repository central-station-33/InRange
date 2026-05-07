/**
 * ingest-nyc — Triggered by Make.com on a schedule.
 * Fetches distressed property data from NYC Open Data and upserts into Supabase.
 *
 * Data sources:
 *   - NYC DOF Tax Lien Sale List  (Socrata: 9rz4-mjeg)
 *   - NYC HPD Building Complaints (Socrata: uwyv-629c)
 *   - NYC ACRIS Lis Pendens       (Socrata: 2p6d-qhgr) — foreclosures
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import type { DistressFlag, Property } from '../_shared/types.ts';

const APP_TOKEN = Deno.env.get('NYC_OPEN_DATA_APP_TOKEN') ?? '';
const BASE_URL  = 'https://data.cityofnewyork.us/resource';

function socrataHeaders(): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (APP_TOKEN) h['X-App-Token'] = APP_TOKEN;
  return h;
}

// ─── Borough helpers ─────────────────────────────────────────────────────────

const BOROUGH_COUNTY: Record<string, string> = {
  '1': 'New York',   MN: 'New York',
  '2': 'Bronx',      BX: 'Bronx',
  '3': 'Kings',      BK: 'Kings',
  '4': 'Queens',     QN: 'Queens',
  '5': 'Richmond',   SI: 'Richmond',
};

function toCounty(b: string): string {
  return BOROUGH_COUNTY[b?.toUpperCase()] ?? b ?? '';
}

function bbl(borough: string, block: string, lot: string): string {
  return `${(borough ?? '').padStart(1, '0')}${(block ?? '').padStart(5, '0')}${(lot ?? '').padStart(4, '0')}`;
}

// ─── Fetch: Tax Lien Sale ─────────────────────────────────────────────────────

async function fetchTaxLiens(offset = 0, limit = 1000): Promise<Property[]> {
  const url = `${BASE_URL}/9rz4-mjeg.json?$limit=${limit}&$offset=${offset}&$order=:id`;
  const res  = await fetch(url, { headers: socrataHeaders() });
  if (!res.ok) throw new Error(`Tax lien fetch ${res.status}: ${await res.text()}`);

  const rows: Record<string, string>[] = await res.json();
  return rows.map((r) => ({
    source:         'nyc',
    parcel_id:      bbl(r.borough, r.block, r.lot),
    address:        [r.house_number, r.street_name].filter(Boolean).join(' ').trim() || 'Unknown',
    city:           'New York',
    state:          'NY',
    zip:            r.zip_code ?? null,
    county:         toCounty(r.borough),
    owner_name:     r.owner_name ?? null,
    property_type:  r.class_description ?? null,
    assessed_value: r.assessed_value   ? Number(r.assessed_value)   : null,
    market_value:   r.market_value     ? Number(r.market_value)     : null,
    distress_flags: [
      {
        type:   'tax_lien',
        detail: `Lien amount: $${r.lien_amount ?? 'unknown'} — sold ${r.sold_date ?? 'unknown'}`,
        source: 'NYC DOF Tax Lien Sale',
        date:   r.sold_date,
      } satisfies DistressFlag,
    ],
    raw_data: r as unknown as Record<string, unknown>,
  }));
}

// ─── Fetch: HPD Building Complaints ──────────────────────────────────────────

async function fetchHPDComplaints(): Promise<Map<string, DistressFlag[]>> {
  // Only fetch open complaints — those indicate ongoing issues
  const url = `${BASE_URL}/uwyv-629c.json?$limit=5000&$where=status=%27Open%27&$order=:id`;
  const res  = await fetch(url, { headers: socrataHeaders() });
  if (!res.ok) throw new Error(`HPD complaints fetch ${res.status}: ${await res.text()}`);

  const rows: Record<string, string>[] = await res.json();
  const byBbl = new Map<string, DistressFlag[]>();

  for (const r of rows) {
    if (!r.bbl) continue;
    const flags = byBbl.get(r.bbl) ?? [];
    flags.push({
      type:   'code_violation',
      detail: [r.type, r.majorcategoryid, r.minorcategoryid].filter(Boolean).join(' / '),
      source: 'NYC HPD Building Complaints',
      date:   r.receiveddate,
    });
    byBbl.set(r.bbl, flags);
  }
  return byBbl;
}

// ─── Fetch: ACRIS Lis Pendens (foreclosures) ─────────────────────────────────

async function fetchLisPendens(): Promise<Map<string, DistressFlag[]>> {
  // ACRIS master — filter for lis pendens doc class
  const url = `${BASE_URL}/2p6d-qhgr.json?$limit=2000&$where=doc_type=%27LIS+PENDENS%27&$order=:id`;
  const res  = await fetch(url, { headers: socrataHeaders() });

  // Non-fatal if ACRIS is unavailable
  if (!res.ok) {
    console.warn(`ACRIS fetch ${res.status} — skipping foreclosure data`);
    return new Map();
  }

  const rows: Record<string, string>[] = await res.json();
  const byBbl = new Map<string, DistressFlag[]>();

  for (const r of rows) {
    const key = bbl(r.borough, r.block, r.lot);
    const flags = byBbl.get(key) ?? [];
    flags.push({
      type:   'foreclosure',
      detail: `Lis pendens filed ${r.document_date ?? 'unknown'}, doc ID ${r.document_id ?? ''}`,
      source: 'NYC ACRIS',
      date:   r.document_date,
    });
    byBbl.set(key, flags);
  }
  return byBbl;
}

// ─── Upsert helpers ───────────────────────────────────────────────────────────

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

  const supabase = getServiceClient();
  const runId    = crypto.randomUUID();

  // Log the run start
  await supabase.from('ingestion_runs').insert({
    id: runId, source: 'nyc', status: 'running',
  });

  try {
    // Fetch all data sources in parallel
    const [taxLiens, hpdComplaints, lisPendens] = await Promise.all([
      fetchTaxLiens(),
      fetchHPDComplaints(),
      fetchLisPendens(),
    ]);

    // Merge HPD and ACRIS flags into the tax lien property records
    for (const prop of taxLiens) {
      const hpdFlags = hpdComplaints.get(prop.parcel_id) ?? [];
      const lienFlags = lisPendens.get(prop.parcel_id)  ?? [];
      prop.distress_flags.push(...hpdFlags, ...lienFlags);
    }

    // Also create stub records for any ACRIS lis pendens not already in tax lien list
    const taxLienBbls = new Set(taxLiens.map((p) => p.parcel_id));
    for (const [parcelId, flags] of lisPendens) {
      if (taxLienBbls.has(parcelId)) continue;
      taxLiens.push({
        source:         'nyc',
        parcel_id:      parcelId,
        address:        'Unknown — see raw_data',
        city:           'New York',
        state:          'NY',
        zip:            null,
        county:         null,
        owner_name:     null,
        property_type:  null,
        assessed_value: null,
        market_value:   null,
        distress_flags: flags,
        raw_data:       {},
      });
    }

    // Batch upsert (100 rows per call)
    let upserted = 0;
    const BATCH = 100;
    for (let i = 0; i < taxLiens.length; i += BATCH) {
      const batch = taxLiens.slice(i, i + BATCH).map(toDbRow);
      const { error } = await supabase
        .from('properties')
        .upsert(batch, { onConflict: 'source,parcel_id' });
      if (error) throw error;
      upserted += batch.length;
    }

    await supabase.from('ingestion_runs').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      records_fetched: taxLiens.length,
      records_upserted: upserted,
    }).eq('id', runId);

    return jsonResponse({ success: true, records_fetched: taxLiens.length, records_upserted: upserted });
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
