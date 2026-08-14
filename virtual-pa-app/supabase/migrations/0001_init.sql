-- InRange Crew: Virtual PA & Coordinator staffing platform
-- Core schema: profiles, PA vetting, productions, gigs, dispatch, notifications

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, holds shared identity + role
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('pa', 'producer', 'admin')),
  full_name text not null,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are viewable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid());

-- Auto-create a profile row when a new auth user signs up.
-- role/full_name come from the signup form via user_metadata.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'role', 'pa'),
    coalesce(new.raw_user_meta_data ->> 'full_name', 'New User'),
    new.raw_user_meta_data ->> 'phone'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- pa_profiles: vetting, tax-residency proofing, certification, set-ready flag
-- ---------------------------------------------------------------------------
create table public.pa_profiles (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  home_state text check (home_state in ('NY', 'NJ')),
  role_types text[] not null default '{}',
  bio text,
  years_experience numeric(4, 1) default 0,
  tax_residency_doc_path text,
  tax_residency_status text not null default 'unsubmitted'
    check (tax_residency_status in ('unsubmitted', 'pending', 'verified', 'rejected')),
  payroll_class text check (payroll_class in ('w2', '1099')),
  course_completed_at timestamptz,
  course_score int,
  admin_notes text,
  set_ready boolean generated always as (
    tax_residency_status = 'verified' and course_completed_at is not null
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pa_profiles enable row level security;

create policy "pa can view/update own pa_profile"
  on public.pa_profiles for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy "producers and admins can view pa_profiles"
  on public.pa_profiles for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('producer', 'admin')
    )
  );

create policy "admins can update any pa_profile"
  on public.pa_profiles for update
  to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- ---------------------------------------------------------------------------
-- productions: optional grouping of gigs under a named show/company
-- ---------------------------------------------------------------------------
create table public.productions (
  id uuid primary key default gen_random_uuid(),
  producer_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  company text,
  created_at timestamptz not null default now()
);

alter table public.productions enable row level security;

create policy "producers manage own productions"
  on public.productions for all
  to authenticated
  using (producer_id = auth.uid())
  with check (producer_id = auth.uid());

create policy "authenticated can view productions"
  on public.productions for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- gigs: a single call-time posting needing PA/Coordinator coverage
-- ---------------------------------------------------------------------------
create table public.gigs (
  id uuid primary key default gen_random_uuid(),
  producer_id uuid not null references public.profiles (id) on delete cascade,
  production_id uuid references public.productions (id) on delete set null,
  title text not null,
  role_type text not null check (role_type in ('set_pa', 'office_pa', 'coordinator', 'other')),
  location_state text not null check (location_state in ('NY', 'NJ')),
  location_detail text,
  call_time timestamptz not null,
  rate_amount numeric(10, 2),
  rate_unit text check (rate_unit in ('hour', 'day')),
  headcount int not null default 1,
  description text,
  status text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  created_at timestamptz not null default now()
);

alter table public.gigs enable row level security;

create policy "producers manage own gigs"
  on public.gigs for all
  to authenticated
  using (producer_id = auth.uid())
  with check (producer_id = auth.uid());

create policy "set-ready PAs and admins can view open gigs"
  on public.gigs for select
  to authenticated
  using (
    producer_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or exists (
      select 1 from public.pa_profiles pa
      where pa.profile_id = auth.uid() and pa.set_ready = true
    )
  );

-- ---------------------------------------------------------------------------
-- dispatches: an invite/application linking a gig to a PA
-- ---------------------------------------------------------------------------
create table public.dispatches (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null references public.gigs (id) on delete cascade,
  pa_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'invited'
    check (status in ('invited', 'accepted', 'declined', 'expired', 'confirmed')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (gig_id, pa_id)
);

alter table public.dispatches enable row level security;

create policy "pa can view/update own dispatches"
  on public.dispatches for all
  to authenticated
  using (pa_id = auth.uid())
  with check (pa_id = auth.uid());

create policy "producers can view dispatches on their gigs"
  on public.dispatches for select
  to authenticated
  using (
    exists (select 1 from public.gigs g where g.id = gig_id and g.producer_id = auth.uid())
  );

create policy "admins can view all dispatches"
  on public.dispatches for select
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ---------------------------------------------------------------------------
-- notifications: in-app inbox (SMS/email delivery wired in later via Make.com)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  gig_id uuid references public.gigs (id) on delete cascade,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.notifications enable row level security;

create policy "users manage own notifications"
  on public.notifications for all
  to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index dispatches_gig_idx on public.dispatches (gig_id);
create index dispatches_pa_idx on public.dispatches (pa_id);
create index gigs_status_idx on public.gigs (status);
