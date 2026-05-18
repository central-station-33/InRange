export function ScoreBar({ value, max, label }: { value?: number | null; max: number; label: string }) {
  const pct = value != null ? Math.round((value / max) * 100) : 0;
  const color =
    pct >= 75 ? 'bg-green-500' :
    pct >= 50 ? 'bg-yellow-500' :
    pct >= 33 ? 'bg-orange-400' :
                'bg-red-400';
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label}</span>
        <span className="font-medium text-gray-700">{value ?? '—'} / {max}</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all duration-300`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
