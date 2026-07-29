-- FIDE synchronization metadata and normalized local clubs.
create table public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check(length(btrim(name))>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.clubs enable row level security;
create policy "clubs are public" on public.clubs for select using(true);
create policy "admins manage clubs" on public.clubs for all to authenticated
  using(public.is_admin()) with check(public.is_admin());

alter table public.players
  add column fide_title text,
  add column other_titles text[] not null default '{}',
  add column fide_active boolean,
  add column source_period text,
  add column fide_synced_at timestamptz,
  add column normalized_name text,
  add column club_id uuid references public.clubs(id),
  add column source text,
  add column merged_into uuid references public.players(id),
  add column updated_at timestamptz not null default now(),
  add column local_notes text;

update public.players set fide_title=title, normalized_name=lower(btrim(name));
create index players_normalized_name_idx on public.players(normalized_name);
create index players_fide_active_idx on public.players(fide_active) where merged_into is null;
create index players_ratings_idx on public.players(rating_std desc,rating_rapid desc,rating_blitz desc) where merged_into is null;

create or replace function public.touch_player_updated_at() returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=now(); return new; end; $$;
create trigger players_touch_updated_at before update on public.players for each row execute function public.touch_player_updated_at();

-- FIDE-owned fields are updated by the trusted monthly import only. Dashboard
-- administrators may maintain local data, but cannot impersonate that source.
create or replace function public.protect_fide_player_fields() returns trigger language plpgsql set search_path='' as $$
begin
  if current_user not in ('authenticated','anon') or public.is_super_admin() then return new; end if;
  if new.fide_id is distinct from old.fide_id
    or new.federation is distinct from old.federation
    or new.fide_title is distinct from old.fide_title
    or new.other_titles is distinct from old.other_titles
    or new.rating_std is distinct from old.rating_std
    or new.rating_rapid is distinct from old.rating_rapid
    or new.rating_blitz is distinct from old.rating_blitz
    or new.fide_active is distinct from old.fide_active
    or new.source_period is distinct from old.source_period
    or new.fide_synced_at is distinct from old.fide_synced_at
    or new.normalized_name is distinct from old.normalized_name
    or new.source is distinct from old.source
    or new.merged_into is distinct from old.merged_into
    or (old.fide_id is not null and new.name is distinct from old.name)
  then raise exception 'Les donnees FIDE synchronisees sont en lecture seule.' using errcode='ISC01'; end if;
  return new;
end; $$;
create trigger players_protect_fide_fields before update on public.players for each row execute function public.protect_fide_player_fields();

-- The existing pairing trigger normally freezes both players. During the
-- merge RPC it accepts exactly the configured source -> target replacement.
create or replace function public.enforce_pairing_edit_rules() returns trigger language plpgsql set search_path='' as $$
declare expected public.pairings; parent_status public.tournament_status; released timestamptz; validated timestamptz;
  merge_source uuid:=nullif(current_setting('app.merge_source',true),'')::uuid;
  merge_target uuid:=nullif(current_setting('app.merge_target',true),'')::uuid;
begin
  if merge_source is not null and merge_target is not null and public.is_super_admin() then
    expected:=old;
    if expected.white_player_id=merge_source then expected.white_player_id:=merge_target; end if;
    if expected.black_player_id=merge_source then expected.black_player_id:=merge_target; end if;
    if new is distinct from expected then raise exception 'La fusion tente de modifier un appariement illegalement.' using errcode='ISC01'; end if;
    return new;
  end if;
  expected:=old; expected.result:=new.result;
  if new is distinct from expected then raise exception 'Un appariement ne peut pas etre deplace : seul le resultat est modifiable.' using errcode='ISC01'; end if;
  if new.result is distinct from old.result then
    select t.status,r.released_at,r.validated_at into parent_status,released,validated from public.rounds r join public.tournaments t on t.id=r.tournament_id where r.id=old.round_id;
    if parent_status is distinct from 'ongoing' then raise exception 'Un resultat ne peut etre saisi que sur un tournoi en cours.' using errcode='ISC01'; end if;
    if released is null then raise exception 'Cette ronde n''est pas encore debloquee.' using errcode='ISC01'; end if;
    if validated is not null then raise exception 'Cette ronde est validee : ses resultats sont verrouilles.' using errcode='ISC01'; end if;
    if new.result is null and old.result='bye' then raise exception 'Un exempt ne peut pas etre efface.' using errcode='ISC01'; end if;
  end if;
  return new;
end; $$;

create or replace function public.merge_players(source_id uuid,target_id uuid,reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.is_super_admin() then raise exception 'Seul un super-admin peut fusionner des joueurs.' using errcode='ISC01'; end if;
  if source_id=target_id or nullif(btrim(coalesce(reason,'')),'') is null then raise exception 'Source, cible et raison valide sont obligatoires.' using errcode='ISC01'; end if;
  perform 1 from public.players where id in(source_id,target_id) for update;
  if (select count(*) from public.players where id in(source_id,target_id) and merged_into is null)<>2 then raise exception 'Joueur source ou cible introuvable/deja fusionne.' using errcode='ISC01'; end if;
  if exists(
    select 1 from public.pairings s join public.pairings t on t.round_id=s.round_id and t.id<>s.id
    where source_id in(s.white_player_id,s.black_player_id) and target_id in(t.white_player_id,t.black_player_id)
  ) or exists(
    select 1 from public.pairings where source_id in(white_player_id,black_player_id) and target_id in(white_player_id,black_player_id)
  ) then raise exception 'Fusion impossible : les joueurs apparaissent dans la meme ronde.' using errcode='ISC01'; end if;
  perform set_config('app.merge_source',source_id::text,true);
  perform set_config('app.merge_target',target_id::text,true);
  delete from public.tournament_players s where s.player_id=source_id and exists(select 1 from public.tournament_players t where t.tournament_id=s.tournament_id and t.player_id=target_id);
  update public.tournament_players set player_id=target_id where player_id=source_id;
  update public.pairings set white_player_id=target_id where white_player_id=source_id;
  update public.pairings set black_player_id=target_id where black_player_id=source_id;
  update public.players set merged_into=target_id,local_notes=concat_ws(E'\n',local_notes,'Fusion: '||reason) where id=source_id;
end; $$;
revoke execute on function public.merge_players(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.merge_players(uuid,uuid,text) to authenticated;
comment on function public.merge_players(uuid,uuid,text) is 'Super-admin only. Repoints registrations and pairings transactionally, then marks the source as merged.';
