/**
 * outreach-send — POST /outreach/:leadId/send
 *
 * Per the API/queue spec: "Do not implement actual send behavior unless
 * existing consent and approval controls are verified." They are not —
 * concretely:
 *
 * - lead_contacts.dnc_flag exists but no code path reads it before a send.
 * - There is no consent/opt-in record anywhere in this schema — no table
 *   tracking that a specific contact actually consented to outreach on a
 *   specific channel, only the boolean "we believe this number is do-not-
 *   call or not."
 * - TCPA/DNC compliance for the pre_foreclosure/probate categories this
 *   pipeline targets most is explicitly still counsel-unreviewed —
 *   compliance_playbook rows are seeded with counsel_reviewed = FALSE.
 *
 * This endpoint therefore exists (per the API spec, which does list it)
 * but unconditionally refuses. It never calls Twilio, SendGrid, or any
 * other outbound channel. Approving a draft (outreach-approve) does not
 * change this — approval and consent verification are different things,
 * and only the latter would unblock this endpoint.
 */

import { extractIdParam, jsonResponse, verifyEnrichmentSecret } from '../_shared/supabase-client.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyEnrichmentSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const leadId = extractIdParam(req, 'lead_id');
  if (!leadId) return jsonResponse({ error: 'lead_id is required (path segment or ?lead_id=)' }, 400);

  return jsonResponse(
    {
      success: false,
      blocked: true,
      reason:
        'Outreach send is disabled: consent and DNC-approval controls are not yet verified for this pipeline ' +
        '(no consent/opt-in record exists in the schema, lead_contacts.dnc_flag is not checked by any code path, ' +
        'and compliance_playbook rows are still counsel_reviewed = false). See ' +
        'docs/ai-lead-enrichment-blueprint.md §9 and the outreach-send source comment. ' +
        'This endpoint will continue to refuse until those controls exist and are verified.',
    },
    403,
  );
});
