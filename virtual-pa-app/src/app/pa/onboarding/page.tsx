import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updatePaProfile, uploadTaxDoc, submitCourse } from "@/app/actions/pa";
import { COURSE_QUESTIONS, COURSE_PASS_THRESHOLD } from "@/lib/course";
import type { RoleType } from "@/lib/types/database";

const ROLE_TYPE_OPTIONS: Array<{ value: RoleType; label: string }> = [
  { value: "set_pa", label: "Set PA" },
  { value: "office_pa", label: "Office PA" },
  { value: "coordinator", label: "Coordinator" },
  { value: "other", label: "Other" },
];

export default async function PaOnboardingPage({
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
  if (profile?.role !== "pa") redirect("/");

  const { data: pa } = await supabase
    .from("pa_profiles")
    .select("*")
    .eq("profile_id", user.id)
    .maybeSingle();

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-slate-900">My PA Profile</h1>

      <div
        className={`mt-4 rounded-md px-4 py-3 text-sm font-medium ${
          pa?.set_ready
            ? "bg-emerald-50 text-emerald-700"
            : "bg-amber-50 text-amber-800"
        }`}
      >
        {pa?.set_ready
          ? "You're Set-Ready — eligible for gig dispatch."
          : "Not yet Set-Ready. Verified tax residency + a passed micro-course are both required."}
      </div>

      {params.error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{params.error}</p>
      )}
      {params.saved && (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Profile saved.
        </p>
      )}
      {params.doc_uploaded && (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Document uploaded — pending admin review.
        </p>
      )}
      {params.course_score && (
        <p
          className={`mt-4 rounded-md px-3 py-2 text-sm ${
            Number(params.course_score) / 100 >= COURSE_PASS_THRESHOLD
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          Course score: {params.course_score}%
          {Number(params.course_score) / 100 >= COURSE_PASS_THRESHOLD
            ? " — passed."
            : ` — needs ${Math.round(COURSE_PASS_THRESHOLD * 100)}% to pass. Try again below.`}
        </p>
      )}

      <section className="mt-8 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-900">Profile details</h2>
        <form action={updatePaProfile} className="mt-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700">
              Home state (tax residency)
            </label>
            <select
              name="home_state"
              defaultValue={pa?.home_state ?? ""}
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="" disabled>
                Select state
              </option>
              <option value="NY">New York</option>
              <option value="NJ">New Jersey</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Role types you cover</label>
            <div className="mt-2 flex flex-wrap gap-4">
              {ROLE_TYPE_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="role_types"
                    value={opt.value}
                    defaultChecked={pa?.role_types?.includes(opt.value)}
                    className="h-4 w-4"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Years of experience</label>
            <input
              name="years_experience"
              type="number"
              step="0.5"
              min="0"
              defaultValue={pa?.years_experience ?? 0}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Payroll classification</label>
            <select
              name="payroll_class"
              defaultValue={pa?.payroll_class ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Not sure yet</option>
              <option value="w2">W-2</option>
              <option value="1099">1099</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Bio</label>
            <textarea
              name="bio"
              rows={3}
              defaultValue={pa?.bio ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Save profile
          </button>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-900">Tax residency verification</h2>
        <p className="mt-1 text-sm text-slate-600">
          Status:{" "}
          <span className="font-medium">{pa?.tax_residency_status ?? "unsubmitted"}</span>
        </p>
        <form action={uploadTaxDoc} className="mt-4 flex items-center gap-3">
          <input
            name="tax_doc"
            type="file"
            required
            accept="application/pdf,image/*"
            className="text-sm"
          />
          <button
            type="submit"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            Upload
          </button>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-900">Set-Ready certified micro-course</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pass with {Math.round(COURSE_PASS_THRESHOLD * 100)}%+ to unlock dispatch eligibility.
          {pa?.course_score !== null && pa?.course_score !== undefined && (
            <> Last score: {pa.course_score}%.</>
          )}
        </p>
        <form action={submitCourse} className="mt-4 space-y-5">
          {COURSE_QUESTIONS.map((q, qi) => (
            <fieldset key={q.id}>
              <legend className="text-sm font-medium text-slate-800">
                {qi + 1}. {q.prompt}
              </legend>
              <div className="mt-2 space-y-1">
                {q.options.map((opt, oi) => (
                  <label key={oi} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="radio" name={q.id} value={oi} required className="h-4 w-4" />
                    {opt}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Submit answers
          </button>
        </form>
      </section>
    </div>
  );
}
