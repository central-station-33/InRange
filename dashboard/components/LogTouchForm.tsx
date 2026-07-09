'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const CHANNELS = ['call', 'sms', 'email', 'in_person'];
const OUTCOMES = [
  { value: 'no_answer',          label: 'No Answer' },
  { value: 'voicemail',          label: 'Voicemail' },
  { value: 'interested',         label: 'Interested' },
  { value: 'callback_requested', label: 'Callback Requested' },
  { value: 'appointment_set',    label: 'Appointment Set ✓' },
  { value: 'not_interested',     label: 'Not Interested' },
  { value: 'wrong_number',       label: 'Wrong Number' },
];

const INPUT = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500';

export function LogTouchForm({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [channel, setChannel] = useState('call');
  const [outcome, setOutcome] = useState('no_answer');
  const [notes, setNotes]     = useState('');
  const [isaName, setIsaName] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError]     = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/log-touch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, channel, outcome, notes, isa_name: isaName }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Request failed');
      setSuccess(true);
      setNotes('');
      setTimeout(() => { setSuccess(false); router.refresh(); }, 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="font-semibold text-gray-900 mb-4">Log Touch</h3>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Channel</label>
          <select value={channel} onChange={e => setChannel(e.target.value)} className={INPUT}>
            {CHANNELS.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Outcome</label>
          <select value={outcome} onChange={e => setOutcome(e.target.value)} className={INPUT}>
            {OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div className="mb-3">
        <label className="block text-xs text-gray-500 mb-1">ISA Name</label>
        <input
          value={isaName}
          onChange={e => setIsaName(e.target.value)}
          placeholder="Your name"
          className={INPUT}
        />
      </div>
      <div className="mb-4">
        <label className="block text-xs text-gray-500 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={3}
          placeholder="Call summary, next steps, objections…"
          className={`${INPUT} resize-none`}
        />
      </div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
      <button
        type="submit"
        disabled={loading || success}
        className={`w-full py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60 ${
          success
            ? 'bg-green-600 text-white'
            : 'bg-indigo-600 hover:bg-indigo-700 text-white'
        }`}
      >
        {success ? 'Logged ✓' : loading ? 'Saving…' : 'Log Touch'}
      </button>
    </form>
  );
}
