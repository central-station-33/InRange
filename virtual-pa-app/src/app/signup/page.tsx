import { signUp } from "@/app/actions/auth";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; error?: string }>;
}) {
  const params = await searchParams;
  const defaultRole = params.role === "producer" ? "producer" : "pa";

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold text-slate-900">Create your account</h1>
      <p className="mt-1 text-sm text-slate-600">
        Sign up as a Producer/UPM to post gigs, or as a PA/Coordinator to get dispatched.
      </p>

      {params.error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{params.error}</p>
      )}

      <form action={signUp} className="mt-6 space-y-4">
        <fieldset className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="role"
              value="pa"
              defaultChecked={defaultRole === "pa"}
              className="h-4 w-4"
            />
            I&apos;m a PA / Coordinator
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="role"
              value="producer"
              defaultChecked={defaultRole === "producer"}
              className="h-4 w-4"
            />
            I&apos;m a Producer / UPM
          </label>
        </fieldset>

        <div>
          <label className="block text-sm font-medium text-slate-700">Full name</label>
          <input
            name="full_name"
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Phone</label>
          <input
            name="phone"
            type="tel"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Email</label>
          <input
            name="email"
            type="email"
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Password</label>
          <input
            name="password"
            type="password"
            required
            minLength={6}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Create account
        </button>
      </form>

      <p className="mt-4 text-sm text-slate-600">
        Already have an account?{" "}
        <a href="/login" className="font-medium text-indigo-600">
          Log in
        </a>
      </p>
    </div>
  );
}
