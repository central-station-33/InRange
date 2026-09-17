# IDX/MLS Syndication Verification — jetreadvisors.com

## Why this couldn't be done automatically

I could not verify this item, for two independent reasons — either one alone
would have blocked it:

1. **`jetreadvisors.com` is not a site this account controls.** The
   WordPress.com account only has 4 connected sites: `jetgrp.com`,
   `joinjra.com` (×2 — one active, one disconnected), and
   `fullerchoicerealty.wordpress.com`. `jetreadvisors.com` isn't among them,
   so there's no admin/plugin access to check IDX plugin config even if I
   could reach it.
2. **Outbound network access to the domain is blocked at the environment
   level.** A direct fetch attempt returned `EGRESS_BLOCKED` — this
   session's network policy doesn't allow reaching that domain at all, so
   I can't even view it as a public visitor.

If `jetreadvisors.com` is meant to be reachable, the network policy for this
Claude Code environment needs to allow it — that's configured in the
environment's settings (not something I can change from inside the
session), documented at
https://code.claude.com/docs/en/claude-code-on-the-web. If it's the wrong
domain, let me know the right one and I'll take another pass.

## Manual verification checklist (do this directly, or re-run me once the
domain/access issue above is resolved)

**In the IDX plugin/provider dashboard** (IDX Broker, iHomefinder, Realtyna,
etc. — whichever is installed):
- [ ] Confirm the MLS feed connection shows "Active" / "Connected," not
      "Pending" or "Error"
- [ ] Check the last successful sync timestamp — if it's more than 24-48h
      old, the feed is stale even if it shows "connected"
- [ ] Confirm the plugin's Zillow/Trulia syndication toggle is switched on
      (most IDX providers gate this separately from the core MLS feed)
- [ ] Confirm listing count matches what the MLS shows for this office/agent

**On each destination portal:**
- [ ] Search Zillow for the brokerage/agent name directly — do current
      listings appear, and is contact info correct?
- [ ] There is no direct StreetEasy equivalent for NJ (StreetEasy is NYC-only
      and requires its own separate feed agreement, not automatic via
      generic IDX/Zillow syndication) — check whether "StreetEasy" here
      actually means NJMLS/GSMLS syndication to Realtor.com and
      Homes.com instead, since NJ properties don't route through
      StreetEasy at all
- [ ] Confirm listings pushed to NJ MLS (NJMLS/GSMLS depending on county)
      show the correct listing agent/office, not a stale or duplicate entry

**Red flags that mean the feed is broken, not just slow:**
- New listings entered in the MLS don't appear on the website within 24h
- Listings removed/sold in the MLS still show as active on Zillow
- Photos or price on the portal don't match the MLS record
