export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    new:             'bg-blue-100 text-blue-700',
    attempting:      'bg-yellow-100 text-yellow-700',
    contacted:       'bg-indigo-100 text-indigo-700',
    appointment_set: 'bg-green-100 text-green-700',
    dead:            'bg-red-100 text-red-600',
    closed:          'bg-purple-100 text-purple-700',
  };
  const cls = styles[status] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
