import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createGig } from "@/app/actions/gigs";
import type { Dispatch, Gig, Profile } from "@/lib/types/database";

function formatCallTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_STYLES: Record<string, string> = {
  open: "bg-amber-50 text-amber-800",
  filled: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-500",
};

type GigWithDispatches = Gig & {
  dispatches: Array<Dispatch & { profiles: Pick<Profile, "full_name" | "phone"> | null }>;
};

export default async function ProducerDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "producer") redirect("/");

  const { data: gigs } = await supabase
    .from("gigs")
    .select("*, dispatches(*, profiles(full_name, phone))")
    .eq("producer_id", user.id)
    .order("created_at", { ascending: false });

  const typedGigs = (gigs ?? []) as unknown as GigWithDispatches[];

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-slate-900">Post a call time</h1>

      {params.error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{params.error}</p>
      )}
      {params.warning && (
        <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {params.warning}
        </p>
      )}
      {params.created && (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Gig posted — matching Set-Ready PAs have been invited.
        </p>
      )}

      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <form action={createGig} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700">Title</label>
            <input
              name="title"
              required
              placeholder="Set PA — Feature, Day 12"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Role</label>
            <select
              name="role_type"
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="set_pa">Set PA</option>
              <option value="office_pa">Office PA</option>
              <option value="coordinator">Coordinator</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">State</label>
            <select
              name="location_state"
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="NY">New York</option>
              <option value="NJ">New Jersey</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700">Location detail</label>
            <input
              name="location_detail"
              placeholder="Brooklyn Navy Yard, Stage 3"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Call time</label>
            <input
              name="call_time"
              type="datetime-local"
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Headcount needed</label>
            <input
              name="headcount"
              type="number"
              min={1}
              defaultValue={1}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Rate</label>
            <input
              name="rate_amount"
              type="number"
              step="0.01"
              min="0"
              placeholder="200"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Rate unit</label>
            <select
              name="rate_unit"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="day">Per day</option>
              <option value="hour">Per hour</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700">Description</label>
            <textarea
              name="description"
              rows={3}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Post & dispatch to matching PAs
            </button>
          </div>
        </form>
      </section>

      <h2 className="mt-10 text-lg font-semibold text-slate-900">Your gigs</h2>
      <div className="mt-4 space-y-4">
        {typedGigs.length === 0 && (
          <p className="text-sm text-slate-500">No gigs posted yet.</p>
        )}
        {typedGigs.map((gig) => (
          <div key={gig.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-slate-900">{gig.title}</p>
                <p className="text-sm text-slate-600">
                  {gig.location_state} · {gig.location_detail ?? "Location TBD"} ·{" "}
                  {formatCallTime(gig.call_time)}
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[gig.status]}`}
              >
                {gig.status}
              </span>
            </div>

            <div className="mt-3 border-t border-slate-100 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Dispatch status ({gig.dispatches?.length ?? 0} invited)
              </p>
              <ul className="mt-2 space-y-1">
                {(gig.dispatches ?? []).map((d) => (
                  <li key={d.id} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{d.profiles?.full_name ?? "PA"}</span>
                    <span className="text-slate-500">
                      {d.status}
                      {d.status === "accepted" && d.profiles?.phone ? ` · ${d.profiles.phone}` : ""}
                    </span>
                  </li>
                ))}
                {(gig.dispatches ?? []).length === 0 && (
                  <li className="text-sm text-slate-500">
                    No Set-Ready PAs matched this role/state yet.
                  </li>
                )}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
