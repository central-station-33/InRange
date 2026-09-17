/**
 * This app has no multi-tenancy concept anywhere else (no login/org
 * switcher). The canonical data model requires organization_id on every
 * row, so single-tenant deployments fall back to a fixed, seeded
 * "Default Organization" row (see migration 20240105000000) unless
 * DEFAULT_ORGANIZATION_ID is set.
 */
const FALLBACK_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';

export function currentOrganizationId(): string {
  return Deno.env.get('DEFAULT_ORGANIZATION_ID') ?? FALLBACK_ORGANIZATION_ID;
}
