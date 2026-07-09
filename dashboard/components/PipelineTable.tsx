'use client';
import { useState, useMemo } from 'react';
import Link from 'next/link';
import { PipelineLead } from '@/lib/types';
import { RoutingBadge } from './RoutingBadge';
import { StatusBadge } from './StatusBadge';

const SEGMENTS = [
  'athlete', 'investor', 'motivated_seller', 'first_time_buyer',
  'divorce', 'empty_nester', 'developer', 'expat_relocation', 'film_tv',
];

const SELECT = 'border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

function relativeTime(dateStr?: string | null) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function bantColor(score?: number | null) {
  if (score == null) return 'text-gray-400';
  if (score >= 9) return 'text-green-600 font-semibold';
  if (score >= 7) return 'text-yellow-600 font-semibold';
  if (score >= 4) return 'text-orange-500';
  return 'text-red-500';
}

export function PipelineTable({ leads }: { leads: PipelineLead[] }) {
  const [search, setSearch]   = useState('');
  const [routing, setRouting] = useState('');
  const [segment, setSegment] = useState('');
  const [market, setMarket]   = useState('');
  const [status, setStatus]   = useState('');

  const stats = useMemo(() => ({
    total: leads.length,
    hot:   leads.filter(l => l.routing === 'hot').length,
    warm:  leads.filter(l => l.routing === 'warm').length,
    appt:  leads.filter(l => l.outreach_status === 'appointment_set').length,
  }), [leads]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return leads.filter(l => {
      if (q && !`${l.full_name ?? ''} ${l.entity_name ?? ''} ${l.phone ?? ''} ${l.email ?? ''}`.toLowerCase().includes(q)) return false;
      if (routing && l.routing !== routing) return false;
      if (segment && l.segment !== segment) return false;
      if (market && l.market !== market) return false;
      if (status && l.outreach_status !== status) return false;
      return true;
    });
  }, [leads, search, routing, segment, market, status]);

  const hasFilters = search || routing || segment || market || status;

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Active Leads',   value: stats.total, color: 'text-gray-900' },
          { label: 'Hot',            value: stats.hot,   color: 'text-red-600' },
          { label: 'Warm',           value: stats.warm,  color: 'text-orange-500' },
          { label: 'Appointments',   value: stats.appt,  color: 'text-green-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-xs text-gray-500 mb-1">{s.label}</div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4 flex flex-wrap gap-3 items-center">
        <input
          type="search"
          placeholder="Search name, phone, email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <select value={routing} onChange={e => setRouting(e.target.value)} className={SELECT}>
          <option value="">All Routing</option>
          {['hot', 'warm', 'nurture', 'cold', 'new'].map(r => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select value={segment} onChange={e => setSegment(e.target.value)} className={SELECT}>
          <option value="">All Segments</option>
          {SEGMENTS.map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select value={market} onChange={e => setMarket(e.target.value)} className={SELECT}>
          <option value="">NYC + NJ</option>
          <option value="nyc">NYC</option>
          <option value="nj">NJ</option>
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} className={SELECT}>
          <option value="">All Status</option>
          {['new', 'attempting', 'contacted', 'appointment_set'].map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setRouting(''); setSegment(''); setMarket(''); setStatus(''); }}
            className="text-sm text-gray-400 hover:text-gray-600 px-1"
          >
            Clear ×
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 text-xs text-gray-400">
          {filtered.length} lead{filtered.length !== 1 ? 's' : ''}
          {hasFilters && ` (filtered from ${leads.length})`}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                {['Name', 'Segment', 'Mkt', 'BANT', 'Motiv', 'Routing', 'Status', 'Last Touch', 'Touches'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400 text-sm">
                    {hasFilters ? 'No leads match your filters.' : 'No active leads yet.'}
                  </td>
                </tr>
              ) : filtered.map(lead => (
                <tr key={lead.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/leads/${lead.id}`} className="block group">
                      <div className="font-medium text-gray-900 group-hover:text-indigo-600 transition-colors">
                        {lead.full_name ?? lead.entity_name ?? '—'}
                      </div>
                      {lead.phone && <div className="text-xs text-gray-400 mt-0.5">{lead.phone}</div>}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    <Link href={`/leads/${lead.id}`} className="block capitalize">
                      {lead.segment?.replace(/_/g, ' ')}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/leads/${lead.id}`} className="block">
                      <span className="uppercase text-xs font-bold text-gray-400">{lead.market}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/leads/${lead.id}`} className="block">
                      <span className={bantColor(lead.bant_score)}>{lead.bant_score ?? '—'}/12</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/leads/${lead.id}`} className="block">
                      <span className={bantColor(lead.motivation_score != null ? lead.motivation_score * 2.4 : null)}>
                        {lead.motivation_score ?? '—'}/5
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/leads/${lead.id}`} className="block">
                      <RoutingBadge routing={lead.routing ?? 'new'} />
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/leads/${lead.id}`} className="block">
                      <StatusBadge status={lead.outreach_status} />
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                    <Link href={`/leads/${lead.id}`} className="block">
                      {relativeTime(lead.last_touched_at)}
                      {lead.last_outcome && (
                        <span className="block text-gray-300">{lead.last_outcome.replace(/_/g, ' ')}</span>
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-600">
                    <Link href={`/leads/${lead.id}`} className="block">
                      {lead.touch_count ?? 0}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
