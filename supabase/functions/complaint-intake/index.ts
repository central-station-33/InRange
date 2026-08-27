/**
 * complaint-intake — Receives complaint submissions relayed by Make.com
 * from the Elementor Forms webhook (/investor-complaints), plus manual
 * entries for complaints received by email/phone/social DM so there's a
 * single system of record (see compliance notes in the build spec).
 *
 * Re-validates every required field server-side — the front end must never
 * be the only gate, since Elementor's client-side validation can be bypassed.
 *
 * Auto-flags theft/misappropriation/forgery complaints (min 50-char
 * description, `unauthorized_fraud` category, or keyword match) which
 * starts the FINRA Rule 4530 30-day reporting clock via the DB trigger.
 * Fund-disbursement complaints are tagged for the qualified third-party
 * escrow agent, since BT Capital cannot hold investor funds directly
 * (Funding Portal Rule 300(c)(2)(iv)).
 *
 * On success, fires an immediate compliance-officer alert for flagged
 * complaints and an auto-reply confirmation to the complainant via
 * outbound webhooks (Make.com routes these to email/Slack).
 */

import { getServiceClient, jsonResponse, verifyMakeSecret } from '../_shared/supabase-client.ts';
import {
  detectsTheftKeywords,
  REQUIRED_INTAKE_FIELDS,
  type ComplaintIntake,
} from '../_shared/complaints-types.ts';

const COMPLIANCE_ALERT_WEBHOOK = Deno.env.get('COMPLIANCE_ALERT_WEBHOOK') ?? '';
const ESCROW_AGENT_ALERT_WEBHOOK = Deno.env.get('ESCROW_AGENT_ALERT_WEBHOOK') ?? '';
const COMPLAINANT_CONFIRMATION_WEBHOOK = Deno.env.get('COMPLAINANT_CONFIRMATION_WEBHOOK') ?? '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(body: Partial<ComplaintIntake>): string[] {
  const errors: string[] = [];

  for (const field of REQUIRED_INTAKE_FIELDS) {
    const value = body[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (body.email && !EMAIL_RE.test(body.email)) {
    errors.push('Invalid email format');
  }

  if (body.description && body.description.trim().length < 50) {
    errors.push('Description must be at least 50 characters');
  }

  if (body.consent_acknowledged !== true) {
    errors.push('Consent acknowledgement is required');
  }

  const validCategories = [
    'investment_dispute', 'fund_disbursement', 'unauthorized_fraud',
    'misrepresentation', 'technical', 'other',
  ];
  if (body.category && !validCategories.includes(body.category)) {
    errors.push(`Invalid category: ${body.category}`);
  }

  return errors;
}

async function postWebhook(url: string, payload: unknown): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort notification — the complaint is already durably stored.
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifyMakeSecret(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: Partial<ComplaintIntake> = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const errors = validate(body);
  if (errors.length > 0) {
    return jsonResponse({ success: false, errors }, 422);
  }

  const flaggedByKeyword = detectsTheftKeywords(body.description ?? '');
  const involvesTheft = body.category === 'unauthorized_fraud' || flaggedByKeyword;

  const supabase = getServiceClient();

  try {
    const { data: complaint, error } = await supabase
      .from('complaints')
      .insert({
        complainant_name: body.complainant_name,
        complainant_address: body.complainant_address,
        account_number: body.account_number,
        email: body.email,
        phone: body.phone ?? null,
        date_of_incident: body.date_of_incident ?? null,
        category: body.category,
        associated_person: body.associated_person ?? null,
        description: body.description,
        supporting_doc_url: body.supporting_doc_url ?? null,
        preferred_resolution: body.preferred_resolution ?? null,
        consent_acknowledged: body.consent_acknowledged,
        intake_channel: body.intake_channel ?? 'web_form',
        entered_by: body.entered_by ?? null,
        is_written: body.is_written ?? true,
        involves_theft_misappropriation_forgery: involvesTheft,
      })
      .select('*')
      .single();

    if (error) throw error;

    if (involvesTheft) {
      await postWebhook(COMPLIANCE_ALERT_WEBHOOK, {
        type: 'finra_30day_clock_started',
        reference_number: complaint.reference_number,
        complaint_id: complaint.id,
        finra_report_due_date: complaint.finra_report_due_date,
        category: complaint.category,
        summary: `30-day FINRA reporting clock started for ${complaint.reference_number}, due ${complaint.finra_report_due_date}.`,
      });
    }

    if (complaint.escrow_agent_responsible) {
      await postWebhook(ESCROW_AGENT_ALERT_WEBHOOK, {
        type: 'fund_disbursement_complaint',
        reference_number: complaint.reference_number,
        complaint_id: complaint.id,
        summary: `Fund disbursement complaint ${complaint.reference_number} routed to the qualified third-party escrow agent — BT Capital does not hold investor funds directly.`,
      });
    }

    await postWebhook(COMPLAINANT_CONFIRMATION_WEBHOOK, {
      type: 'complaint_received',
      reference_number: complaint.reference_number,
      email: complaint.email,
      complainant_name: complaint.complainant_name,
      message: 'Your complaint has been logged and you will receive a response within 15 business days.',
    });

    return jsonResponse({
      success: true,
      reference_number: complaint.reference_number,
      status: complaint.status,
      finra_report_due_date: complaint.finra_report_due_date,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
