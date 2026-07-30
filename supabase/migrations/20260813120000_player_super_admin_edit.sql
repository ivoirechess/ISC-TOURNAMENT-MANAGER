-- Additive support for audited player corrections and durable FIDE overrides.
alter table public.players add column if not exists official_fide_data jsonb not null default '{}'::jsonb;
alter table public.players add column if not exists local_overrides jsonb not null default '{}'::jsonb;

create table public.player_edit_log (
 id bigint generated always as identity primary key,
 player_id uuid not null references public.players(id), edited_by uuid not null references auth.users(id),
 reason text not null check(length(btrim(reason))>0), changed_fields text[] not null,
 before_data jsonb not null, after_data jsonb not null, created_at timestamptz not null default now()
);
alter table public.player_edit_log enable row level security;
create policy "super admins read player edit log" on public.player_edit_log for select to authenticated using(public.is_super_admin());
-- No update/delete/insert client policy: this journal is append-only and is written only by the definer RPC.

create or replace function public.edit_player_as_super_admin(p_player_id uuid,p_changes jsonb,p_reason text)
returns public.players language plpgsql security definer set search_path='' as $$
declare old public.players; result public.players; k text; allowed constant text[]:=array['name','fide_id','federation','fide_title','other_titles','sex','birth_year','fide_active','rating_std','rating_rapid','rating_blitz','club_id','local_notes']; official constant text[]:=array['name','fide_id','federation','fide_title','other_titles','sex','birth_year','fide_active','rating_std','rating_rapid','rating_blitz']; club_name text; duplicate uuid; normalized text;
begin
 if not public.is_super_admin() then raise exception 'Seul un super-admin peut modifier complètement un joueur.' using errcode='ISC01'; end if;
 if nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'La raison est obligatoire.' using errcode='ISC01'; end if;
 if p_changes is null or jsonb_typeof(p_changes)<>'object' then raise exception 'Les modifications doivent être un objet JSON.' using errcode='ISC01'; end if;
 for k in select jsonb_object_keys(p_changes) loop if not(k=any(allowed)) then raise exception 'Champ inconnu : %',k using errcode='ISC01'; end if; end loop;
 select * into old from public.players where id=p_player_id for update;
 if old.id is null then raise exception 'Joueur introuvable.' using errcode='ISC01'; end if;
 if old.merged_into is not null then raise exception 'Cette ancienne fiche a déjà été fusionnée.' using errcode='ISC01'; end if;
 if p_changes?'name' and nullif(btrim(p_changes->>'name'),'') is null then raise exception 'Le nom ne peut pas être vide.' using errcode='ISC01'; end if;
 if p_changes?'fide_id' and p_changes->'fide_id'<>'null'::jsonb and (jsonb_typeof(p_changes->'fide_id')<>'number' or (p_changes->>'fide_id')::bigint<=0) then raise exception 'L’ID FIDE doit être un entier positif ou null.' using errcode='ISC01'; end if;
 if p_changes?'fide_id' and p_changes->'fide_id'<>'null'::jsonb then select id into duplicate from public.players where fide_id=(p_changes->>'fide_id')::integer and id<>p_player_id and merged_into is null; if duplicate is not null then raise exception 'Cet ID FIDE appartient déjà à une autre fiche. CONFLICT_PLAYER:%',duplicate using errcode='ISC01'; end if; end if;
 if p_changes?'federation' and p_changes->'federation'<>'null'::jsonb and (p_changes->>'federation')!~'^[A-Z]{3}$' then raise exception 'La fédération doit être un code de trois lettres majuscules.' using errcode='ISC01'; end if;
 if p_changes?'sex' and p_changes->'sex'<>'null'::jsonb and not((p_changes->>'sex')=any(array['M','F'])) then raise exception 'Sexe invalide.' using errcode='ISC01'; end if;
 if p_changes?'birth_year' and p_changes->'birth_year'<>'null'::jsonb and (p_changes->>'birth_year')::integer not between 1900 and extract(year from current_date)::integer then raise exception 'Année de naissance non plausible.' using errcode='ISC01'; end if;
 if p_changes?'fide_title' and p_changes->'fide_title'<>'null'::jsonb and not((p_changes->>'fide_title')=any(array['GM','IM','FM','CM','WGM','WIM','WFM','WCM'])) then raise exception 'Titre FIDE invalide.' using errcode='ISC01'; end if;
 foreach k in array array['rating_std','rating_rapid','rating_blitz'] loop if p_changes?k and p_changes->k<>'null'::jsonb and ((p_changes->>k)::integer<0 or (p_changes->>k)::integer>4000) then raise exception 'Elo invalide pour %.',k using errcode='ISC01'; end if; if p_changes->>k='0' then p_changes=jsonb_set(p_changes,array[k],'null'::jsonb); end if; end loop;
 if p_changes?'club_id' and p_changes->'club_id'<>'null'::jsonb then select name into club_name from public.clubs where id=(p_changes->>'club_id')::uuid; if club_name is null then raise exception 'Club introuvable.' using errcode='ISC01'; end if; end if;
 if p_changes?'name' and btrim(p_changes->>'name')<>old.name then normalized=lower(regexp_replace(extensions.unaccent(old.name),'[^a-zA-Z0-9]+',' ','g')); insert into public.player_aliases(player_id,alias,normalized_alias) values(old.id,old.name,normalized) on conflict do nothing; end if;
 update public.players p set
  name=case when p_changes?'name' then btrim(p_changes->>'name') else p.name end,
  normalized_name=case when p_changes?'name' then lower(btrim(regexp_replace(extensions.unaccent(p_changes->>'name'),'[^a-zA-Z0-9]+',' ','g'))) else p.normalized_name end,
  fide_id=case when p_changes?'fide_id' then (p_changes->>'fide_id')::integer else p.fide_id end,
  federation=case when p_changes?'federation' then p_changes->>'federation' else p.federation end,
  fide_title=case when p_changes?'fide_title' then p_changes->>'fide_title' else p.fide_title end,
  other_titles=case when p_changes?'other_titles' then array(select jsonb_array_elements_text(p_changes->'other_titles')) else p.other_titles end,
  sex=case when p_changes?'sex' then p_changes->>'sex' else p.sex end,birth_year=case when p_changes?'birth_year' then (p_changes->>'birth_year')::smallint else p.birth_year end,
  fide_active=case when p_changes?'fide_active' then (p_changes->>'fide_active')::boolean else p.fide_active end,
  rating_std=case when p_changes?'rating_std' then (p_changes->>'rating_std')::integer else p.rating_std end,rating_rapid=case when p_changes?'rating_rapid' then (p_changes->>'rating_rapid')::integer else p.rating_rapid end,rating_blitz=case when p_changes?'rating_blitz' then (p_changes->>'rating_blitz')::integer else p.rating_blitz end,
  club_id=case when p_changes?'club_id' then (p_changes->>'club_id')::uuid else p.club_id end,club=case when p_changes?'club_id' then club_name else p.club end,local_notes=case when p_changes?'local_notes' then p_changes->>'local_notes' else p.local_notes end,
  local_overrides=p.local_overrides||(select coalesce(jsonb_object_agg(key,value),'{}') from jsonb_each(p_changes) where key=any(official)),updated_at=now() where id=p_player_id returning * into result;
 insert into public.player_edit_log(player_id,edited_by,reason,changed_fields,before_data,after_data) values(p_player_id,auth.uid(),btrim(p_reason),array(select jsonb_object_keys(p_changes)),to_jsonb(old),to_jsonb(result)); return result;
