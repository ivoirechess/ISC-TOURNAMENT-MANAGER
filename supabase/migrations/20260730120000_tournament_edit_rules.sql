-- Server-side rules for editing an existing tournament.
--
-- RLS already answers "who may write" (the owning admin or a super_admin).
-- What it cannot express is "which columns may still change, and when" —
-- that is what these triggers add. Without them the rules below would live
-- in the browser alone, which CLAUDE.md forbids as a protection.
--
-- No RLS policy changes here: writes stay restricted exactly as before.
-- These are integrity rules, not authorization ones, so they apply to a
-- super_admin too: the point is that the data stays coherent, not that
-- someone lacks rights.
--
-- Refusals raise SQLSTATE ISC01 so the front-end can tell one of our own
-- messages — written in French, safe to display — from a raw PostgreSQL
-- error that would leak relation and constraint names.

create or replace function public.enforce_tournament_edit_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rounds_exist boolean;
begin
  if new.rounds_planned is distinct from old.rounds_planned then
    -- Round-robin formats derive their length from the field, and their
    -- whole schedule is written at creation: the number is not a choice,
    -- and changing it would leave rounds_planned out of step with the
    -- rounds actually stored. Checked first so the reason given matches
    -- the one the interface shows for the same tournament.
    if old.format in ('round_robin', 'double_round_robin') then
      raise exception
        'Ce format joue toutes les rencontres : son nombre de rondes ne se modifie pas.'
        using errcode = 'ISC01';
    end if;

    -- The planned round count is a target the pairings are built against,
    -- so it is frozen as soon as a single round exists. Testing the rounds
    -- rather than the status is deliberate: `status` can be set back to
    -- 'draft' by the owner, which would otherwise reopen the rule.
    select exists (select 1 from public.rounds r where r.tournament_id = old.id)
      into rounds_exist;
    if rounds_exist then
      raise exception
        'Le tournoi a deja des rondes : son nombre de rondes prevues ne peut plus changer.'
        using errcode = 'ISC01';
    end if;

    if old.status <> 'draft' then
      raise exception
        'Le nombre de rondes ne peut plus changer une fois le tournoi lance (statut %).',
        old.status
        using errcode = 'ISC01';
    end if;
  end if;

  -- The format decides how pairings are produced; changing it after the
  -- fact would orphan whatever has already been generated.
  if new.format is distinct from old.format then
    raise exception 'Le format d''un tournoi ne peut pas etre modifie apres sa creation.'
      using errcode = 'ISC01';
  end if;

  return new;
end;
$$;

create or replace trigger tournaments_enforce_edit_rules
  before update on public.tournaments
  for each row
  execute function public.enforce_tournament_edit_rules();

-- Correcting a result must never move a pairing: only `result` may change.
-- The players, their colours and the board stay put, so the standings are
-- recomputed from the same games that were actually played.
--
-- Written as an allow-list rather than a list of frozen columns: rebuilding
-- the expected row from OLD and letting only `result` through means a column
-- added to `pairings` later is protected the day it appears, instead of
-- becoming silently editable.
--
-- Scope: this covers UPDATE only. Deleting a pairing and inserting another
-- reaches the same result through the DELETE and INSERT policies, which stay
-- as they are — deletion is handled separately.
create or replace function public.enforce_pairing_edit_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected public.pairings;
begin
  expected := old;
  expected.result := new.result;

  if new is distinct from expected then
    raise exception
      'Un appariement ne peut pas etre deplace : seul le resultat est modifiable.'
      using errcode = 'ISC01';
  end if;

  return new;
end;
$$;

create or replace trigger pairings_enforce_edit_rules
  before update on public.pairings
  for each row
  execute function public.enforce_pairing_edit_rules();
