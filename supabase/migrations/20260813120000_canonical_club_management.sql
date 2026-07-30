-- Canonical club resolution and atomic manual-player creation.
create table public.club_aliases(
  id bigint generated always as identity primary key,
  club_id uuid not null references public.clubs(id) on delete cascade,
  alias text not null,
  normalized_slug text not null,
  created_at timestamptz not null default now(),
  unique(club_id, normalized_slug)
);
create index club_aliases_slug_idx on public.club_aliases(normalized_slug);
alter table public.club_aliases enable row level security;
create policy "club aliases are public" on public.club_aliases for select using(true);

create table public.club_reconciliation_diagnostics(
  id bigint generated always as identity primary key,
  normalized_slug text not null,
  variants text[] not null,
  player_count integer not null,
  club_id uuid references public.clubs(id),
  created_at timestamptz not null default now()
);
alter table public.club_reconciliation_diagnostics enable row level security;
create policy "super admin reads club diagnostics" on public.club_reconciliation_diagnostics
  for select to authenticated using(public.is_super_admin());

create or replace function public.resolve_or_create_club(p_name text, p_city text default null)
returns table(id uuid,name text,slug text,city text)
language plpgsql security definer set search_path=''
as $$
declare normalized_name text; normalized_slug text; found public.clubs%rowtype;
begin
  if not (public.is_admin() or public.is_super_admin()) then
    raise exception 'Action réservée aux administrateurs.' using errcode='42501';
  end if;
  normalized_name:=regexp_replace(btrim(coalesce(p_name,'')),'[[:space:]]+',' ','g');
  if normalized_name='' then raise exception 'Le nom du club est obligatoire.' using errcode='22023'; end if;
  normalized_slug:=public.slugify(normalized_name);
  if normalized_slug='' then raise exception 'Le nom du club est invalide.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(normalized_slug,0));
  select c.* into found from public.clubs c where c.slug=normalized_slug for update;
  if not found then
    insert into public.clubs(name,slug,city,active)
      values(normalized_name,normalized_slug,nullif(btrim(p_city),''),true) returning * into found;
  end if;
  insert into public.club_aliases(club_id,alias,normalized_slug)
    values(found.id,normalized_name,normalized_slug) on conflict(club_id,normalized_slug) do nothing;
  return query select found.id,found.name,found.slug,found.city;
end $$;
revoke all on function public.resolve_or_create_club(text,text) from public;
grant execute on function public.resolve_or_create_club(text,text) to authenticated;

create or replace function public.create_player_with_club(
  p_name text,p_club_id uuid default null,p_club_name text default null,p_club_city text default null,
  p_fide_id bigint default null,p_rating_std integer default null)
returns public.players language plpgsql security definer set search_path='' as $$
declare chosen record; result public.players;
begin
  if not (public.is_admin() or public.is_super_admin()) then
    raise exception 'Action réservée aux administrateurs.' using errcode='42501';
  end if;
  if btrim(coalesce(p_name,''))='' then raise exception 'Le nom du joueur est obligatoire.' using errcode='22023'; end if;
  if p_club_id is not null then
    select c.id,c.name,c.slug,c.city into chosen from public.clubs c where c.id=p_club_id and c.active for share;
    if not found then raise exception 'Club actif introuvable.' using errcode='22023'; end if;
  elsif btrim(coalesce(p_club_name,''))<>'' then
    select * into chosen from public.resolve_or_create_club(p_club_name,p_club_city);
  end if;
  insert into public.players(name,normalized_name,club_id,club,fide_id,rating_std)
    values(btrim(p_name),lower(btrim(p_name)),chosen.id,chosen.name,p_fide_id,p_rating_std)
    returning * into result;
  return result;
end $$;
revoke all on function public.create_player_with_club(text,uuid,text,text,bigint,integer) from public;
grant execute on function public.create_player_with_club(text,uuid,text,text,bigint,integer) to authenticated;

-- Record variants before converging them. Existing club_id values are never touched.
insert into public.club_reconciliation_diagnostics(normalized_slug,variants,player_count,club_id)
select public.slugify(p.club),array_agg(distinct p.club order by p.club),count(*)::integer,null::uuid
from public.players p where p.club_id is null and btrim(coalesce(p.club,''))<>''
group by public.slugify(p.club) having count(distinct p.club)>1;

do $$ declare item record; target public.clubs%rowtype; canonical_name text;
begin
  for item in select public.slugify(club) slug,min(regexp_replace(btrim(club),'[[:space:]]+',' ','g')) name
              from public.players where club_id is null and btrim(coalesce(club,''))<>'' group by public.slugify(club)
  loop
    perform pg_advisory_xact_lock(hashtextextended(item.slug,0));
    select * into target from public.clubs where slug=item.slug;
    if not found then insert into public.clubs(name,slug,active) values(item.name,item.slug,true) returning * into target; end if;
    insert into public.club_aliases(club_id,alias,normalized_slug)
      select distinct target.id,p.club,item.slug from public.players p
      where p.club_id is null and public.slugify(p.club)=item.slug on conflict(club_id,normalized_slug) do nothing;
    update public.players set club_id=target.id,club=target.name
      where club_id is null and public.slugify(club)=item.slug;
    update public.club_reconciliation_diagnostics set club_id=target.id where normalized_slug=item.slug and club_id is null;
  end loop;
end $$;

comment on function public.resolve_or_create_club(text,text) is 'Idempotent minimal club creation for admins; advisory-locked by canonical slug.';
comment on function public.create_player_with_club(text,uuid,text,text,bigint,integer) is 'Atomically resolves an active canonical club and creates its player.';
