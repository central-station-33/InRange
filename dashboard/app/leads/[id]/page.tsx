import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAdminClient } from '@/lib/supabase';
import { Touch } from '@/lib/types';
import { RoutingBadge } from '@/components/RoutingBadge';
import { StatusBadge } from '@/components/StatusBadge';
import { ScoreBar } from '@/components/ScoreBar';
import { LogTouchForm } from '@/components/LogTouchForm';

const CADENCE_LABELS: Record<number, string> = {
  0: 'Not started',
  1: 'Day 1 sent',
  2: 'Day 3 sent',
  3: 'Day 7 sent',
  4: 'Day 14 sent',
  5: 'Complete (Day 30)',
};

const CADENCE_NEXT: Record<number, string> = {
  0: 'First touch fires 1 day after creation',
  1: 'Next: Day 3 message (2 days from last)',
  2: 'Next: Day 7 message (4 days from last)',
  3: 'Next: Day 14 message (7 days from last)',
  4: 'Next: Day 30 final message (16 days from last)',
  5: 'Sequence complete',
};

function CadenceStatus({ step, lastCadenceAt, paused }: { step: number; lastCadenceAt?: string | null; paused: boolean }) {
  const pct = Math.round((step / 5) * 100);
  return (
    <div>
      {paused && (
        <div className="text-xs bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-lg px-3 py-2 mb-3">
          Paused — lead reached terminal status
        </div>
      )}
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{CADENCE_LABELS[step] ?? `Step ${step}`}</span>
        <span>{step}/5</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-2 mb-2">
        <div
          className={`h-2 rounded-full transition-all ${paused ? 'bg-gray-300' : 'bg-indigo-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-gray-400">{paused ? 'No further messages will be sent' : CADENCE_NEXT[step]}</p>
      {lastCadenceAt && (
        <p className="text-xs text-gray-300 mt-1">
          Last sent {new Date(lastCadenceAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </p>
      )}
    </div>
  );
}

function fmtMoney(n?: number | null) {
  if (!n) return null;
  return `$${Number(n).toLocaleString()}`;
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(s: string) {
  return new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  const supabase = getAdminClient();

  const [{ data: lead }, { data: touches }] = await Promise.all([
    supabase.from('isa_leads').select('*').eq('id', params.id).single(),
    supabase.from('lead_touches').select('*').eq('lead_id', params.id).order('touched_at', { ascending: false }),
  ]);

  if (!lead) notFound();

  const name   = lead.full_name ?? lead.entity_name ?? 'Unknown Lead';
  const budget = lead.price_range_min
    ? `${fmtMoney(lead.price_range_min)} – ${fmtMoney(lead.price_range_max)}`
    : null;
  const points = Array.isArray(lead.isa_talking_points) ? lead.isa_talking_points as string[] : [];

  return (
    <div className="max-w-5xl">
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-5 transition-colors">
        ← Pipeline
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{name}</h1>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <RoutingBadge routing={lead.routing ?? 'new'} />
            <StatusBadge status={lead.outreach_status} />
            <span className="text-xs font-semibold text-gray-400 uppercase">
              {lead.market} · {lead.segment?.replace(/_/g, ' ')}
            </span>
          </div>
        </div>
        <div className="text-right text-xs text-gray-400">
          Created {fmtDate(lead.created_at)}
          {lead.first_response_at && (
            <div className="text-green-600 mt-0.5">Auto-responded {fmtDate(lead.first_response_at)}</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Left / center: 2 columns wide */}
        <div className="col-span-2 space-y-5">

          {/* Contact */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <h3 className="font-semibold text-gray-900 mb-3">Contact</h3>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {lead.phone        && <><dt className="text-gray-400">Phone</dt><dd className="font-medium text-gray-900">{lead.phone}</dd></>}
              {lead.email        && <><dt className="text-gray-400">Email</dt><dd className="font-medium text-gray-900 truncate">{lead.email}</dd></>}
              {lead.employer     && <><dt className="text-gray-400">Employer</dt><dd className="text-gray-900">{lead.employer}</dd></>}
              {lead.team_name    && <><dt className="text-gray-400">Team</dt><dd className="text-gray-900">{lead.team_name}</dd></>}
              {lead.sport        && <><dt className="text-gray-400">Sport</dt><dd className="text-gray-900">{lead.sport}</dd></>}
              {lead.production_name && <><dt className="text-gray-400">Production</dt><dd className="text-gray-900">{lead.production_name}</dd></>}
              {lead.origin_country && <><dt className="text-gray-400">From</dt><dd className="text-gray-900">{lead.origin_country}</dd></>}
              {lead.source_name  && <><dt className="text-gray-400">Source</dt><dd className="text-gray-900">{lead.source_name}</dd></>}
              {lead.rep_name     && <><dt className="text-gray-400">Rep / Agent</dt><dd className="text-gray-900">{lead.rep_name}</dd></>}
              {lead.linkedin_url && (
                <>
                  <dt className="text-gray-400">LinkedIn</dt>
                  <dd>
                    <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer"
                      className="text-indigo-600 hover:underline text-sm">
                      View profile →
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </div>

          {/* Deal info */}
          {(budget || lead.timeline_months || lead.property_address || lead.contract_value) && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="font-semibold text-gray-900 mb-3">Deal Info</h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {budget              && <><dt className="text-gray-400">Budget</dt><dd className="font-semibold text-gray-900">{budget}</dd></>}
                {lead.timeline_months && <><dt className="text-gray-400">Timeline</dt><dd className="text-gray-900">{lead.timeline_months} months</dd></>}
                {lead.property_address && <><dt className="text-gray-400">Property</dt><dd className="text-gray-900">{lead.property_address}</dd></>}
                {lead.contract_value && <><dt className="text-gray-400">Contract Value</dt><dd className="font-bold text-gray-900">{fmtMoney(lead.contract_value)}</dd></>}
              </dl>
            </div>
          )}

          {/* AI Summary */}
          {lead.ai_summary && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5">
              <h3 className="font-semibold text-indigo-900 mb-2">AI Summary</h3>
              <p className="text-sm text-indigo-800 leading-relaxed">{lead.ai_summary}</p>
            </div>
          )}

          {/* Talking Points */}
          {points.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="font-semibold text-gray-900 mb-3">ISA Talking Points</h3>
              <ul className="space-y-2">
                {points.map((pt, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-indigo-500 font-bold mt-0.5 flex-shrink-0">→</span>
                    {pt}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Inbound message */}
          {lead.inbound_message && (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-5">
              <h3 className="font-semibold text-gray-900 mb-2">Inbound Message</h3>
              <p className="text-sm text-gray-600 italic">"{lead.inbound_message}"</p>
              {lead.inbound_channel && (
                <p className="text-xs text-gray-400 mt-1">via {lead.inbound_channel}</p>
              )}
            </div>
          )}

          {/* Touch History */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <h3 className="font-semibold text-gray-900 mb-4">
              Touch History ({touches?.length ?? 0})
            </h3>
            {!touches?.length ? (
              <p className="text-sm text-gray-400">No touches logged yet.</p>
            ) : (
              <div className="space-y-4">
                {(touches as Touch[]).map(t => (
                  <div key={t.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="w-2 h-2 rounded-full bg-indigo-400 mt-1.5 flex-shrink-0" />
                      <div className="w-px flex-1 bg-gray-100 mt-1" />
                    </div>
                    <div className="pb-4 flex-1">
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="font-semibold text-gray-900">
                          #{t.touch_number} {t.channel}
                        </span>
                        {t.outcome && (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded capitalize">
                            {t.outcome.replace(/_/g, ' ')}
                          </span>
                        )}
                        {t.isa_name && (
                          <span className="text-xs text-gray-400">{t.isa_name}</span>
                        )}
                        <span className="text-xs text-gray-300 ml-auto">
                          {fmtDateTime(t.touched_at)}
                        </span>
                      </div>
                      {t.notes && (
                        <p className="text-sm text-gray-500 mt-1">{t.notes}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column: scores + log touch */}
        <div className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <h3 className="font-semibold text-gray-900 mb-4">Lead Scores</h3>
            <div className="space-y-4">
              <ScoreBar label="BANT" value={lead.bant_score} max={12} />
              <ScoreBar label="Motivation" value={lead.motivation_score} max={5} />
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <h3 className="font-semibold text-gray-900 mb-3">Auto Cadence</h3>
            <CadenceStatus
              step={lead.cadence_step ?? 0}
              lastCadenceAt={lead.last_cadence_at}
              paused={lead.cadence_paused ?? false}
            />
          </div>

          <LogTouchForm leadId={lead.id} />
        </div>
      </div>
    </div>
  );
}
