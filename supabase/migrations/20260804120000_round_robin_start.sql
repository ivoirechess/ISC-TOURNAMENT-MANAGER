-- A Swiss tournament starts with an empty schedule and start_tournament
-- draws its first round. Round-robin tournaments are the opposite: their
-- complete schedule is persisted at creation. Starting them must validate
-- that schedule, not reject it.

create or replace function public.start_tournament(t_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data public.tournaments;
  moment timestamptz := now();
  player_count integer;
  round_count integer;
  new_round uuid;
  board_no integer := 0;
  seat record;
  pending uuid := null;
begin
  row_data := public.assert_tournament_writable(t_id);

  if row_data.cancelled_at is not null then
    raise exception 'Un tournoi annule ne demarre pas.' using errcode = 'ISC01';
  end if;
  if row_data.started_at is not null or row_data.status <> 'draft' then
    raise exception 'Ce tournoi a deja demarre.' using errcode = 'ISC01';
  end if;

  select count(*) into round_count
    from public.rounds r
   where r.tournament_id = t_id;

  if row_data.format = 'swiss' then
    if round_count <> 0 then
      raise exception 'Un tournoi suisse doit demarrer sans ronde existante.'
        using errcode = 'ISC01';
    end if;
  elsif row_data.format in ('round_robin', 'double_round_robin') then
    if round_count <> row_data.rounds_planned then
      raise exception
        'Le calendrier toutes rondes est incomplet : % ronde(s) sur % attendue(s).',
        round_count, row_data.rounds_planned
        using errcode = 'ISC01';
    end if;
  else
    raise exception 'Le format % ne peut pas encore demarrer.', row_data.format
      using errcode = 'ISC01';
  end if;

  select count(*) into player_count
    from public.tournament_players tp
   where tp.tournament_id = t_id and tp.withdrawn = false;
  if player_count < 2 then
    raise exception 'Il faut au moins deux joueurs actifs pour demarrer (actuellement %).',
      player_count using errcode = 'ISC01';
  end if;

  update public.tournaments
     set status = 'ongoing', started_at = moment, last_activity_at = moment,
         published_at = coalesce(published_at, moment)
   where id = t_id;

  -- The complete round-robin schedule is deliberately left untouched.
  if row_data.format = 'swiss' then
    insert into public.rounds (tournament_id, number) values (t_id, 1)
      returning id into new_round;

    for seat in
      select tp.player_id
        from public.tournament_players tp
       where tp.tournament_id = t_id and tp.withdrawn = false
       order by tp.player_id
    loop
      if pending is null then
        pending := seat.player_id;
      else
        board_no := board_no + 1;
        insert into public.pairings
          (round_id, white_player_id, black_player_id, result, board)
        values (new_round, pending, seat.player_id, null, board_no);
        pending := null;
      end if;
    end loop;

    if pending is not null then
      board_no := board_no + 1;
      insert into public.pairings
        (round_id, white_player_id, black_player_id, result, board)
      values (new_round, pending, null, 'bye', board_no);
    end if;
  end if;

  return player_count;
end;
$$;

-- The calendar may exist in a draft, but that is not permission to record a
-- score. Enforce the same status gate as the result-entry screen server-side.
create or replace function public.enforce_pairing_edit_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected public.pairings;
  parent_status public.tournament_status;
begin
  expected := old;
  expected.result := new.result;

  if new is distinct from expected then
    raise exception
      'Un appariement ne peut pas etre deplace : seul le resultat est modifiable.'
      using errcode = 'ISC01';
  end if;

  if new.result is distinct from old.result then
    select t.status into parent_status
      from public.rounds r
      join public.tournaments t on t.id = r.tournament_id
     where r.id = old.round_id;

    if parent_status is distinct from 'ongoing' then
      raise exception
        'Un resultat ne peut etre saisi que sur un tournoi en cours (statut %).',
        coalesce(parent_status::text, 'inconnu')
        using errcode = 'ISC01';
    end if;

    if new.result is null and old.result = 'bye' then
      raise exception 'Un exempt ne peut pas etre efface.'
        using errcode = 'ISC01';
    end if;
  end if;

  return new;
end;
$$;
