/**
 * enrich-property — RETIRED.
 *
 * Deployed live with a genuinely empty source file (0 bytes) as of the
 * 2026-09-17 readiness review -- no Deno.serve() handler, so every call
 * would have failed to boot rather than run anything. Confirmed dead, not
 * just unused: zero edge-log entries of any kind (including errors) in the
 * available 24h window, and properties.arv_source = 'ai_refined' -- the one
 * value only this function was ever supposed to write -- has never been
 * set on a single row in the table's lifetime. No other function or Make
 * scenario name references it.
 *
 * arv_source = 'ai_refined' was meant to mean "estimated_arv adjusted by a
 * Claude call on top of the comps-based estimate" (see the column comment
 * on properties.arv_source). That capability was never actually built, not
 * removed -- if it's still wanted, it needs building from scratch, not
 * "fixing." The CHECK constraint on arv_source still allows the value in
 * case that happens; nothing here removes it.
 *
 * Retired the same way as test-api-keys and secret-diag: a static 410
 * stub, verify_jwt left off since there's nothing left to protect.
 */

Deno.serve(() =>
  new Response(JSON.stringify({ error: 'Retired: source was empty/dead, never produced output. See function comment.' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  })
);
