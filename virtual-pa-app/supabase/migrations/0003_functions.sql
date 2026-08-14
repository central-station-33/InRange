-- security-definer functions encapsulate cross-user writes (a producer
-- inviting PAs, a PA's acceptance updating the gig + notifying the
-- producer) so RLS on the underlying tables can stay tightly scoped to
-- "you can only touch your own rows."

create function public.dispatch_gig_to_matches(p_gig_id uuid)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_gig record;
  v_count int;
begin
  select * into v_gig from public.gigs where id = p_gig_id;

  if v_gig is null then
    raise exception 'Gig not found';
  end if;

  if v_gig.producer_id <> auth.uid() then
    raise exception 'Not authorized to dispatch this gig';
  end if;

  insert into public.dispatches (gig_id, pa_id, status)
  select v_gig.id, pa.profile_id, 'invited'
  from public.pa_profiles pa
  where pa.set_ready = true
    and pa.home_state = v_gig.location_state
    and pa.role_types && array[v_gig.role_type]
  on conflict (gig_id, pa_id) do nothing;

  get diagnostics v_count = row_count;

  insert into public.notifications (recipient_id, gig_id, message)
  select d.pa_id, d.gig_id, 'New gig invite: ' || v_gig.title || ' (' || v_gig.location_state || ')'
  from public.dispatches d
  where d.gig_id = v_gig.id and d.status = 'invited';

  return v_count;
end;
$$;

create function public.accept_dispatch(p_dispatch_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_dispatch record;
  v_gig record;
  v_pa_name text;
begin
  select * into v_dispatch from public.dispatches where id = p_dispatch_id;

  if v_dispatch is null or v_dispatch.pa_id <> auth.uid() then
    raise exception 'Not authorized';
  end if;

  if v_dispatch.status <> 'invited' then
    raise exception 'This invite is no longer active';
  end if;

  select * into v_gig from public.gigs where id = v_dispatch.gig_id for update;

  if v_gig.status <> 'open' then
    raise exception 'This gig is no longer available';
  end if;

  update public.dispatches
  set status = 'accepted', responded_at = now()
  where id = p_dispatch_id;

  update public.gigs set status = 'filled' where id = v_gig.id;

  update public.dispatches
  set status = 'expired', responded_at = now()
  where gig_id = v_gig.id and id <> p_dispatch_id and status = 'invited';

  select full_name into v_pa_name from public.profiles where id = auth.uid();

  insert into public.notifications (recipient_id, gig_id, message)
  values (v_gig.producer_id, v_gig.id, coalesce(v_pa_name, 'A PA') || ' accepted ' || v_gig.title);
end;
$$;

create function public.decline_dispatch(p_dispatch_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.dispatches
  set status = 'declined', responded_at = now()
  where id = p_dispatch_id and pa_id = auth.uid() and status = 'invited';
end;
$$;
