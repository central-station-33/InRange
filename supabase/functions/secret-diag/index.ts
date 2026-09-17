/**
 * secret-diag — RETIRED.
 *
 * This was an unauthenticated (verify_jwt: false) diagnostic endpoint,
 * publicly callable by anyone on the internet, that returned whether
 * MAKE_WEBHOOK_SECRET was set, its length, its first 2 and last 2
 * characters, and a truncated SHA-256 hash of it -- then wrote that same
 * payload into raw_properties, a table any authenticated Supabase user can
 * read. Found live during the 2026-09-17 real-world readiness review: same
 * shape of bug as test-api-keys (an unauthenticated diagnostic hitting
 * production), just leaking partial secret material instead of burning API
 * credits. Neutered in place, same pattern as test-api-keys.
 *
 * If you need to verify MAKE_WEBHOOK_SECRET is configured correctly, check
 * the Supabase dashboard's Edge Function secrets list directly, or add a
 * verify_jwt-protected admin-only diagnostic instead of a public one.
 */

Deno.serve(() =>
  new Response(JSON.stringify({ error: 'Retired: this was a diagnostic script, not production functionality.' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  })
);
