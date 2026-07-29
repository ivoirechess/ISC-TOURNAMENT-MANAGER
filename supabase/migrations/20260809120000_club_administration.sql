-- Club ownership, scoped tournament administration and invitation audit trail.
alter table public.clubs
  add column slug text,
  add column logo_url text,
  add column city text,
  add column description text,
  add column public_email text,
  add column public_phone text,
  add column website_url text,
  add column active boolean not null default true;

update public.clubs set slug=public.slugify(name) where slug is null;
alter table public.clubs alter column slug set not null;
alter table public.clubs add constraint clubs_slug_shape check(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
alter table public.clubs add constraint clubs_public_email_shape check(public_email is null or public_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
alter table public.clubs add constraint clubs_website_shape check(website_url is null or website_url ~* '^https://');
alter table public.clubs add constraint clubs_logo_shape check(logo_url is null or logo_url ~* '^https://');
create unique index clubs_slug_unique on public.clubs(slug);

create table public.club_memberships(
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check(role in('owner','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  primary key(club_id,user_id)
);

create table public.admin_invitations(
  id uuid primary key default gen_random_uuid(),
  email text not null check(email=lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  club_id uuid not null references public.clubs(id) on delete cascade,
  status text not null default 'pending' check(status in('pending','accepted','expired','revoked')),
  invited_by uuid not null references public.profiles(id),
  invited_user_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  last_sent_at timestamptz not null default now(),
  sent_count integer not null default 1 check(sent_count>0),
  last_error text
);
create unique index admin_invitations_one_pending on public.admin_invitations(email,club_id) where status='pending';
create index admin_invitations_status_idx on public.admin_invitations(status,created_at desc);

create table public.admin_invitation_events(
  id bigint generated always as identity primary key,
  invitation_id uuid references public.admin_invitations(id) on delete set null,
  action text not null,
  actor_id uuid references public.profiles(id),
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.club_memberships enable row level security;
alter table public.admin_invitations enable row level security;
alter table public.admin_invitation_events enable row level security;

create or replace function public.is_active_club_admin(target_club uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.is_super_admin() or exists(
    select 1 from public.club_memberships m join public.clubs c on c.id=m.club_id
    where m.club_id=target_club and m.user_id=auth.uid() and m.active and c.active
  );
$$;
create or replace function public.has_club_membership()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.club_memberships where user_id=auth.uid());
$$;

drop policy "clubs are public" on public.clubs;
drop policy "admins manage clubs" on public.clubs;
create policy "active clubs public or managed clubs visible" on public.clubs for select
  using(active or public.is_super_admin() or public.is_active_club_admin(id));
create policy "club administrators update their club" on public.clubs for update to authenticated
  using(public.is_active_club_admin(id)) with check(public.is_active_club_admin(id));
create policy "super admin creates clubs" on public.clubs for insert to authenticated with check(public.is_super_admin());
create policy "super admin deletes clubs" on public.clubs for delete to authenticated using(public.is_super_admin());

create policy "memberships visible to member and club admins" on public.club_memberships for select to authenticated
  using(public.is_super_admin() or user_id=auth.uid() or public.is_active_club_admin(club_id));
create policy "super admin manages memberships" on public.club_memberships for all to authenticated
  using(public.is_super_admin()) with check(public.is_super_admin());
create policy "super admin reads invitations" on public.admin_invitations for select to authenticated using(public.is_super_admin());
create policy "super admin reads invitation audit" on public.admin_invitation_events for select to authenticated using(public.is_super_admin());

create trigger club_memberships_touch before update on public.club_memberships
  for each row execute function public.touch_updated_at();
create trigger admin_invitations_touch before update on public.admin_invitations
  for each row execute function public.touch_updated_at();

alter table public.tournaments add column club_id uuid references public.clubs(id);
create index tournaments_club_idx on public.tournaments(club_id) where deleted_at is null;

-- Existing clients do not yet send club_id. For an administrator belonging to
-- exactly one active club, keep creation atomic by assigning that club inside
-- the INSERT performed by create_tournament_with_players.
create or replace function public.default_tournament_club()
returns trigger language plpgsql security definer set search_path='' as $$
declare selected uuid;
begin
  if new.club_id is null and not public.is_super_admin() then
    select min(m.club_id::text)::uuid into selected from public.club_memberships m
      join public.clubs c on c.id=m.club_id
      where m.user_id=auth.uid() and m.active and c.active
      having count(*)=1;
    new.club_id:=selected;
  end if;
  return new;
end; $$;
create trigger tournaments_default_club before insert on public.tournaments
  for each row execute function public.default_tournament_club();

create or replace function public.can_write_tournament(t_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.is_super_admin() or exists(
    select 1 from public.tournaments t
    where t.id=t_id and t.deleted_at is null and t.status<>'archived' and t.cancelled_at is null
      and ((t.club_id is null and t.created_by=auth.uid() and public.is_admin() and not public.has_club_membership())
        or (t.club_id is not null and public.is_active_club_admin(t.club_id)))
  );
$$;

drop policy "admins create their own tournaments" on public.tournaments;
drop policy "owner or super_admin updates tournaments" on public.tournaments;
create policy "authorized administrators create tournaments" on public.tournaments for insert to authenticated
  with check(public.is_super_admin() or (public.is_admin() and created_by=auth.uid()
    and ((club_id is null and not public.has_club_membership()) or public.is_active_club_admin(club_id))));
create policy "authorized administrators update tournaments" on public.tournaments for update to authenticated
  using(public.can_write_tournament(id))
  with check(public.is_super_admin() or (public.is_admin() and
    ((club_id is null and created_by=auth.uid() and not public.has_club_membership()) or public.is_active_club_admin(club_id))));

comment on table public.admin_invitations is 'Invitation delivery state. Writes are performed only by the invite-admin Edge Function service client.';
comment on function public.is_active_club_admin(uuid) is 'True for super-admins or active owner/admin members of an active club.';
