import Link from "next/link";

const COMPARISON_ROWS: Array<{ metric: string; values: [string, string, string, string] }> = [
  {
    metric: "Speed to dispatch",
    values: ["Hours to days", "Days", "Fast, but unvetted", "Instant (automated matching)"],
  },
  {
    metric: "Set-ready training",
    values: ["No (assumed)", "No", "No", "Yes — certified micro-course"],
  },
  {
    metric: "NY/NJ tax proofing",
    values: ["Manual", "No", "No", "Yes — pre-verified residency docs"],
  },
  {
    metric: "Payroll / workers' comp",
    values: ["Included", "No", "No", "Tracked, W-2/1099 ready"],
  },
  {
    metric: "Overhead / scalability",
    values: ["Low — high office overhead", "High tech, no vetting", "None", "Virtual, managed SaaS"],
  },
];

const COLUMN_HEADERS = ["Traditional Agencies", "Job Boards", "Informal Texting / FB", "InRange Crew"];

export default function Home() {
  return (
    <div className="flex flex-col">
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-indigo-600">
            Hollywood East · NY / NJ
          </p>
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
            Vetted, set-ready PAs and Coordinators — dispatched instantly.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
            InRange Crew replaces the 10&nbsp;PM Facebook post and the unmanaged job board with a
            tech-enabled staffing platform: tax-credit-verified residency, certified on-set
            training, and automatic matching for every call time in the NY/NJ corridor.
          </p>
          <div className="mt-8 flex justify-center gap-4">
            <Link
              href="/signup?role=producer"
              className="rounded-md bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              I need crew — Post a call time
            </Link>
            <Link
              href="/signup?role=pa"
              className="rounded-md border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              I&apos;m a PA — Get set-ready
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center text-2xl font-semibold text-slate-900">
          Everyone else in this market is stuck between two extremes
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-slate-600">
          Full-service agencies with high overhead, or self-serve job boards and Facebook groups
          with zero vetting. InRange Crew sits at the intersection of technology, training, and
          tax-credit compliance.
        </p>

        <div className="mt-10 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-4 py-3 font-medium text-slate-500">Feature / Metric</th>
                {COLUMN_HEADERS.map((h, i) => (
                  <th
                    key={h}
                    className={`px-4 py-3 font-medium ${
                      i === 3 ? "text-indigo-700" : "text-slate-500"
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.metric} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-slate-800">{row.metric}</td>
                  {row.values.map((v, i) => (
                    <td
                      key={i}
                      className={`px-4 py-3 ${i === 3 ? "font-medium text-indigo-700" : "text-slate-600"}`}
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-white">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-16 sm:grid-cols-3">
          <div>
            <div className="mb-3 text-sm font-semibold text-indigo-600">01</div>
            <h3 className="text-lg font-semibold text-slate-900">PAs get set-ready</h3>
            <p className="mt-2 text-sm text-slate-600">
              PAs build a profile, upload NY/NJ residency documentation for tax-credit compliance,
              and pass a certified on-set micro-course before they&apos;re eligible for dispatch.
            </p>
          </div>
          <div>
            <div className="mb-3 text-sm font-semibold text-indigo-600">02</div>
            <h3 className="text-lg font-semibold text-slate-900">Producers post a call time</h3>
            <p className="mt-2 text-sm text-slate-600">
              A UPM or Key PA posts a role, location, and call time. The platform instantly
              invites every matching, verified, set-ready PA — no manual texting required.
            </p>
          </div>
          <div>
            <div className="mb-3 text-sm font-semibold text-indigo-600">03</div>
            <h3 className="text-lg font-semibold text-slate-900">First accept, confirmed</h3>
            <p className="mt-2 text-sm text-slate-600">
              The first PA to accept is locked in and the roster updates in real time — with
              verified compliance status visible to the production office.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
