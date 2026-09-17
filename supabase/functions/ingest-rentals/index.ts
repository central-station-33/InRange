/**
 * ingest-rentals — Rental-landlord segment intake.
 *
 * Unlike ingest-nyc/ingest-nj, there is no free open-data API for "for rent
 * by owner" listings — this data has to come from a scraper. Point a Make.com
 * scenario at an Apify actor (e.g. a Zillow/Craigslist rental-listings
 * scraper — search the Apify Store; none is pinned here since actor
 * availability/quality changes) and POST its dataset items to this function.
 *
 * Every listing is tagged distress_flags: ['frbo_unrepresented'] by
 * construction — the whole point of this segment is landlords who are
 * self-managing, i.e. reachable without a brokerage in the way.
 *
 * Body:
 *   {
 *     "listings": [
 *       {
 *         "address": "123 Main St", "city": "Jersey City", "state": "NJ", "zip": "07302",
 *         "county": "Hudson",
 *         "owner_name": "Jane Doe", "owner_phone": "+1201...", "owner_email": "jane@...",
 *         "monthly_rent": 2400, "unit_count": 1, "days_on_market": 34,
 *         "listing_url": "https://...", "source_platform": "zillow_rentals"
 *       }
 *     ]
 *   }
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import type { DistressFlag, Property } from '../_shared/types.ts';

const LONG_DOM_THRESHOLD_DAYS = 30;

interface RentalListing {
  address: string;
  city: string;
  state: string;
  zip?: string | null;
  county?: string | null;
  owner_name?: string | null;
  owner_phone?: string | null;
  owner_email?: string | null;
  monthly_rent?: number | null;
  unit_count?: number | null;
  days_on_market?: number | null;
  listing_url?: string | null;
  source_platform?: string | null;
}

function parcelIdFor(l: RentalListing): string {
  // Rentals don't have a tax parcel ID — key on the listing URL when we have
  // one (stable per-listing), otherwise fall back to a normalized address.
  const key = l.listing_url || `${l.address}|${l.zip ?? ''}`.toLowerCase();
  return `rental:${key.replace(/\s+/g, '_').slice(0, 200)}`;
}

function toDbRow(l: RentalListing, portfolioCount: number) {
  const flags: DistressFlag[] = [
    {
      type:   'frbo_unrepresented',
      detail: `Self-listed rental${l.source_platform ? ` on ${l.source_platform}` : ''}`,
      source: l.source_platform ?? 'rental_scraper',
      date:   new Date().toISOString(),
    },
  ];

  if ((l.days_on_market ?? 0) >= LONG_DOM_THRESHOLD_DAYS) {
    flags.push({
      type:   'long_dom_rental',
      detail: `${l.days_on_market} days on market`,
      source: l.source_platform ?? 'rental_scraper',
    });
  }

  if (portfolioCount >= 2) {
    flags.push({
      type:   'portfolio_landlord',
      detail: `${portfolioCount} unrepresented listings from the same contact in this batch`,
      source: 'ingest-rentals (same-batch match on phone/email)',
    });
  }

  return {
    source:         (l.state ?? '').toUpperCase() === 'NY' ? 'nyc' : 'nj',
    segment:        'rental_landlord',
    parcel_id:      parcelIdFor(l),
    address:        l.address,
    city:           l.city,
    state:          l.state,
    zip:            l.zip ?? null,
    county:         l.county ?? null,
    owner_name:     l.owner_name ?? null,
    property_type:  'rental_unit',
    assessed_value: null,
    market_value:   l.monthly_rent ? l.monthly_rent * 12 : null, // annualized rent, not a market value proxy — flagged in raw_data too
    distress_flags: flags,
    raw_data: {
      owner_phone:     l.owner_phone ?? null,
      owner_email:     l.owner_email ?? null,
      monthly_rent:    l.monthly_rent ?? null,
      unit_count:      l.unit_count ?? null,
      days_on_market:  l.days_on_market ?? null,
      listing_url:     l.listing_url ?? null,
      source_platform: l.source_platform ?? null,
    },
    updated_at: new Date().toISOString(),
  } satisfies Partial<Property> & Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { listings?: RentalListing[] } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const listings = body.listings ?? [];
  if (listings.length === 0) {
    return jsonResponse({ success: true, records_fetched: 0, records_upserted: 0 });
  }

  const supabase = getServiceClient();
  const runId    = crypto.randomUUID();

  await supabase.from('ingestion_runs').insert({
    id: runId, source: 'rental_landlord', status: 'running',
  });

  try {
    // Same-batch portfolio detection: group by phone (fallback email) to
    // flag landlords who have more than one unrepresented listing right now.
    // Cross-run portfolio detection (across separate ingest calls) would
    // need a DB lookup by owner contact — not implemented here.
    const contactCounts = new Map<string, number>();
    for (const l of listings) {
      const key = l.owner_phone || l.owner_email;
      if (!key) continue;
      contactCounts.set(key, (contactCounts.get(key) ?? 0) + 1);
    }

    const rows = listings.map((l) => {
      const key = l.owner_phone || l.owner_email || '';
      return toDbRow(l, contactCounts.get(key) ?? 1);
    });

    let upserted = 0;
    const BATCH = 100;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await supabase
        .from('properties')
        .upsert(batch, { onConflict: 'source,parcel_id' });
      if (error) throw error;
      upserted += batch.length;
    }

    await supabase.from('ingestion_runs').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      records_fetched: listings.length,
      records_upserted: upserted,
    }).eq('id', runId);

    return jsonResponse({ success: true, records_fetched: listings.length, records_upserted: upserted });
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
