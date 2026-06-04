// ============================================================
// InRange Retool – JavaScript Transformers
// Create each block below as a separate JS Query in Retool.
// ============================================================

// ─────────────────────────────────────────────────────────────
// TRANSFORMER: formatStatsRow
// Input: get_pipeline_stats.data[0]
// Output: object used by stat cards
// ─────────────────────────────────────────────────────────────
const raw = get_pipeline_stats.data[0];

return {
  tier1:              raw.tier1             ?? 0,
  tier2:              raw.tier2             ?? 0,
  tier3:              raw.tier3             ?? 0,
  tier4:              raw.tier4             ?? 0,
  totalLeads:         raw.total_leads       ?? 0,
  newToday:           raw.new_today         ?? 0,
  pendingEnrichment:  raw.pending_enrichment ?? 0,
  enriched:           raw.enriched          ?? 0,
  enrichmentPct: raw.total_leads > 0
    ? Math.round((raw.enriched / raw.total_leads) * 100)
    : 0,
};

// ─────────────────────────────────────────────────────────────
// TRANSFORMER: formatLeadsTable
// Input: get_leads_table.data
// Output: rows array for leadsTable component
// ─────────────────────────────────────────────────────────────
return get_leads_table.data.map(row => ({
  ...row,
  composite_score:         row.composite_score         ?? '—',
  distress_score:          row.distress_score          ?? '—',
  equity:                  row.equity != null ? `$${Number(row.equity).toLocaleString()}` : '—',
  equity_percentage:       row.equity_percentage != null ? `${row.equity_percentage}%` : '—',
  estimated_arv:           row.estimated_arv != null ? `$${Number(row.estimated_arv).toLocaleString()}` : '—',
  amount_owed:             row.amount_owed != null ? `$${Number(row.amount_owed).toLocaleString()}` : '—',
  distress_indicators:     row.distress_indicators
                             ? Object.entries(row.distress_indicators)
                                 .filter(([, v]) => v)
                                 .map(([k]) => k.replace(/_/g, ' '))
                                 .join(', ') || '—'
                             : '—',
  created_at: new Date(row.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }),
}));

// ─────────────────────────────────────────────────────────────
// TRANSFORMER: formatPropertyDetail
// Input: get_property_detail.data[0]
// Output: flat object for detail panel text/labels
// ─────────────────────────────────────────────────────────────
const p = get_property_detail.data[0];
if (!p) return null;

const fmt$ = v => v != null ? `$${Number(v).toLocaleString()}` : '—';
const fmt1 = v => v != null ? v.toFixed(1) : '—';

return {
  fullAddress: [p.address, p.city, p.state, p.zip].filter(Boolean).join(', '),
  priorityTier: p.priority_tier ?? '—',
  compositeScore: fmt1(p.composite_score),
  distressScore:  fmt1(p.distress_score),
  dealQuality:    fmt1(p.deal_quality_score),
  contactLikelihood: fmt1(p.contact_likelihood_score),
  timelineUrgency:   fmt1(p.timeline_urgency_score),
  ownerName:  p.owner_name  ?? '—',
  ownerPhone: p.owner_phone ?? '—',
  ownerEmail: p.owner_email ?? '—',
  estimatedARV:  fmt$(p.estimated_arv),
  amountOwed:    fmt$(p.amount_owed),
  askingPrice:   fmt$(p.asking_price),
  equity:        fmt$(p.equity),
  equityPct:     p.equity_percentage != null ? `${p.equity_percentage}%` : '—',
  belowMarket:   p.below_market_percentage != null ? `${p.below_market_percentage}%` : '—',
  enrichmentStatus: p.enrichment_status ?? 'pending',
  aiAnalysis: p.ai_analysis?.summary ?? p.ai_analysis ?? '—',
  distressFlags: p.distress_indicators
    ? Object.entries(p.distress_indicators).filter(([,v]) => v).map(([k]) => k.replace(/_/g, ' '))
    : [],
  dealStatus:     p.deal_status   ?? 'None',
  dealType:       p.deal_type     ?? '—',
  offerPrice:     fmt$(p.offer_price),
  contractPrice:  fmt$(p.contract_price),
  profitEstimate: fmt$(p.profit_estimate),
  closeDate: p.close_date ? new Date(p.close_date).toLocaleDateString() : '—',
};

// ─────────────────────────────────────────────────────────────
// TRANSFORMER: formatSourceBreakdown
// Input: get_source_breakdown.data
// Output: datasets for bar chart component
// ─────────────────────────────────────────────────────────────
const rows = get_source_breakdown.data;
const LABELS = {
  nyc_acris_lis_pendens:  'ACRIS Lis Pendens',
  nyc_311_complaints:     'NYC 311',
  nyc_hpd_violations:     'HPD Violations',
  nyc_tax_liens:          'Tax Liens',
  nyc_acris_estate_deeds: 'Estate Deeds',
  nyc_acris_divorce_deeds:'Divorce Deeds',
  nyc_tax_roll:           'Tax Roll',
  hud_reo:                'HUD REO',
  hud_multifamily:        'HUD Multifamily',
  ny_state_assessment:    'NY Assessment',
};

return {
  labels: rows.map(r => LABELS[r.source] ?? r.source),
  values: rows.map(r => Number(r.count)),
  lastSeen: rows.map(r =>
    r.last_seen
      ? new Date(r.last_seen).toLocaleDateString()
      : '—'
  ),
};

// ─────────────────────────────────────────────────────────────
// TRANSFORMER: formatTierTrend
// Input: get_tier_trend.data
// Output: multi-series dataset for line chart
// ─────────────────────────────────────────────────────────────
const rows = get_tier_trend.data;
const tiers = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'];
const days  = [...new Set(rows.map(r => r.day))].sort();

const series = tiers.map(tier => ({
  name: tier,
  data: days.map(day => {
    const match = rows.find(r => r.day === day && r.priority_tier === tier);
    return match ? Number(match.count) : 0;
  }),
}));

return { labels: days.map(d => new Date(d).toLocaleDateString()), series };

// ─────────────────────────────────────────────────────────────
// TRANSFORMER: tierBadgeColor
// Input: any cell with a priority_tier value
// Use inline in table column mappings: {{ tierBadgeColor(row.priority_tier) }}
// ─────────────────────────────────────────────────────────────
function tierBadgeColor(tier) {
  const map = {
    'Tier 1': '#dc2626',  // red
    'Tier 2': '#ea580c',  // orange
    'Tier 3': '#ca8a04',  // yellow
    'Tier 4': '#16a34a',  // green
  };
  return map[tier] ?? '#6b7280';
}

// ─────────────────────────────────────────────────────────────
// TRANSFORMER: enrichmentBadgeColor
// Use inline: {{ enrichmentBadgeColor(row.enrichment_status) }}
// ─────────────────────────────────────────────────────────────
function enrichmentBadgeColor(status) {
  const map = {
    enriched:    '#16a34a',
    pending:     '#ca8a04',
    failed:      '#dc2626',
    in_progress: '#2563eb',
  };
  return map[status] ?? '#6b7280';
}
