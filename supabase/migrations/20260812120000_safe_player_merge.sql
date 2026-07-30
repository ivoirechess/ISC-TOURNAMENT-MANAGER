create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create table public.player_aliases (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  alias text not null check(length(btrim(alias))>0),
  normalized_alias text not null,
  created_at timestamptz not null default now(),
  unique(player_id,normalized_alias)
);
create index player_aliases_normalized_idx on public.player_aliases(normalized_alias);
alter table public.player_aliases enable row level security;
create policy "player aliases are public" on public.player_aliases for select using(true);

create table public.player_merge_log (
  id bigint generated always as identity primary key,
  source_player_id uuid not null references public.players(id),
  target_player_id uuid not null references public.players(id),
  merged_by uuid not null references auth.users(id),
  reason text not null check(length(btrim(reason))>0),
  source_before jsonb not null,
  target_before jsonb not null,
  final_data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.player_merge_log enable row level security;
create policy "super admins read player merge log" on public.player_merge_log for select to authenticated using(public.is_super_admin());

create or replace function public.find_player_duplicates(search_name text,search_fide_id integer default null,search_club text default null,search_rating integer default null)
returns setof public.players language sql stable security definer set search_path='' as $$
  select p.* from public.players p
  where p.merged_into is null and (
    (search_fide_id is not null and p.fide_id=search_fide_id)
    or p.normalized_name in(lower(regexp_replace(extensions.unaccent(search_name),'[^a-zA-Z0-9]+',' ','g')),lower(regexp_replace(extensions.unaccent(array_to_string(array(select unnest(string_to_array(search_name,' ')) order by 1 desc),' ')),'[^a-zA-Z0-9]+',' ','g')))
    or extensions.similarity(coalesce(p.normalized_name,''),lower(extensions.unaccent(search_name)))>.48
    or exists(select 1 from public.player_aliases a where a.player_id=p.id and extensions.similarity(a.normalized_alias,lower(extensions.unaccent(search_name)))>.48)
    or (search_club is not null and lower(p.club)=lower(search_club) and search_rating is not null and abs(coalesce(p.rating_std,search_rating)-search_rating)<=50)
  ) order by p.fide_id=search_fide_id desc nulls last,extensions.similarity(coalesce(p.normalized_name,''),lower(extensions.unaccent(search_name))) desc;
$$;
revoke execute on function public.find_player_duplicates(text,integer,text,integer) from public,anon;
grant execute on function public.find_player_duplicates(text,integer,text,integer) to authenticated;

create or replace function public.merge_players(source_id uuid,target_id uuid,reason text)
returns void language plpgsql security definer set search_path='' as $$
declare source_row public.players; target_row public.players; final_row public.players;
begin
  if not public.is_super_admin() then raise exception 'Seul un super-admin peut fusionner des joueurs.' using errcode='ISC01'; end if;
  if source_id=target_id or nullif(btrim(coalesce(reason,'')),'') is null then raise exception 'Source, cible et raison valide sont obligatoires.' using errcode='ISC01'; end if;
  select * into source_row from public.players where id=source_id for update;
  select * into target_row from public.players where id=target_id for update;
  if source_row.id is null or target_row.id is null or source_row.merged_into is not null or target_row.merged_into is not null then raise exception 'Joueur source ou cible introuvable/deja fusionne.' using errcode='ISC01'; end if;
  if source_row.fide_id is not null and target_row.fide_id is null then raise exception 'La fiche FIDE doit etre la fiche principale.' using errcode='ISC01'; end if;
  if source_row.fide_id is not null and target_row.fide_id is not null and source_row.fide_id<>target_row.fide_id then raise exception 'Deux identites FIDE distinctes ne peuvent pas etre fusionnees.' using errcode='ISC01'; end if;
  if exists(select 1 from public.pairings s join public.pairings t on t.round_id=s.round_id and t.id<>s.id where source_id in(s.white_player_id,s.black_player_id) and target_id in(t.white_player_id,t.black_player_id))
     or exists(select 1 from public.pairings where source_id in(white_player_id,black_player_id) and target_id in(white_player_id,black_player_id))
  then raise exception 'Fusion impossible : conflit historique dans une meme ronde.' using errcode='ISC01'; end if;
  perform set_config('app.merge_source',source_id::text,true); perform set_config('app.merge_target',target_id::text,true);
  delete from public.tournament_players s where s.player_id=source_id and exists(select 1 from public.tournament_players t where t.tournament_id=s.tournament_id and t.player_id=target_id);
  update public.tournament_players set player_id=target_id where player_id=source_id;
  update public.pairings set white_player_id=target_id where white_player_id=source_id;
  update public.pairings set black_player_id=target_id where black_player_id=source_id;
  update public.players set club=coalesce(nullif(target_row.club,''),nullif(source_row.club,'')),club_id=coalesce(target_row.club_id,source_row.club_id),local_notes=nullif(concat_ws(E'\n',nullif(target_row.local_notes,''),nullif(source_row.local_notes,'')),'') where id=target_id returning * into final_row;
  insert into public.player_aliases(player_id,alias,normalized_alias) values(target_id,source_row.name,lower(regexp_replace(extensions.unaccent(source_row.name),'[^a-zA-Z0-9]+',' ','g'))),(target_id,target_row.name,lower(regexp_replace(extensions.unaccent(target_row.name),'[^a-zA-Z0-9]+',' ','g'))) on conflict do nothing;
  insert into public.player_aliases(player_id,alias,normalized_alias) select target_id,alias,normalized_alias from public.player_aliases where player_id=source_id on conflict do nothing;
  delete from public.player_aliases where player_id=source_id;
  update public.players set merged_into=target_id where id=source_id;
  insert into public.player_merge_log(source_player_id,target_player_id,merged_by,reason,source_before,target_before,final_data) values(source_id,target_id,auth.uid(),btrim(reason),to_jsonb(source_row),to_jsonb(target_row),to_jsonb(final_row));
  return;
end; $$;
revoke execute on function public.merge_players(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.merge_players(uuid,uuid,text) to authenticated;
