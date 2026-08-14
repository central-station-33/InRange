import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { acceptDispatch, declineDispatch } from "@/app/actions/gigs";
import type { Gig } from "@/lib/types/database";

function formatCallTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function PaDashboardPage({
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

  const { data: pa } = await supabase
    .from("pa_profiles")
    .select("set_ready")
    .eq("profile_id", user.id)
    .maybeSingle();

  const { data: dispatches } = await supabase
    .from("dispatches")
    .select("id, status, created_at, gigs(*)")
    .eq("pa_id", user.id)
    .order("created_at", { ascending: false });

  const invited = (dispatches ?? []).filter((d) => d.status === "invited");
  const active = (dispatches ?? []).filter((d) => d.status === "accepted" || d.status === "confirmed");
  const past = (dispatches ?? []).filter((d) => d.status === "declined" || d.status === "expired");

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Your gigs</h1>
        {!pa?.set_ready && (
          <Link href="/pa/onboarding" className="text-sm font-medium text-indigo-600">
            Finish getting Set-Ready →
          </Link>
        )}
      </div>

      {params.error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{params.error}</p>
      )}
      {params.accepted && (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Gig confirmed — see it under Active below.
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          New invites ({invited.length})
        </h2>
        <div className="mt-3 space-y-3">
          {invited.length === 0 && (
            <p className="text-sm text-slate-500">
              No open invites right now. You&apos;ll see matching gigs here the moment a producer
              posts one in your state and role.
            </p>
          )}
          {invited.map((d) => {
            const gig = d.gigs as unknown as Gig;
            return (
              <div key={d.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-slate-900">{gig.title}</p>
                    <p className="text-sm text-slate-600">
                      {gig.location_state} · {gig.location_detail ?? "Location TBD"} ·{" "}
                      {formatCallTime(gig.call_time)}
                    </p>
                    {gig.rate_amount && (
                      <p className="text-sm text-slate-600">
                        ${gig.rate_amount}/{gig.rate_unit}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <form action={acceptDispatch.bind(null, d.id)}>
                      <button className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500">
                        Accept
                      </button>
                    </form>
                    <form action={declineDispatch.bind(null, d.id)}>
                      <button className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
                        Decline
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Active ({active.length})
        </h2>
        <div className="mt-3 space-y-3">
          {active.length === 0 && <p className="text-sm text-slate-500">Nothing confirmed yet.</p>}
          {active.map((d) => {
            const gig = d.gigs as unknown as Gig;
            return (
              <div key={d.id} className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <p className="font-medium text-slate-900">{gig.title}</p>
                <p className="text-sm text-slate-600">
                  {gig.location_state} · {gig.location_detail ?? "Location TBD"} ·{" "}
                  {formatCallTime(gig.call_time)}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {past.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">History</h2>
          <div className="mt-3 space-y-2">
            {past.map((d) => {
              const gig = d.gigs as unknown as Gig;
              return (
                <div key={d.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-500">
                  {gig.title} — {d.status}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
