# InRange Crew

A two-sided marketplace for vetted, "Set-Ready" Production Assistants and
Coordinators in the NY/NJ ("Hollywood East") film & TV corridor. Producers
post a call time; the platform instantly invites every matching, verified,
Set-Ready PA; the first to accept is confirmed.

This positions the product against four categories of incumbent: full-service
staffing agencies, self-serve job boards (Staff Me Up, Mandy), entertainment
payroll platforms (Wrapbook, Cast & Crew), and informal Facebook/text
networks — by combining automated dispatch, NY/NJ tax-residency verification
(for production tax-credit compliance), and a certified on-set micro-course
into one flow.

## Stack

- Next.js 16 (App Router, Server Actions, Turbopack)
- Supabase (Postgres + Auth + Storage) via `@supabase/ssr`
- Tailwind CSS

## How it works

1. **PAs get Set-Ready.** A PA creates a profile (home state, role types,
   experience, payroll class), uploads a tax-residency document, and passes
   a certified on-set micro-course (`src/lib/course.ts`). `pa_profiles.set_ready`
   is a generated column: `tax_residency_status = 'verified' AND course passed`.
2. **Producers post a call time.** Creating a gig (`gigs` table) triggers the
   `dispatch_gig_to_matches` Postgres function, which invites every Set-Ready
   PA in the matching state + role type (`dispatches` rows, status `invited`).
3. **First accept wins.** `accept_dispatch` (Postgres function) confirms that
   PA, flips the gig to `filled`, expires the other invites, and notifies the
   producer — all as one atomic, security-definer transaction so RLS can stay
   tightly scoped to "you can only touch your own rows."
4. **Admins vet compliance.** `/admin` reviews uploaded tax-residency docs
   (signed URLs from a private Supabase Storage bucket) and marks PAs
   verified/rejected.

## Data model

See `supabase/migrations/`:

- `0001_init.sql` — `profiles`, `pa_profiles`, `productions`, `gigs`,
  `dispatches`, `notifications` + RLS policies + the `handle_new_user` trigger
  that creates a `profiles` row on signup.
- `0002_storage.sql` — private `tax-docs` storage bucket + per-user policies.
- `0003_functions.sql` — `dispatch_gig_to_matches`, `accept_dispatch`,
  `decline_dispatch` security-definer functions.

## Setup

1. Create a Supabase project.
2. Run the migrations:
   ```bash
   npm install -g supabase
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```
3. Copy `.env.example` to `.env.local` and fill in your project's URL and
   anon key (Project Settings → API).
4. In the Supabase dashboard, under Authentication → Providers, you can
   disable "Confirm email" for faster local testing.
5. `npm install && npm run dev`

## Roles

Every signup picks a role (`pa` or `producer`); an `admin` role exists for
the vetting queue but has no self-service signup — promote a user by hand:

```sql
update profiles set role = 'admin' where id = '<user-uuid>';
```

## What's intentionally out of scope for this MVP

- **Payroll/payments.** `pa_profiles.payroll_class` and tax-residency status
  are tracked as data only; actual pay runs through your existing payroll
  provider (e.g. Wrapbook) — see the competitive analysis this app was built
  from for why that integration is a "later" step, not a "day one" one.
- **SMS/email delivery.** New invites land in the in-app `notifications`
  table and the PA dashboard's "New invites" list. Wiring real-time SMS
  (Twilio) or email (Resend) push is a follow-up — the `dispatch_gig_to_matches`
  function is already the right place to trigger it.
