import { getAdminClient } from '@/lib/supabase';
import { PipelineLead } from '@/lib/types';
import { PipelineTable } from '@/components/PipelineTable';

export const revalidate = 30;

export default async function PipelinePage() {
  const supabase = getAdminClient();

  const { data: leads, error } = await supabase
    .from('isa_pipeline')
    .select('*')
    .not('outreach_status', 'in', '("dead","closed")')
    .order('bant_score', { ascending: false, nullsFirst: false });

  if (error) {
    return (
      <div className="text-red-600 text-sm p-4 bg-red-50 rounded-xl">
        Failed to load pipeline: {error.message}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">ISA Pipeline</h1>
        <p className="text-sm text-gray-500 mt-1">Active leads — NYC and NJ</p>
      </div>
      <PipelineTable leads={(leads ?? []) as PipelineLead[]} />
    </div>
  );
}
