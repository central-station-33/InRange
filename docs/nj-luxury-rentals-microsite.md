# NJ Luxury Rentals Microsite — Content Brief (Draft, Not Published)

**Status: draft content only.** jetreadvisors.com is not connected to any
WordPress account reachable from this session (the connected sites are
jetgrp.com, joinjra.com, and fullerchoicerealty.wordpress.com — none of
them jetreadvisors.com). Nothing below has been published. Once the site
is connected, this is ready to hand to whoever builds the page, or to feed
back into this session for direct publishing via the WordPress connector.

## Positioning

Mirror ApartmentSnob's role for a specific niche rather than competing as a
general rental search site: **the curated luxury rental specialist for one
NJ submarket**, not a Zillow competitor. Pick ONE flagship submarket to
launch with — Hoboken is the natural pilot (it's also the pilot city for
the `ingest-rental-landlord-leads` Apify scenario, so the site's inventory
and the outreach pipeline's inventory are the same data from day one).
Expand to Jersey City, Weehawken, Montclair, Summit once the pilot has
enough live listings to not look empty.

## Site structure

1. **Hero** — "Hoboken's Luxury Rental Specialist" + a single search bar
   (beds/baths/price) that filters the `rental_units` table (segment =
   landlord, listing_status = active, city = Hoboken) once the site is
   wired to Supabase, or a static curated grid until then.
2. **Featured listings** — 6–12 cards pulled from `rental_units`: photo,
   rent, beds/baths, sqft, one-line hook. Falls back to "New listings
   added weekly" placeholder copy if the ingest pipeline hasn't populated
   enough inventory yet — do not launch with fabricated listings.
3. **"Why work with us" section** — three short blocks: local expertise,
   no-fee-to-renter (if true — confirm before publishing), faster showings
   than self-managing landlords can offer.
4. **Landlord CTA** (this is the outreach hook): "List your Hoboken rental
   with us — no upfront cost" → short form (address, unit count, current
   rent, timeline) that POSTs into `landlord_leads`/`isa_leads` the same
   way the Apify pipeline does, giving the microsite a second, organic lead
   source beyond scraping.
5. **Renter CTA** — simple inquiry form feeding `rental_inquiries` (this
   table already exists and is what `rental_matches` is built to consume).
6. **Footer** — NJ real estate license disclosure, fair housing statement
   (required — do not omit).

## SEO / meta

- Title tag: "Hoboken Luxury Rentals | [Brand] — No-Fee Apartments & Condos"
- Meta description: one sentence, city + "luxury rentals" + a
  differentiator (curated, no-fee, local).
- H1 matches title tag intent, not a generic "Welcome" headline.

## What's needed before this can go live

1. Confirm which brand/domain this sits under (jetreadvisors.com per the
   original ask, or a subdomain of an existing connected site as a faster
   path — joinjra.com already exists and has a custom domain, just needs
   its Jetpack plan upgraded before this session's WordPress tools can
   touch it).
2. Real inventory — either wait for the Apify pilot scenario to populate
   `rental_units` for Hoboken, or manually seed 6–12 real listings to avoid
   launching an empty page.
3. Legal review of the "no upfront cost to landlord" and fee claims before
   they go on a public page.
