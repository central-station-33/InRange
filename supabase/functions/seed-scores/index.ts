/**
 * seed-scores — RETIRED.
 *
 * This was a one-off dev seed script: unauthenticated, GET-triggerable, and
 * it overwrote every properties row with a NULL composite_score with fake
 * canned "Tier 1 Foreclosure" scores. Found live during a security review
 * (2026-09-08) with zero real callers -- it has no legitimate production
 * purpose and is a live data-corruption risk. Neutered in place.
 */

Deno.serve(() =>
  new Response(JSON.stringify({ error: 'Retired: this was a dev seed script, not production functionality.' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  })
);
