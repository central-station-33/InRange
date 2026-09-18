# Rental Media Production — Freelancer Scope Brief (Draft)

This is a hiring decision, not something this session can execute — no
freelancer marketplace or contractor-management tool is connected here.
What follows is a ready-to-post scope of work.

## Why this gap matters now

Once `ingest-rental-landlord-leads` starts converting unrepresented-listing
leads into signed representation agreements, every one of those units needs
professional photos/video to actually compete with agent-listed inventory —
the whole pitch to the landlord is "we'll get your unit rented faster than
your FRBO post," and phone-camera photos undercut that pitch immediately.

## Scope of work (part-time retainer)

- **Deliverable per unit:** 15–25 professional photos + one 30–60s vertical
  video (for the microsite and social) + one floor-plan-style overview shot
  if the unit doesn't have an existing floor plan.
- **Turnaround:** 48 hours from showing access to delivered, edited media —
  slower than that and the "list with us" pitch loses its edge over FRBO.
- **Coverage area:** starts with the microsite's pilot submarket (Hoboken)
  and expands with `rental_units` volume — don't commit to a retainer sized
  for multi-city coverage before the pilot proves volume.
- **Volume-based retainer, not salaried:** price per shoot (e.g. flat fee
  per unit under ~1,500 sqft, +X for larger units) rather than a fixed
  monthly retainer, until `landlord_leads.pipeline_stage = 'active_listing'`
  volume is predictable enough to justify a guaranteed monthly minimum.
- **Usage rights:** must include full rights for MLS syndication, the
  microsite, and social reposting — a freelancer who wants to license
  per-use isn't a fit for this volume.

## Where to source this

Standard freelance marketplaces (Thumbtack, local real estate photography
specialists, or a referral from the brokerage's existing agent network) —
no connector exists in this session to post or manage this directly.

## Trigger to revisit sizing

Once `landlord_leads` has enough rows at `pipeline_stage = 'active_listing'`
to see real weekly shoot volume, revisit flat-fee-per-shoot vs. a
guaranteed-minimum monthly retainer.