end $$;
revoke execute on function public.edit_player_as_super_admin(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.edit_player_as_super_admin(uuid,jsonb,text) to authenticated;

alter table public.tournament_players add column if not exists player_name_snapshot text;
alter table public.tournament_players add column if not exists player_title_snapshot text;
alter table public.tournament_players add column if not exists player_federation_snapshot text;
alter table public.tournament_players add column if not exists player_club_snapshot text;
alter table public.tournament_players add column if not exists rating_snapshot integer;
alter table public.tournament_players add column if not exists rating_type_snapshot text;
create or replace function public.snapshot_tournament_player() returns trigger language plpgsql security definer set search_path='' as $$ declare p public.players;t public.tournaments;begin select * into p from public.players where id=new.player_id;select * into t from public.tournaments where id=new.tournament_id;new.player_name_snapshot=coalesce(new.player_name_snapshot,p.name);new.player_title_snapshot=coalesce(new.player_title_snapshot,p.fide_title);new.player_federation_snapshot=coalesce(new.player_federation_snapshot,p.federation);new.player_club_snapshot=coalesce(new.player_club_snapshot,p.club);new.rating_type_snapshot=coalesce(new.rating_type_snapshot,t.rating_type);new.rating_snapshot=coalesce(new.rating_snapshot,case t.rating_type when 'rapid' then p.rating_rapid when 'blitz' then p.rating_blitz else p.rating_std end);return new;end$$;
create trigger tournament_player_snapshot before insert on public.tournament_players for each row execute function public.snapshot_tournament_player();
create or replace function public.restore_player_fide_value(p_player_id uuid,p_field text,p_reason text) returns public.players language plpgsql security definer set search_path='' as $$declare p public.players; changes jsonb;begin if not public.is_super_admin() then raise exception 'Seul un super-admin peut restaurer une valeur FIDE.' using errcode='ISC01';end if;select * into p from public.players where id=p_player_id for update;if not(p_field=any(array['name','federation','fide_title','other_titles','sex','birth_year','fide_active','rating_std','rating_rapid','rating_blitz'])) or not(p.official_fide_data?p_field) then raise exception 'Valeur FIDE officielle indisponible.' using errcode='ISC01';end if;changes=jsonb_build_object(p_field,p.official_fide_data->p_field);p:=public.edit_player_as_super_admin(p_player_id,changes,p_reason);update public.players set local_overrides=local_overrides-p_field where id=p_player_id returning * into p;return p;end$$;
revoke execute on function public.restore_player_fide_value(uuid,text,text) from public,anon,authenticated;grant execute on function public.restore_player_fide_value(uuid,text,text) to authenticated;
