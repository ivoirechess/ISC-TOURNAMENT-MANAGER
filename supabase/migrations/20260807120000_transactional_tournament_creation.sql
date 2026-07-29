-- Atomic and idempotent tournament creation.
alter table public.tournaments
  add column time_control_text text,
  add column ranking_type text not null default 'elo' check (ranking_type in ('elo', 'national', 'none')),
  add column fide_rated boolean not null default false,
  add column max_players integer check (max_players is null or max_players >= 2);

create table public.tournament_creation_requests (
  request_id uuid primary key,
  created_by uuid not null references public.profiles(id),
  tournament_id uuid not null unique references public.tournaments(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.tournament_creation_requests enable row level security;
create policy "owners read their creation requests" on public.tournament_creation_requests
  for select to authenticated using (created_by=auth.uid() or public.is_super_admin());

create or replace function public.create_tournament_with_players(
  request_id uuid, tournament_data jsonb, player_ids uuid[], schedule jsonb default null,
  publish_now boolean default false
) returns public.tournaments
language plpgsql security definer set search_path='' as $$
declare
  owner_id uuid:=auth.uid(); result public.tournaments; format_value public.tournament_format;
  player_count integer; expected_rounds integer; round_index integer:=0; board_index integer;
  round_json jsonb; pairing jsonb; new_round uuid; white_id uuid; black_id uuid; initial_result text;
  seen uuid[]; seen_boards integer[]; board_no integer; bye_count integer; pair_count integer;
begin
  if request_id is null then raise exception 'Identifiant de requete obligatoire.' using errcode='ISC01'; end if;
  perform pg_advisory_xact_lock(hashtextextended(request_id::text,0));
  select t.* into result from public.tournament_creation_requests cr join public.tournaments t on t.id=cr.tournament_id
   where cr.request_id=create_tournament_with_players.request_id and cr.created_by=owner_id;
  if result.id is not null then return result; end if;
  if not public.is_admin() then raise exception 'Seul un organisateur peut creer un tournoi.' using errcode='ISC01'; end if;
  if nullif(btrim(tournament_data->>'name'),'') is null then raise exception 'Le nom du tournoi est obligatoire.' using errcode='ISC01'; end if;
  begin format_value:=(tournament_data->>'format')::public.tournament_format; exception when others then raise exception 'Format invalide.' using errcode='ISC01'; end;
  if format_value not in ('swiss','round_robin','double_round_robin') then raise exception 'Format indisponible.' using errcode='ISC01'; end if;
  player_count:=coalesce(cardinality(player_ids),0);
  if player_count<2 or (select count(distinct x) from unnest(player_ids) x)<>player_count then raise exception 'Les participants sont invalides ou dupliques.' using errcode='ISC01'; end if;
  if exists(select 1 from unnest(player_ids) x left join public.players p on p.id=x where p.id is null) then raise exception 'Un joueur inscrit est introuvable.' using errcode='ISC01'; end if;
  if (tournament_data->>'max_players') is not null and player_count>(tournament_data->>'max_players')::integer then raise exception 'Le maximum de joueurs est depasse.' using errcode='ISC01'; end if;
  expected_rounds:=case when format_value='swiss' then (tournament_data->>'rounds_planned')::integer else (case when player_count%2=0 then player_count-1 else player_count end)*(case when format_value='double_round_robin' then 2 else 1 end) end;
  if expected_rounds<1 then raise exception 'Nombre de rondes invalide.' using errcode='ISC01'; end if;
  if format_value='swiss' and schedule is not null and schedule<>'[]'::jsonb then raise exception 'Un tournoi suisse demarre sans ronde.' using errcode='ISC01'; end if;
  if format_value<>'swiss' and (jsonb_typeof(schedule)<>'array' or jsonb_array_length(schedule)<>expected_rounds) then raise exception 'Le calendrier doit contenir exactement % rondes.',expected_rounds using errcode='ISC01'; end if;

  insert into public.tournaments(name,description,starts_at,city,venue_name,venue_address,organizer_name,
    public_contact_email,registration_url,poster_url,format,rating_type,time_control_text,ranking_type,
    fide_rated,max_players,rounds_planned,status,created_by,tiebreaks,published_at)
  values(btrim(tournament_data->>'name'),nullif(tournament_data->>'description',''),nullif(tournament_data->>'starts_at','')::timestamptz,
    nullif(tournament_data->>'city',''),nullif(tournament_data->>'venue_name',''),nullif(tournament_data->>'venue_address',''),
    nullif(tournament_data->>'organizer_name',''),nullif(tournament_data->>'public_contact_email',''),nullif(tournament_data->>'registration_url',''),
    nullif(tournament_data->>'poster_url',''),format_value,nullif(tournament_data->>'rating_type',''),nullif(tournament_data->>'time_control_text',''),
    coalesce(nullif(tournament_data->>'ranking_type',''),'elo'),coalesce((tournament_data->>'fide_rated')::boolean,false),
    nullif(tournament_data->>'max_players','')::integer,expected_rounds,'draft',owner_id,
    array(select jsonb_array_elements_text(tournament_data->'tiebreaks')),case when publish_now then now() end)
  returning * into result;
  insert into public.tournament_creation_requests values(request_id,owner_id,result.id,now());
  insert into public.tournament_players(tournament_id,player_id) select result.id,unnest(player_ids);

  if format_value<>'swiss' then
    for round_json in select value from jsonb_array_elements(schedule) loop
      round_index:=round_index+1; seen:='{}'; seen_boards:='{}'; bye_count:=0; board_index:=0;
      if jsonb_typeof(round_json)<>'array' then raise exception 'Ronde % invalide.',round_index using errcode='ISC01'; end if;
      insert into public.rounds(tournament_id,number) values(result.id,round_index) returning id into new_round;
      for pairing in select value from jsonb_array_elements(round_json) loop
        board_index:=board_index+1; board_no:=coalesce((pairing->>'board')::integer,board_index);
        if board_no<1 or board_no=any(seen_boards) then raise exception 'Les tables doivent etre uniques dans une ronde.' using errcode='ISC01'; end if;
        seen_boards:=array_append(seen_boards,board_no);
        white_id:=(pairing->>'white')::uuid; black_id:=nullif(pairing->>'black','')::uuid; initial_result:=pairing->>'result';
        if not white_id=any(player_ids) or (black_id is not null and not black_id=any(player_ids)) or white_id=black_id then raise exception 'Paire illegale en ronde %.',round_index using errcode='ISC01'; end if;
        if white_id=any(seen) or (black_id is not null and black_id=any(seen)) then raise exception 'Un joueur apparait plusieurs fois en ronde %.',round_index using errcode='ISC01'; end if;
        seen:=array_append(seen,white_id);
        if black_id is null then bye_count:=bye_count+1; if initial_result is distinct from 'bye' then raise exception 'Bye incoherent.' using errcode='ISC01'; end if;
        else seen:=array_append(seen,black_id); if initial_result is not null then raise exception 'Un resultat initial est interdit.' using errcode='ISC01'; end if; end if;
        insert into public.pairings(round_id,white_player_id,black_player_id,result,board) values(new_round,white_id,black_id,initial_result,board_no);
      end loop;
      if cardinality(seen)<>player_count or bye_count<>(case when player_count%2=1 then 1 else 0 end) then raise exception 'Ronde % incomplete ou bye incoherent.',round_index using errcode='ISC01'; end if;
    end loop;
    -- Every unordered pair occurs once per leg; this also rejects duplicates/missing pairs.
    select count(*) into pair_count from (
      select least((p->>'white')::uuid,(p->>'black')::uuid),greatest((p->>'white')::uuid,(p->>'black')::uuid),count(*) c
      from jsonb_array_elements(schedule) r cross join lateral jsonb_array_elements(r.value) p
      where nullif(p->>'black','') is not null group by 1,2
      having count(*)<>(case when format_value='double_round_robin' then 2 else 1 end)
    ) invalid_pairs;
    if pair_count>0 then raise exception 'Le calendrier contient une paire dupliquee ou manquante.' using errcode='ISC01'; end if;
  end if;
  return result;
end; $$;

revoke execute on function public.create_tournament_with_players(uuid,jsonb,uuid[],jsonb,boolean) from public,anon;
grant execute on function public.create_tournament_with_players(uuid,jsonb,uuid[],jsonb,boolean) to authenticated;

comment on function public.create_tournament_with_players(uuid,jsonb,uuid[],jsonb,boolean) is
'Creates one tournament, registrations and optional circle schedule atomically. request_id is an idempotency key; retries return the original tournament.';
