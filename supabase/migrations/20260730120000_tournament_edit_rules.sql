-- Server-side rules for editing an existing tournament.
--
-- RLS already answers "who may write" (the owning admin or a super_admin).
-- What it cannot express is "which columns may still change, and when" —
-- that is what this trigger adds. Without it the draft-only rule would live
-- in the browser alone, which CLAUDE.md forbids as a protection.
--
-- No RLS policy changes here: writes stay restricted exactly as before.

create or replace function public.enforce_tournament_edit_rules()
returns trigger
language plpgsql
as $$
begin
  -- The planned round count is a target the pairings are built against.
  -- Once the tournament has left the draft stage, moving it would
  -- contradict the rounds already paired and played.
  if new.rounds_planned is distinct from old.rounds_planned then
    if old.status <> 'draft' then
      raise exception
        'Le nombre de rondes ne peut plus changer une fois le tournoi lance (statut %).',
        old.status
        using errcode = 'check_violation';
    end if;

    -- Round-robin formats derive their length from the field, and their
    -- whole schedule is written at creation: the number is not a choice,
    -- and changing it would leave rounds_planned out of step with the
    -- rounds actually stored.
    if old.format in ('round_robin', 'double_round_robin') then
      raise exception
        'Ce format joue toutes les rencontres : son nombre de rondes ne se modifie pas.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- The format decides how pairings are produced; changing it after the
  -- fact would orphan whatever has already been generated.
  if new.format is distinct from old.format then
    raise exception 'Le format d''un tournoi ne peut pas etre modifie apres sa creation.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger tournaments_enforce_edit_rules
  before update on public.tournaments
  for each row
  execute function public.enforce_tournament_edit_rules();

-- Correcting a result must never move a pairing: only `result` may change.
-- The players, their colours and the board stay put, so the standings are
-- recomputed from the same games that were actually played.
create or replace function public.enforce_pairing_edit_rules()
returns trigger
language plpgsql
as $$
begin
  if new.round_id is distinct from old.round_id
     or new.white_player_id is distinct from old.white_player_id
     or new.black_player_id is distinct from old.black_player_id
     or new.board is distinct from old.board then
    raise exception
      'Un appariement ne peut pas etre deplace : seul le resultat est modifiable.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger pairings_enforce_edit_rules
  before update on public.pairings
  for each row
  execute function public.enforce_pairing_edit_rules();
