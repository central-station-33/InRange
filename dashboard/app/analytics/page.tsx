import { getAdminClient } from '@/lib/supabase';
import { SegmentROI } from '@/lib/types';

export const revalidate = 300;

function fmtMoney(n?: number | null) {
  if (!n) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

export default async function AnalyticsPage() {
  const supabase = getAdminClient();

  const [{ data: roi }, { data: leads }] = await Promise.all([
    supabase.from('segment_roi').select('*'),
    supabase.from('isa_leads')
      .select('outreach_status, routing, market')
      .not('outreach_status', 'in', '("dead","closed")'),
  ]);

  const total    = leads?.length ?? 0;
  const hot      = leads?.filter(l => l.routing === 'hot').length  ?? 0;
  const warm     = leads?.filter(l => l.routing === 'warm').length ?? 0;
  const nyc      = leads?.filter(l => l.market === 'nyc').length   ?? 0;
  const nj       = leads?.filter(l => l.market === 'nj').length    ?? 0;
  const totalRev = (roi as SegmentROI[] | null)?.reduce((s, r) => s + (r.total_revenue_to_you ?? 0), 0) ?? 0;
  const totalAppt = (roi as SegmentROI[] | null)?.reduce((s, r) => s + (r.appointments ?? 0), 0) ?? 0;

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        <p className="text-sm text-gray-500 mt-1">Pipeline performance — NYC and NJ</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Active Leads',      value: total,              color: 'text-gray-900' },
          { label: 'Hot Leads',         value: hot,                color: 'text-red-600' },
          { label: 'Appointments Set',  value: totalAppt,          color: 'text-green-600' },
          { label: 'Revenue Pipeline',  value: fmtMoney(totalRev), color: 'text-indigo-600' },
        ].map(s => (
          <div key={s.label} className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="text-xs text-gray-500 mb-1">{s.label}</div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Market + Routing split */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h3 className="font-semibold text-gray-900 mb-3">Market Split</h3>
          <div className="flex gap-8 text-sm mb-3">
            <div>
              <div className="text-3xl font-bold text-indigo-600">{nyc}</div>
              <div className="text-gray-500 text-xs mt-0.5">NYC</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-500">{nj}</div>
              <div className="text-gray-500 text-xs mt-0.5">NJ</div>
            </div>
          </div>
          {total > 0 && (
            <div className="flex rounded-full overflow-hidden h-2 gap-px">
              <div className="bg-indigo-500 transition-all" style={{ width: `${Math.round((nyc / total) * 100)}%` }} />
              <div className="bg-orange-400 flex-1" />
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h3 className="font-semibold text-gray-900 mb-3">Routing Split</h3>
          <div className="flex gap-6 text-sm">
            {[
              { label: 'Hot',    value: hot,                    color: 'text-red-600' },
              { label: 'Warm',   value: warm,                   color: 'text-orange-500' },
              { label: 'Other',  value: total - hot - warm,     color: 'text-gray-400' },
            ].map(r => (
              <div key={r.label}>
                <div className={`text-3xl font-bold ${r.color}`}>{r.value}</div>
                <div className="text-gray-500 text-xs mt-0.5">{r.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Segment ROI */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Segment ROI</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                {['Segment', 'Market', 'Source', 'Leads', 'Appts', 'Closed', 'Appt Rate', 'Revenue'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {!roi?.length ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                    No closed deals yet — data will appear once leads convert.
                  </td>
                </tr>
              ) : (roi as SegmentROI[]).map((row, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900 capitalize">{row.segment?.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3 text-xs font-bold text-gray-400 uppercase">{row.market}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{row.commission_source}</td>
                  <td className="px-4 py-3 text-gray-900">{row.leads_total}</td>
                  <td className="px-4 py-3 text-gray-900">{row.appointments}</td>
                  <td className="px-4 py-3 text-gray-900">{row.closed}</td>
                  <td className="px-4 py-3">
                    <span className={`font-semibold ${(row.appt_rate_pct ?? 0) >= 20 ? 'text-green-600' : 'text-gray-700'}`}>
                      {row.appt_rate_pct ?? 0}%
                    </span>
                  </td>
                  <td className="px-4 py-3 font-semibold text-gray-900">{fmtMoney(row.total_revenue_to_you)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
