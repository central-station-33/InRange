-- Private bucket for PA tax-residency verification documents.
insert into storage.buckets (id, name, public)
values ('tax-docs', 'tax-docs', false)
on conflict (id) do nothing;

-- Path convention: {pa_profile_id}/{filename}. Owner (first path segment) can
-- upload/read their own doc; admins can read all.
create policy "pa can upload own tax doc"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'tax-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "pa can read own tax doc"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'tax-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "admins can read all tax docs"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'tax-docs'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );
