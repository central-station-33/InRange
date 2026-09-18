/**
 * test-api-keys — RETIRED.
 *
 * This sent a real test email via Resend and pinged OpenAI/RapidAPI on every
 * call, completely unauthenticated. Found live during a security review
 * (2026-09-08): OpenAI and RapidAPI aren't used anywhere else in this
 * project, so this was leftover scaffolding from an earlier iteration, left
 * as a public cost/abuse vector. Neutered in place.
 */

Deno.serve(() =>
  new Response(JSON.stringify({ error: 'Retired: this was a diagnostic script, not production functionality.' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  })
);
