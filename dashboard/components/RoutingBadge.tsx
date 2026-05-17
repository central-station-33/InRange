export function RoutingBadge({ routing }: { routing: string }) {
  const styles: Record<string, string> = {
    hot:     'bg-red-100 text-red-700 border-red-200',
    warm:    'bg-orange-100 text-orange-700 border-orange-200',
    nurture: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    cold:    'bg-slate-100 text-slate-600 border-slate-200',
    new:     'bg-blue-100 text-blue-700 border-blue-200',
  };
  const cls = styles[routing] ?? styles.new;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border uppercase tracking-wide ${cls}`}>
      {routing}
    </span>
  );
}
