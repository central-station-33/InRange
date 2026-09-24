# IDX Syndication Verification — Checklist (Not Yet Run)

**This has not been verified.** jetreadvisors.com is not reachable from
this session's WordPress connector (not in the connected portfolio), so no
claim below has been confirmed live. This is the runbook to execute once
the site is connected, or to hand to whoever has admin access today.

## What to check

1. **Which IDX plugin/service is installed?** (iHomefinder, IDX Broker,
   Realtyna, Showcase IDX, etc.) — Plugins → Installed Plugins, or Site
   Editor → check for an IDX-branded settings page.
2. **Is the MLS feed itself active?** Every IDX plugin has a feed-status
   page (usually under its own settings menu) showing last sync time and
   record count. A stale "last synced" date (days/weeks old) means the MLS
   feed itself is the problem, upstream of any syndication.
3. **Zillow/Trulia syndication** — most NJ MLSs push to Zillow Rental
   Manager or Zillow's broker feed automatically once a listing is in the
   MLS; this is usually MLS-level, not WordPress-plugin-level. Confirm with
   the MLS's participation rules (some require an opt-in broker agreement)
   rather than assuming the WordPress plugin controls this.
4. **StreetEasy-equivalent for NJ** — StreetEasy itself is NYC/NYC-metro
   only; there is no single dominant NJ equivalent. The closest analogs are
   NJMLS's own consumer-facing search and Zillow/Realtor.com/Apartments.com
   picking up the MLS feed. Don't assume a StreetEasy-style single syndication
   target exists for NJ — verify what the specific NJ MLS (which one —
   NJMLS, GSMLS, MonmouthOcean, Bright MLS if applicable?) actually pushes to.
5. **Which NJ MLS is the brokerage actually a member of?** This determines
   everything above — syndication behavior differs by MLS. Confirm this
   first; it's the one fact nothing in this session can look up without
   being told.

## What would make this "confirmed"

- A screenshot or export of the IDX plugin's sync status showing a recent
  timestamp.
- At least one listing verified live on Zillow/Realtor.com/Apartments.com
  that matches an active MLS listing, confirming the feed is actually
  flowing end to end (not just configured).
- Written confirmation from the MLS of which third-party sites are in its
  syndication agreement.

None of this requires code changes — it's an operational verification, not
a build task. Once access to jetreadvisors.com (or wherever the real IDX
integration lives) is available in a session, this checklist becomes a
15-minute check.
