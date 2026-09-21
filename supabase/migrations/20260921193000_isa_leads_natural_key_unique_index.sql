-- Prevents the isa_leads duplication that let a single ACRIS bridge re-run
-- re-insert the same prospect on every pass. On 2026-09-21 this had produced
-- 627 rows covering 162 distinct prospects, and duplicates were being paid
-- for individually at AI enrichment time.
--
-- Root cause was in ingest-leads: the existing-lead lookup used a PostgREST
-- .or() filter with unquoted values, and 552 of 627 names contained a comma
-- (ACRIS returns "LAST, FIRST"), so the comma was parsed as the OR separator
-- and the lookup silently matched nothing. This index makes the database,
-- not the caller, the authority on lead identity.
--
-- Partial on purpose: dead/closed leads drop out of the index, so the same
-- prospect can legitimately re-enter the pipeline later. That mirrors the
-- original intent of the ingest-leads lookup, which also excluded them.
-- IS DISTINCT FROM (not NOT IN) so a NULL outreach_status is still indexed.
--
-- Applied to production 2026-09-21 after de-duplicating 465 rows. The removed
-- rows were preserved in isa_leads_dedupe_backup_20260921 (not created here --
-- it is a one-off operational artifact, safe to drop once confirmed).
create unique index if not exists isa_leads_natural_key_uidx
on isa_leads (
  coalesce(segment, ''),
  coalesce(market, ''),
  lower(btrim(coalesce(full_name, entity_name, ''))),
  lower(btrim(coalesce(property_address, '')))
)
where outreach_status is distinct from 'dead'
  and outreach_status is distinct from 'closed';

comment on index isa_leads_natural_key_uidx is
  'Natural-key uniqueness for active leads: segment + market + name + property address. Added 2026-09-21 after de-duplicating 465 rows. ingest-leads should upsert on conflict rather than relying on its own lookup.';
