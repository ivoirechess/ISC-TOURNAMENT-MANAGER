-- Starting a round-robin tournament
-- ===========================================================================
--
-- Bug fixed here: a round-robin (or double round-robin) could never be
-- started at all. `start_tournament` refused any tournament that already had
-- rounds — a guard written for the Swiss, whose round 1 the function draws
-- itself and which must therefore find the table empty. The circle formats
-- have the opposite property: their whole schedule is written at creation
-- (src/roundrobin.js, and the insert in createTournament), so rounds are
-- legitimately there before the first move. The tournament stayed 'draft'
-- for good, and since result entry only opens on a running tournament, its
-- boards were unreachable.
--
-- The condition is therefore inverted per family, not removed:
--
--   swiss                      no round must exist, and round 1 is drawn here
--   round_robin, doubled       the complete schedule must exist, and nothing
--                              is drawn — only status and started_at move
--
-- Second, smaller hole closed below: a result could be written on a draft.
-- For the Swiss that was theoretical (a draft has no pairings), but a
-- round-robin holds its whole schedule from creation, so every board of a
-- tournament that had not started was writable by its organizer. The entry
-- screen keys on `status = 'ongoing'` (src/round-entry.js); this makes the
-- database say the same thing rather than trust it.

-- ---------------------------------------------------------------------------
-- start_tournament
-- ---------------------------------------------------------------------------
-- Replaces the body installed by 20260803120000. Everything else about it is
-- unchanged: the row is still locked FOR UPDATE against two tabs racing, the
-- checks still run before any write, and the Swiss draw is untouched.

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
  highest_round integer;
  plays_full_schedule boolean;
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

  plays_full_schedule := row_data.format in ('round_robin', 'double_round_robin');

  select count(*), coalesce(max(r.number), 0) into round_count, highest_round
    from public.rounds r where r.tournament_id = t_id;

  if plays_full_schedule then
    -- The circle method derives the whole calendar from the field alone, so
    -- it exists before the first move. What has to be checked here is that
    -- it is complete: a partial calendar would mean the creation was
    -- interrupted, and starting on it would announce rounds nobody drew.
    -- rounds_planned is the schedule's own length — createTournament writes
    -- the generated length there rather than the caller's number.
    --
    -- The count alone would not do. An organizer may write rounds on their
    -- own draft, so a calendar numbered 1, 2, 7 would pass a count of three.
    -- With `unique (tournament_id, number)` and `number >= 1` on the table,
    -- the right count plus a highest number within range means the rounds
    -- are exactly 1..rounds_planned, with none missing and none stray.
    if round_count <> row_data.rounds_planned or highest_round > row_data.rounds_planned then
      raise exception
        'Le calendrier de ce tournoi est incomplet : % ronde(s) enregistree(s) sur % prevues.',
        round_count, row_data.rounds_planned using errcode = 'ISC01';
    end if;
  elsif round_count > 0 then
    -- Swiss (and anything else drawn round by round): the round-1 draw below
    -- assumes nothing has been played. Guarding the assumption turns a raw
    -- unique-violation on (tournament_id, number) into a refusal that says
    -- what is wrong.
    raise exception 'Ce tournoi a deja des rondes : il ne peut pas etre redemarre.'
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

  -- Round-robin formats already hold their whole schedule: starting one adds
  -- nothing, it only opens what was drawn at creation.
  if row_data.format = 'swiss' then
    insert into public.rounds (tournament_id, number) values (t_id, 1)
      returning id into new_round;

    -- Same order as the engine's first round: no scores yet, so the field is
    -- ordered by player id, and an odd field leaves the last seat out.
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
        insert into public.pairings (round_id, white_player_id, black_player_id, result, board)
        values (new_round, pending, seat.player_id, null, board_no);
        pending := null;
      end if;
    end loop;

    if pending is not null then
      board_no := board_no + 1;
      insert into public.pairings (round_id, white_player_id, black_player_id, result, board)
      values (new_round, pending, null, 'bye', board_no);
    end if;
  end if;

  return player_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- No result before the start
-- ---------------------------------------------------------------------------
-- Replaces the body installed by 20260731120000; the trigger already points
-- at this name, so it picks the new one up. Both earlier rules are kept:
--
--   - a pairing never moves, only `result` changes (allow-list on OLD);
--   - a result is only emptied on a running tournament, and never on a bye.
--
-- Added: a result is only *entered* once the tournament has started. The
-- guard names the draft rather than testing `<> 'ongoing'` on purpose — an
-- archived tournament is already frozen for its organizer by
-- can_write_tournament, and whether a super_admin may still correct a
-- published archive is a separate question this fix does not settle.

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
    -- The bye is tested first so the reason given is the real one, rather
    -- than a status complaint about a row that could never be emptied.
    if old.result = 'bye' and new.result is null then
      raise exception 'Un exempt ne peut pas etre efface.'
        using errcode = 'ISC01';
    end if;

    select t.status into parent_status
      from public.rounds r
      join public.tournaments t on t.id = r.tournament_id
     where r.id = old.round_id;

    if new.result is null then
      if parent_status is distinct from 'ongoing' then
        raise exception
          'Un resultat ne peut etre efface que sur un tournoi en cours (statut %).',
          coalesce(parent_status::text, 'inconnu')
          using errcode = 'ISC01';
      end if;
    elsif parent_status = 'draft' then
      -- A round-robin holds its calendar from creation: without this, every
      -- board of a tournament that had not started was open to entry.
      raise exception
        'Un resultat ne peut etre saisi qu''une fois le tournoi demarre.'
        using errcode = 'ISC01';
    end if;
  end if;

  return new;
end;
$$;
