/**
 * ingest-rental-landlord-leads — the "landlord" ISA segment ingest.
 *
 * Targets landlords with UNREPRESENTED rental units: self-listed (FRBO)
 * postings with no leasing agent, sourced via Make from Apify rental
 * scrapers (e.g. HotPads with for_rent_by_owner=true, StreetEasy with
 * byOwner=true). The "unrepresented" filter is applied upstream, at the
 * Apify actor's input, not re-derived here from uncertain output fields
 * (see ingest-nj-developer-leads for why guessing field semantics from an
 * unverified dataset is the wrong place to add that logic).
 *
 * This is the ingest half of the segment (writes isa_leads + landlord_leads
 * + rental_units). It deliberately does NOT touch agent_routing_rules, so
 * assign-leads (the auto-router) never picks these up — every row lands
 * with assigned_agent_id = NULL and sits in the `unclaimed_leads` view
 * until an agent calls claim-lead. That is the whole "lead-claim mechanism":
 * an omission from auto-routing plus an atomic claim endpoint, not a new
 * status enum.
 *
 * POST /ingest-rental-landlord-leads?market=nj&source_name=hotpads_frbo
 * Body: Array<Record<string, unknown>>  -- raw actor dataset items, as the
 * top-level JSON body (not wrapped in an object). market/source_name ride
 * on the query string rather than the body so a Make HTTP module can bind
 * this function's whole "data" field directly to the Apify call's dataset
 * array (a pure {{x.body}} reference), which Make serializes as JSON on
 * its own -- no manual string-concatenation of a nested array into a raw
 * JSON body, which is exactly the kind of templating that's easy to get
 * subtly wrong and impossible to verify without live network access.
 *
 * Field names below are VERIFIED against a live run of
 * fatihtahta/hotpads-scraper (2026-09-24): its output is deeply nested
 * (e.g. `location.address.street`, `pricing.rent.min`), not the flat
 * top-level names originally guessed here before that run existed. `pick`
 * resolves dot-paths so a candidate list can mix nested paths (real,
 * verified) with flat fallbacks (for a different actor, e.g. StreetEasy,
 * whose output shape hasn't been verified live). HotPads has no email
 * field and no explicit availability-date field at all -- those stay
 * null rather than guessing, since a wrong inferred value (e.g. treating
 * `listing.published_at` as move-in availability) is worse than absent.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const MAKE_SECRET = Deno.env.get('MAKE_WEBHOOK_SECRET') ?? '';

const FIELD_CANDIDATES = {
  address: ['location.address.street', 'address', 'street_address', 'streetAddress'],
  city: ['location.address.city', 'location.city', 'city'],
  zip: ['location.address.postal_code', 'location.postal_code', 'zip', 'zipcode'],
  rent: ['pricing.rent.min', 'pricing.price_min', 'rent', 'price', 'monthly_rent'],
  bedrooms: ['property.bedrooms.min', 'bedrooms', 'beds'],
  bathrooms: ['property.bathrooms.value', 'property.bathrooms.min', 'bathrooms', 'baths'],
  sqft: ['property.floor_area_sqft.min', 'sqft', 'square_footage', 'livingArea'],
  contactName: ['contact_details.name', 'contact_details.contacts.contact_name', 'contactName', 'ownerName'],
  contactPhone: ['contact_details.phone', 'contact_details.contacts.contact_phone', 'contactPhone', 'phone'],
  contactEmail: ['contact_details.email', 'contactEmail', 'email'],
  listingUrl: ['entity.url', 'source_context.listing_url', 'listingUrl', 'url'],
  availableDate: ['available_date', 'availableDate', 'availabilityDate'],
  photos: ['media.image_urls', 'media.main_image_url', 'photos', 'images'],
  description: ['entity.description', 'description', 'body'],
  petPolicy: ['property.pets_allowed', 'pet_policy', 'petPolicy', 'pets'],
  furnished: ['furnished', 'isFurnished'],
};

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function pick(row: Record<string, unknown>, candidates: string[]): unknown {
  for (const path of candidates) {
    const val = getPath(row, path);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

function mapPetPolicy(val: unknown): string | null {
  if (val === true) return 'Pets allowed';
  if (val === false) return 'No pets';
  return val ? String(val) : null;
}

function mapFurnished(val: unknown): 'furnished' | 'unfurnished' | null {
  if (val === true) return 'furnished';
  if (val === false) return 'unfurnished';
  const s = String(val ?? '').toLowerCase();
  if (s.includes('furnished') && !s.includes('unfurnished')) return 'furnished';
  if (s.includes('unfurnished')) return 'unfurnished';
  return null;
}

function mapContactMethod(phone: unknown, email: unknown): 'call' | 'email' | null {
  if (phone) return 'call';
  if (email) return 'email';
  return null;
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!MAKE_SECRET) return json({ success: false, error: 'Server misconfigured' }, 500);
  if (req.headers.get('x-make-secret') !== MAKE_SECRET) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  const qs = new URL(req.url).searchParams;
  const supabase = getServiceClient();

  // Read as text first and persist unconditionally, BEFORE any parsing --
  // a "success" response that silently ingested nothing (as happened here
  // once already) is indistinguishable from "Apify returned 0 listings"
  // unless the raw request itself is captured, including the failure case
  // where it isn't valid JSON at all.
  const rawText = await req.text();
  let rawBody: unknown = null;
  let parseError: string | null = null;
  try {
    rawBody = JSON.parse(rawText);
  } catch (e) {
    parseError = (e as Error).message;
  }

  await persistDiag(supabase, 'request', {
    content_type: req.headers.get('content-type'),
    raw_text_length: rawText.length,
    raw_text_sample: rawText.slice(0, 1000),
    parse_error: parseError,
    parsed_is_array: Array.isArray(rawBody),
    parsed_type: typeof rawBody,
  });

  // Accept either the plain top-level array (the Make-friendly contract
  // documented above) or {market, source_name, listings} for direct testing.
  const bodyObj: Record<string, unknown> = Array.isArray(rawBody) ? {} : (rawBody as Record<string, unknown> | null) ?? {};
  const market = (qs.get('market') ?? bodyObj.market) === 'nyc' ? 'nyc' : 'nj';
  const sourceName = String(qs.get('source_name') ?? bodyObj.source_name ?? 'apify_rental_frbo');
  const listings = Array.isArray(rawBody)
    ? rawBody as Record<string, unknown>[]
    : Array.isArray(bodyObj.listings) ? bodyObj.listings as Record<string, unknown>[] : [];

  if (!listings.length) return json({ success: true, data: { fetched: 0, upserted: 0, deduped: 0, errors: [] } });

  const results = { fetched: listings.length, upserted: 0, deduped: 0, errors: [] as string[] };
  const rawSample = listings.slice(0, 2);

  for (const row of listings) {
    try {
      const address  = String(pick(row, FIELD_CANDIDATES.address) ?? '').trim();
      if (!address) { results.errors.push('Skipped: no address field found'); continue; }

      const city         = String(pick(row, FIELD_CANDIDATES.city) ?? '');
      const zip          = String(pick(row, FIELD_CANDIDATES.zip) ?? '');
      const rent         = Number(pick(row, FIELD_CANDIDATES.rent) ?? 0) || null;
      const bedrooms     = Number(pick(row, FIELD_CANDIDATES.bedrooms) ?? NaN);
      const bathrooms    = Number(pick(row, FIELD_CANDIDATES.bathrooms) ?? NaN);
      const sqft         = Number(pick(row, FIELD_CANDIDATES.sqft) ?? NaN);
      const contactName  = pick(row, FIELD_CANDIDATES.contactName) as string | undefined;
      const contactPhone = pick(row, FIELD_CANDIDATES.contactPhone) as string | undefined;
      const contactEmail = pick(row, FIELD_CANDIDATES.contactEmail) as string | undefined;
      const listingUrl   = String(pick(row, FIELD_CANDIDATES.listingUrl) ?? '');
      const availableRaw = pick(row, FIELD_CANDIDATES.availableDate);
      const availableDate = availableRaw ? new Date(String(availableRaw)).toISOString().slice(0, 10) : null;
      const photos       = pick(row, FIELD_CANDIDATES.photos);
      const description  = pick(row, FIELD_CANDIDATES.description) as string | undefined;
      const petPolicy    = mapPetPolicy(pick(row, FIELD_CANDIDATES.petPolicy));
      const furnished    = mapFurnished(pick(row, FIELD_CANDIDATES.furnished));

      const stateCode = market === 'nyc' ? 'NY' : 'NJ';
      const fullAddress = [address, city, stateCode, zip].filter(Boolean).join(', ');

      // Dedupe on (source_name, listing URL) when we have one, else on the
      // raw address string within this segment/market -- same-day re-runs
      // of the same city search would otherwise create duplicate leads.
      let existingQuery = supabase
        .from('isa_leads')
        .select('id')
        .eq('segment', 'landlord')
        .eq('market', market)
        .not('outreach_status', 'in', '("dead","closed")');
      existingQuery = listingUrl
        ? existingQuery.eq('source_url', listingUrl)
        : existingQuery.eq('property_address', fullAddress);
      const { data: existing } = await existingQuery.maybeSingle();

      const motivationSignals = [
        `Self-listed, no leasing agent (${sourceName})`,
        rent ? `Asking rent: $${rent.toLocaleString()}/mo` : 'Asking rent: unknown',
        availableDate ? `Available: ${availableDate}` : undefined,
      ].filter(Boolean) as string[];

      if (existing) {
        await supabase.from('isa_leads').update({
          raw_data: row,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
        results.deduped++;
        continue;
      }

      const { data: newLead, error: leadErr } = await supabase.from('isa_leads').insert({
        segment: 'landlord',
        market,
        commission_source: 'inrange_generated',
        routing: 'new',
        outreach_status: 'new',
        module: 'rental_leasing',
        lead_role: 'landlord',
        full_name: contactName ?? null,
        entity_name: contactName ?? null,
        property_address: fullAddress,
        state: stateCode,
        motivation_signals: motivationSignals,
        source_name: sourceName,
        source_url: listingUrl || null,
        email: contactEmail ?? null,
        phone: contactPhone ?? null,
        raw_data: row,
        // assigned_agent_id intentionally omitted (stays NULL) -- this
        // segment is not in agent_routing_rules, so it stays unclaimed.
      }).select('id').single();

      if (leadErr) throw new Error(`isa_leads: ${leadErr.message}`);

      const { data: newLandlordLead, error: llErr } = await supabase.from('landlord_leads').insert({
        isa_lead_id: newLead.id,
        property_address: fullAddress,
        city: city || null,
        state: stateCode,
        zip: zip || null,
        unit_count: 1,
        expected_rent: rent,
        vacancy_date: availableDate,
        current_status: 'unrepresented_active_listing',
        leasing_need: 'find_tenant',
        preferred_contact_method: mapContactMethod(contactPhone, contactEmail),
        pipeline_stage: 'new_lead',
        notes: `Sourced from ${sourceName}${listingUrl ? `: ${listingUrl}` : ''}`,
      }).select('id').single();

      if (llErr) throw new Error(`landlord_leads: ${llErr.message}`);

      const { error: ruErr } = await supabase.from('rental_units').insert({
        landlord_lead_id: newLandlordLead.id,
        address,
        city: city || null,
        state: stateCode,
        zip: zip || null,
        listing_status: 'active',
        available_date: availableDate,
        monthly_rent: rent,
        bedrooms: Number.isFinite(bedrooms) ? bedrooms : null,
        bathrooms: Number.isFinite(bathrooms) ? bathrooms : null,
        square_footage: Number.isFinite(sqft) ? sqft : null,
        pet_policy: petPolicy ?? null,
        furnished_status: furnished,
        description: description ?? null,
        photos: photos ?? null,
        listing_source: sourceName,
        last_verified_at: new Date().toISOString(),
      });

      if (ruErr) throw new Error(`rental_units: ${ruErr.message}`);

      results.upserted++;
    } catch (e) {
      const label = pick(row, FIELD_CANDIDATES.address) ?? pick(row, ['entity.title']) ?? 'unknown address';
      results.errors.push(`${label}: ${(e as Error).message}`);
    }
  }

  await persistDiag(supabase, 'results', { ...results, raw_response_sample: rawSample });

  return json({ success: true, data: results });
});

async function persistDiag(supabase: ReturnType<typeof getServiceClient>, stageKey: string, data: Record<string, unknown>) {
  try {
    await supabase.from('raw_properties').upsert({
      property_hash: `diagnostic_ingest_rental_landlord_leads_${stageKey}`,
      source: 'diagnostic',
      raw_data: { ran_at: new Date().toISOString(), ...data },
      processed_at: new Date().toISOString(),
    }, { onConflict: 'property_hash' });
  } catch { /* diagnostics must never break the real response */ }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
