/**
 * finance-credit-builder — For one business entity, checks its
 * business_credit_profiles row against a standard business-credit-building
 * playbook (see docs/finance-business-entities.md), upserts the next
 * unmet steps into credit_building_actions as 'recommended', and files a
 * single agent_recommendation summarizing what to do next. It never applies
 * for credit, opens a tradeline, or contacts a vendor on its own — those are
 * things a human does after approving the recommendation.
 *
 * POST body:
 *   { entity_id: string; max_actions?: number }   -- max_actions default 2
 */

import { getServiceClient, jsonResponse, verifySecret } from '../_shared/supabase-client.ts';
import { generateNarrative, hasAnthropicKey } from '../_shared/anthropic-client.ts';
import type { AgentRecommendationInput } from '../_shared/finance-types.ts';

interface CreditProfile {
  entity_id: string;
  has_ein: boolean;
  has_dedicated_business_bank_account: boolean;
  has_duns_number: boolean;
  trade_lines_count: number;
  business_credit_cards_count: number;
  reporting_bureaus: string[];
  estimated_stage: string;
}

interface PlaybookStep {
  key: string;
  title: string;
  description: string;
  sequenceOrder: number;
  isMet: (p: CreditProfile) => boolean;
}

// Standard business-credit-building sequence. Order matters — later steps
// assume earlier ones are in place (e.g. vendors want an EIN + bank account
// before extending net-30 terms).
const PLAYBOOK: PlaybookStep[] = [
  {
    key: 'obtain_ein', sequenceOrder: 1, title: 'Obtain a federal EIN',
    description: 'Register a federal Employer Identification Number with the IRS. This is the foundation ' +
      'for separating the business\'s credit identity from personal SSN-based credit.',
    isMet: (p) => p.has_ein,
  },
  {
    key: 'dedicated_bank_account', sequenceOrder: 2, title: 'Open a dedicated business bank account',
    description: 'Open a bank account in the legal business name using the EIN. Lenders and vendors check ' +
      'for this, and it keeps business and personal finances legally and financially separate.',
    isMet: (p) => p.has_dedicated_business_bank_account,
  },
  {
    key: 'register_duns', sequenceOrder: 3, title: 'Register a D-U-N-S number',
    description: 'Register (free) with Dun & Bradstreet to get a D-U-N-S number — most business credit ' +
      'bureaus and vendors require one to open a file on the business.',
    isMet: (p) => p.has_duns_number,
  },
  {
    key: 'net30_tradelines', sequenceOrder: 4, title: 'Open 2-3 net-30 vendor tradelines',
    description: 'Open accounts with vendors that extend net-30 terms and report to business credit bureaus ' +
      '(e.g. Uline, Quill, Grainger). Pay in full, on time, every cycle — this is what builds the initial ' +
      'business credit file.',
    isMet: (p) => p.trade_lines_count >= 2,
  },
  {
    key: 'starter_business_card', sequenceOrder: 5, title: 'Apply for a starter/secured business credit card',
    description: 'Apply for a business credit card appropriate to the entity\'s current file thickness ' +
      '(secured card if the file is still thin). Keep utilization low and pay in full.',
    isMet: (p) => p.business_credit_cards_count >= 1,
  },
  {
    key: 'monitor_reports', sequenceOrder: 6, title: 'Enroll in business credit monitoring',
    description: 'Monitor the business credit file across at least two of: Dun & Bradstreet, Experian ' +
      'Business, Equifax Business. Catching reporting errors early matters more for thin business files ' +
      'than for personal credit.',
    isMet: (p) => p.reporting_bureaus.length >= 2,
  },
  {
    key: 'maintain_payment_history', sequenceOrder: 7, title: 'Maintain 6-12 months of on-time payment history',
    description: 'Keep every open tradeline and card current for 6-12 months. This is what moves the file ' +
      'from "building" to "established" and unlocks better terms.',
    isMet: (p) => ['established', 'optimizing'].includes(p.estimated_stage),
  },
  {
    key: 'revolving_credit_line', sequenceOrder: 8, title: 'Apply for a revolving business credit line',
    description: 'With an established file, apply for a revolving business line of credit or a second card ' +
      'from a mainstream issuer to increase available credit and further diversify the file.',
    isMet: (p) => p.business_credit_cards_count >= 2,
  },
];

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    verifySecret(req, 'FINANCE_WEBHOOK_SECRET', 'x-finance-secret');
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  let body: { entity_id?: string; max_actions?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  if (!body.entity_id) return jsonResponse({ error: 'entity_id is required' }, 400);
  const maxActions = body.max_actions ?? 2;

  const supabase = getServiceClient();

  try {
    const { data: entity, error: entErr } = await supabase
      .schema('finance').from('entities').select('id, name, entity_type').eq('id', body.entity_id).single();
    if (entErr || !entity) return jsonResponse({ success: false, error: 'Entity not found' }, 404);
    if (entity.entity_type === 'personal') {
      return jsonResponse({ success: false, error: 'Business credit building does not apply to the personal entity' }, 400);
    }

    let { data: profile, error: profErr } = await supabase
      .schema('finance').from('business_credit_profiles').select('*').eq('entity_id', body.entity_id).maybeSingle();
    if (profErr) throw profErr;

    if (!profile) {
      const { data: created, error: createErr } = await supabase
        .schema('finance').from('business_credit_profiles')
        .insert({ entity_id: body.entity_id }).select('*').single();
      if (createErr) throw createErr;
      profile = created;
    }

    const nextSteps = PLAYBOOK.filter((s) => !s.isMet(profile as CreditProfile)).slice(0, maxActions);

    if (nextSteps.length === 0) {
      await supabase.schema('finance').from('business_credit_profiles')
        .update({ last_reviewed_at: new Date().toISOString() }).eq('entity_id', body.entity_id);
      return jsonResponse({
        success: true, entity_id: body.entity_id, message: 'All playbook steps are currently met.', next_steps: [],
      });
    }

    const actionIds: string[] = [];
    for (const step of nextSteps) {
      const { data: action, error: upsertErr } = await supabase
        .schema('finance').from('credit_building_actions')
        .upsert({
          entity_id: body.entity_id,
          action_key: step.key,
          title: step.title,
          description: step.description,
          sequence_order: step.sequenceOrder,
          status: 'recommended',
          recommended_at: new Date().toISOString(),
        }, { onConflict: 'entity_id,action_key', ignoreDuplicates: false })
        .select('id')
        .single();
      if (upsertErr) throw upsertErr;
      actionIds.push(action.id);
    }

    const templated = `Next recommended step(s) for ${entity.name}: ` +
      nextSteps.map((s) => s.title).join('; ') + `. Current stage: ${profile.estimated_stage}.`;

    let rationale = templated;
    if (hasAnthropicKey()) {
      try {
        rationale = await generateNarrative(
          'You are a concise business-credit-building advisor. Respond in plain prose, 3-4 sentences, no ' +
          'bullet points. Explain why these next steps matter for this specific business right now.',
          `Business: ${entity.name} (${entity.entity_type})\nCurrent stage: ${profile.estimated_stage}\n` +
          `Profile: ${JSON.stringify(profile)}\nRecommended next steps: ${JSON.stringify(nextSteps.map((s) => ({ title: s.title, description: s.description })))}`,
        );
      } catch {
        rationale = templated;
      }
    }

    const recInput: AgentRecommendationInput = {
      entity_id: body.entity_id,
      agent_name: 'finance-credit-builder',
      recommendation_type: 'credit_building',
      title: `Business credit — next steps for ${entity.name}`,
      rationale,
      details: { current_stage: profile.estimated_stage, next_steps: nextSteps.map((s) => ({ key: s.key, title: s.title })) },
      priority: 'medium',
      related_credit_action_id: actionIds[0],
    };

    const { data: rec, error: recErr } = await supabase.schema('finance').from('agent_recommendations')
      .insert(recInput).select('id').single();
    if (recErr) throw recErr;

    await supabase.schema('finance').from('business_credit_profiles')
      .update({ last_reviewed_at: new Date().toISOString() }).eq('entity_id', body.entity_id);

    return jsonResponse({
      success: true,
      entity_id: body.entity_id,
      recommendation_id: rec.id,
      next_steps: nextSteps.map((s) => ({ id: actionIds[nextSteps.indexOf(s)], key: s.key, title: s.title, description: s.description })),
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
