-- Behavioural checks for the RLS policies, run against a real PostgreSQL.
--
-- The Node test suite can only read the migrations as text: it catches a
-- guard that goes missing from the source, never one that fails to do what
-- it claims. These checks exercise the policies as four different callers
-- and fail loudly when a rule is only decorative.
--
--   npm run test:rls        (see scripts/run-rls-checks.sh for the setup)
--
-- Every check raises on failure, so a non-zero exit means a real regression.

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------------
-- Fixtures
-- --------------------------------------------------------------------------
insert into auth.users(id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');
insert into public.profiles(id, role) values
  ('11111111-1111-1111-1111-111111111111', 'admin'),        -- owner
  ('22222222-2222-2222-2222-222222222222', 'admin'),        -- other admin
  ('33333333-3333-3333-3333-333333333333', 'super_admin');
insert into public.players(id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Alice'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Bruno');

insert into public.tournaments(id, name, format, rounds_planned, status, created_by) values
  ('cccccccc-0000-0000-0000-000000000001', 'En cours', 'swiss', 5, 'ongoing',
   '11111111-1111-1111-1111-111111111111'),
  ('cccccccc-0000-0000-0000-000000000002', 'Archive', 'swiss', 3, 'archived',
   '11111111-1111-1111-1111-111111111111');
insert into public.tournament_players(tournament_id, player_id) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into public.rounds(id, tournament_id, number, released_at) values
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 1, now()),
  ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 1, now());
insert into public.pairings(id, round_id, white_player_id, black_player_id, result, board) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', '1-0', 1),
  ('eeeeeeee-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', '1-0', 1);

create or replace function pg_temp.check_equal(label text, actual bigint, expected bigint)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'ECHEC — % : attendu %, obtenu %', label, expected, actual;
  end if;
  raise notice 'ok   %', label;
end;
$$;

create or replace function pg_temp.check_refused(label text, stmt text)
returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'ECHEC — % : la requete aurait du etre refusee', label;
exception
  when sqlstate 'ISC01' or insufficient_privilege then
    raise notice 'ok   % (refuse)', label;
end;
$$;

-- --------------------------------------------------------------------------
-- An admin cannot destroy a tournament, only mark it
-- --------------------------------------------------------------------------
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';

delete from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001';
select pg_temp.check_equal(
  'un admin ne detruit pas son tournoi',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001'),
  1);

-- --------------------------------------------------------------------------
-- An archived tournament is frozen against content deletion
-- --------------------------------------------------------------------------
delete from public.pairings where id = 'eeeeeeee-0000-0000-0000-000000000002';
select pg_temp.check_equal(
  'appariement d''un archive non supprimable',
  (select count(*) from public.pairings where id = 'eeeeeeee-0000-0000-0000-000000000002'),
  1);

delete from public.rounds where id = 'dddddddd-0000-0000-0000-000000000002';
select pg_temp.check_equal(
  'ronde d''un archive non supprimable',
  (select count(*) from public.rounds where id = 'dddddddd-0000-0000-0000-000000000002'),
  1);

-- Note the shape: RLS refuses silently, by matching no row, rather than by
-- raising. Checking the effect is the only way to see it.
update public.pairings set result = null where id = 'eeeeeeee-0000-0000-0000-000000000002';
select pg_temp.check_equal(
  'resultat d''un archive non effacable',
  (select count(*) from public.pairings
    where id = 'eeeeeeee-0000-0000-0000-000000000002' and result = '1-0'),
  1);

-- An archived tournament is frozen outright now: correcting a result there
-- is refused too, where it used to be allowed. Deliberate change of rule.
delete from public.pairings where id = 'eeeeeeee-0000-0000-0000-000000000002';
select pg_temp.check_equal(
  'aucune ecriture sur un archive',
  (select count(*) from public.pairings
    where id = 'eeeeeeee-0000-0000-0000-000000000002' and result = '1-0'),
  1);

-- But an ongoing tournament stays workable.
update public.pairings set result = null where id = 'eeeeeeee-0000-0000-0000-000000000001';
select pg_temp.check_equal(
  'resultat effacable sur un tournoi en cours',
  (select count(*) from public.pairings
    where id = 'eeeeeeee-0000-0000-0000-000000000001' and result is null),
  1);

-- --------------------------------------------------------------------------
-- Soft deletion, and who sees what afterwards
-- --------------------------------------------------------------------------
-- Since 20260810120000_tournament_recovery, soft_delete_tournament takes a
-- reason and a name confirmation. The one-argument endpoint still exists but
-- is revoked from everyone, and a positional one-argument call is now
-- ambiguous between the two signatures — so every call below names the three.
reset role; reset test.uid;
set role authenticated;
set test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.check_refused(
  'un autre admin ne peut pas supprimer',
  $$select public.soft_delete_tournament(
      'cccccccc-0000-0000-0000-000000000001', null, 'En cours')$$);

reset role; reset test.uid;
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
-- An organizer no longer deletes a running tournament outright: it must be
-- cancelled first, so the players who signed up see why it disappeared.
select pg_temp.check_refused(
  'un tournoi en cours se supprime seulement apres annulation',
  $$select public.soft_delete_tournament(
      'cccccccc-0000-0000-0000-000000000001', null, 'En cours')$$);
select public.cancel_tournament(
  'cccccccc-0000-0000-0000-000000000001', 'Salle indisponible');
select public.soft_delete_tournament(
  'cccccccc-0000-0000-0000-000000000001', null, 'En cours');

select pg_temp.check_equal('le proprietaire ne voit plus son tournoi supprime',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001'), 0);
select pg_temp.check_equal('ni ses rondes',
  (select count(*) from public.rounds where tournament_id = 'cccccccc-0000-0000-0000-000000000001'), 0);
select pg_temp.check_equal('ni ses appariements',
  (select count(*) from public.pairings where round_id = 'dddddddd-0000-0000-0000-000000000001'), 0);
select pg_temp.check_equal('ni ses inscriptions',
  (select count(*) from public.tournament_players
    where tournament_id = 'cccccccc-0000-0000-0000-000000000001'), 0);

reset role; reset test.uid;
set role anon;
select pg_temp.check_equal('un visiteur anonyme ne voit rien du tournoi supprime',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001'), 0);
select pg_temp.check_equal('ni ses appariements',
  (select count(*) from public.pairings where round_id = 'dddddddd-0000-0000-0000-000000000001'), 0);

reset role;
set role authenticated;
set test.uid = '33333333-3333-3333-3333-333333333333';
select pg_temp.check_equal('le super_admin voit le tournoi supprime',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001'), 1);
select pg_temp.check_equal('et ses appariements',
  (select count(*) from public.pairings where round_id = 'dddddddd-0000-0000-0000-000000000001'), 1);

-- --------------------------------------------------------------------------
-- Restore and purge belong to the super_admin, in that order
-- --------------------------------------------------------------------------
reset role; reset test.uid;
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
update public.tournaments set deleted_at = null
  where id = 'cccccccc-0000-0000-0000-000000000001';
reset role; reset test.uid;
select pg_temp.check_equal('un admin ne restaure pas',
  (select count(*) from public.tournaments
    where id = 'cccccccc-0000-0000-0000-000000000001' and deleted_at is not null), 1);

set role authenticated;
set test.uid = '33333333-3333-3333-3333-333333333333';
-- A live tournament cannot be destroyed in one gesture: it goes through the
-- trash first. Restore it, then check the purge is refused.
update public.tournaments set deleted_at = null
  where id = 'cccccccc-0000-0000-0000-000000000001';
delete from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001';
reset role; reset test.uid;
select pg_temp.check_equal('un tournoi vivant ne se purge pas directement',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001'), 1);

set role authenticated;
set test.uid = '33333333-3333-3333-3333-333333333333';
-- A super_admin still has to retype the exact name, and give a reason for a
-- tournament that has already been played.
select pg_temp.check_refused('le super_admin retape le nom exact',
  $$select public.soft_delete_tournament(
      'cccccccc-0000-0000-0000-000000000001', 'Recette', 'Nom approximatif')$$);
select public.soft_delete_tournament(
  'cccccccc-0000-0000-0000-000000000001', 'Recette', 'En cours');
delete from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001';
reset role; reset test.uid;
select pg_temp.check_equal('le super_admin purge depuis la corbeille',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-000000000001'), 0);
select pg_temp.check_equal('la purge emporte les appariements en cascade',
  (select count(*) from public.pairings where round_id = 'dddddddd-0000-0000-0000-000000000001'), 0);

-- --------------------------------------------------------------------------
-- Life cycle
-- --------------------------------------------------------------------------
-- Everything above inserts as superuser, with RLS out of the way. That is
-- exactly how a broken INSERT policy went unnoticed: creation has to be
-- exercised as a real caller, with the RETURNING that PostgREST always adds.
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
insert into public.tournaments(id, name, format, rounds_planned, status, created_by, tiebreaks)
values ('cccccccc-0000-0000-0000-0000000000c0', 'Cree sous RLS', 'swiss', 3, 'draft',
        '11111111-1111-1111-1111-111111111111', array['buchholz', 'wins'])
returning id;
select pg_temp.check_equal('un admin cree son tournoi et le relit',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c0'), 1);
reset role; reset test.uid;

-- An organizer must keep sight of their own draft; another admin must not.
set role authenticated;
set test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.check_equal('un autre admin ne voit pas le brouillon d''autrui',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c0'), 0);
reset role; reset test.uid;

set role anon;
select pg_temp.check_refused('un anonyme ne peut pas appeler les transitions',
  $$select public.publish_tournament('cccccccc-0000-0000-0000-0000000000c0')$$);
reset role;
insert into public.tournaments(id, name, format, rounds_planned, status, created_by, tiebreaks)
values ('cccccccc-0000-0000-0000-0000000000c1', 'Cycle de vie', 'swiss', 1, 'draft',
        '11111111-1111-1111-1111-111111111111', array['buchholz', 'wins']);
insert into public.tournament_players(tournament_id, player_id) values
  ('cccccccc-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000002');

select pg_temp.check_equal('un slug est genere a la creation',
  (select count(*) from public.tournaments
    where id = 'cccccccc-0000-0000-0000-0000000000c1' and slug = 'cycle-de-vie'), 1);

set role anon;
select pg_temp.check_equal('un brouillon non publie est invisible du public',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c1'), 0);
reset role;

set role authenticated;
set test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.check_refused('un autre admin ne publie pas',
  $$select public.publish_tournament('cccccccc-0000-0000-0000-0000000000c1')$$);
reset role; reset test.uid;

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select public.publish_tournament('cccccccc-0000-0000-0000-0000000000c1');
reset role; reset test.uid;
set role anon;
select pg_temp.check_equal('publie, il devient visible',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c1'), 1);
reset role;

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select public.unpublish_tournament('cccccccc-0000-0000-0000-0000000000c1');
reset role; reset test.uid;
set role anon;
select pg_temp.check_equal('depublie, il redevient prive',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c1'), 0);
reset role;

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select public.publish_tournament('cccccccc-0000-0000-0000-0000000000c1');
select public.start_tournament('cccccccc-0000-0000-0000-0000000000c1');
reset role; reset test.uid;

-- Round 1 drawn inside start_tournament. Same shape as src/swiss.js draws
-- for a first round: the field in player-id order, paired two by two, the
-- odd seat left out. tests/swiss.test.js pins the engine to that shape.
select pg_temp.check_equal('demarrer cree la ronde 1',
  (select count(*) from public.rounds where tournament_id = 'cccccccc-0000-0000-0000-0000000000c1'), 1);
select pg_temp.check_equal('avec un appariement par echiquier',
  (select count(*) from public.pairings p join public.rounds r on r.id = p.round_id
    where r.tournament_id = 'cccccccc-0000-0000-0000-0000000000c1'), 1);
select pg_temp.check_equal('les blancs vont au premier joueur dans l''ordre',
  (select count(*) from public.pairings p join public.rounds r on r.id = p.round_id
    where r.tournament_id = 'cccccccc-0000-0000-0000-0000000000c1'
      and p.white_player_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      and p.black_player_id = 'aaaaaaaa-0000-0000-0000-000000000002'
      and p.board = 1), 1);

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check_refused('un second demarrage est refuse',
  $$select public.start_tournament('cccccccc-0000-0000-0000-0000000000c1')$$);
select pg_temp.check_refused('un tournoi demarre ne se depublie pas',
  $$select public.unpublish_tournament('cccccccc-0000-0000-0000-0000000000c1')$$);

select pg_temp.check_refused('cloture refusee avant validation de la derniere ronde',
  $$select public.finish_tournament('cccccccc-0000-0000-0000-0000000000c1')$$);
update public.pairings set result='1-0'
 where round_id=(select id from public.rounds where tournament_id='cccccccc-0000-0000-0000-0000000000c1' and number=1);
select public.validate_round((select id from public.rounds where tournament_id='cccccccc-0000-0000-0000-0000000000c1' and number=1));
select public.finish_tournament('cccccccc-0000-0000-0000-0000000000c1');
reset role; reset test.uid;
select pg_temp.check_equal('la cloture archive et date',
  (select count(*) from public.tournaments
    where id = 'cccccccc-0000-0000-0000-0000000000c1'
      and status = 'archived' and finished_at is not null), 1);

-- Cancelling: frozen, and the public page survives only if it was published.
insert into public.tournaments(id, name, format, rounds_planned, status, created_by, tiebreaks)
values ('cccccccc-0000-0000-0000-0000000000c2', 'Annule publie', 'swiss', 3, 'draft',
        '11111111-1111-1111-1111-111111111111', array['buchholz', 'wins']),
       ('cccccccc-0000-0000-0000-0000000000c3', 'Annule jamais publie', 'swiss', 3, 'draft',
        '11111111-1111-1111-1111-111111111111', array['buchholz', 'wins']);
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select public.publish_tournament('cccccccc-0000-0000-0000-0000000000c2');
select public.cancel_tournament('cccccccc-0000-0000-0000-0000000000c2', 'Salle indisponible');
select public.cancel_tournament('cccccccc-0000-0000-0000-0000000000c3', null);
select pg_temp.check_refused('une seconde annulation est refusee',
  $$select public.cancel_tournament('cccccccc-0000-0000-0000-0000000000c2', 'encore')$$);
reset role; reset test.uid;

set role anon;
select pg_temp.check_equal('annule apres publication : la page reste',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c2'), 1);
select pg_temp.check_equal('annule sans avoir ete publie : rien de public',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c3'), 0);
reset role;

-- A cancelled tournament takes no further result: the freeze runs through
-- can_write_tournament, so the update simply matches nothing.
insert into public.rounds(id, tournament_id, number)
values ('dddddddd-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-0000000000c2', 1);
insert into public.pairings(id, round_id, white_player_id, black_player_id, result, board)
values ('eeeeeeee-0000-0000-0000-0000000000c2', 'dddddddd-0000-0000-0000-0000000000c2',
        'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', null, 1);
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
update public.pairings set result = '1-0' where id = 'eeeeeeee-0000-0000-0000-0000000000c2';
reset role; reset test.uid;
select pg_temp.check_equal('aucun resultat nouveau sur un tournoi annule',
  (select count(*) from public.pairings
    where id = 'eeeeeeee-0000-0000-0000-0000000000c2' and result is null), 1);

-- Cancelling freezes; it does not erase. The organizer keeps seeing their
-- tournament, and the published page cannot be taken down afterwards.
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check_equal('le proprietaire voit encore son annule non publie',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c3'), 1);
select pg_temp.check_refused('un annule ne se depublie pas',
  $$select public.unpublish_tournament('cccccccc-0000-0000-0000-0000000000c2')$$);
reset role; reset test.uid;
set role anon;
select pg_temp.check_equal('sa page publique tient toujours',
  (select count(*) from public.tournaments where id = 'cccccccc-0000-0000-0000-0000000000c2'), 1);
reset role;

select pg_temp.check_equal('le motif d''annulation est conserve',
  (select count(*) from public.tournaments
    where id = 'cccccccc-0000-0000-0000-0000000000c2'
      and cancellation_reason = 'Salle indisponible'), 1);

-- Starting needs a real field.
insert into public.tournaments(id, name, format, rounds_planned, status, created_by, tiebreaks)
values ('cccccccc-0000-0000-0000-0000000000c4', 'Trop peu', 'swiss', 3, 'draft',
        '11111111-1111-1111-1111-111111111111', array['buchholz', 'wins']);
insert into public.tournament_players(tournament_id, player_id) values
  ('cccccccc-0000-0000-0000-0000000000c4', 'aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check_refused('un seul joueur ne suffit pas pour demarrer',
  $$select public.start_tournament('cccccccc-0000-0000-0000-0000000000c4')$$);
reset role; reset test.uid;

-- Starting assumes an empty schedule; the guard says so instead of failing
-- on a unique-violation deep in the insert.
insert into public.rounds(tournament_id, number)
values ('cccccccc-0000-0000-0000-0000000000c4', 1);
insert into public.tournament_players(tournament_id, player_id)
values ('cccccccc-0000-0000-0000-0000000000c4', 'aaaaaaaa-0000-0000-0000-000000000002');
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check_refused('un tournoi ayant deja des rondes ne redemarre pas',
  $$select public.start_tournament('cccccccc-0000-0000-0000-0000000000c4')$$);
reset role; reset test.uid;

select pg_temp.check_equal('les slugs restent uniques entre tournois vivants',
  (select count(*) from (select slug from public.tournaments
     where deleted_at is null group by slug having count(*) > 1) d), 0);

-- A round-robin draft already owns its complete calendar. It remains
-- read-only until the explicit start transition, which validates the round
-- count and changes only the tournament lifecycle fields.
insert into public.tournaments(id, name, format, rounds_planned, status, created_by, tiebreaks)
values ('cccccccc-0000-0000-0000-0000000000c5', 'Toutes rondes prepare',
        'round_robin', 2, 'draft', '11111111-1111-1111-1111-111111111111',
        array['buchholz', 'wins']);
insert into public.tournament_players(tournament_id, player_id) values
  ('cccccccc-0000-0000-0000-0000000000c5', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-0000000000c5', 'aaaaaaaa-0000-0000-0000-000000000002');
insert into public.rounds(id, tournament_id, number) values
  ('dddddddd-0000-0000-0000-0000000000c5', 'cccccccc-0000-0000-0000-0000000000c5', 1),
  ('dddddddd-0000-0000-0000-0000000000c6', 'cccccccc-0000-0000-0000-0000000000c5', 2);
insert into public.pairings(id, round_id, white_player_id, black_player_id, result, board) values
  ('eeeeeeee-0000-0000-0000-0000000000c5', 'dddddddd-0000-0000-0000-0000000000c5',
   'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', null, 1),
  ('eeeeeeee-0000-0000-0000-0000000000c6', 'dddddddd-0000-0000-0000-0000000000c6',
   'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', null, 1);

set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select pg_temp.check_refused('aucun resultat avant le demarrage toutes rondes',
  $$update public.pairings set result = '1-0'
      where id = 'eeeeeeee-0000-0000-0000-0000000000c5'$$);
select public.start_tournament('cccccccc-0000-0000-0000-0000000000c5');
select pg_temp.check_refused('validation avec resultat manquant refusee',
  $$select public.validate_round('dddddddd-0000-0000-0000-0000000000c5')$$);
reset role; reset test.uid;
set role anon;
select pg_temp.check_equal('ronde suivante invisible avant validation',
  (select count(*) from public.rounds where tournament_id='cccccccc-0000-0000-0000-0000000000c5'), 1);
select pg_temp.check_equal('appariement futur invisible avant validation',
  (select count(*) from public.pairings where id='eeeeeeee-0000-0000-0000-0000000000c6'), 0);
reset role;
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
update public.pairings set result = '1-0'
 where id = 'eeeeeeee-0000-0000-0000-0000000000c5';
select public.validate_round('dddddddd-0000-0000-0000-0000000000c5');
select pg_temp.check_refused('resultat verrouille apres validation',
  $$update public.pairings set result='0-1' where id='eeeeeeee-0000-0000-0000-0000000000c5'$$);
reset role; reset test.uid;

select pg_temp.check_equal('toutes rondes demarre et date sans regenerer',
  (select count(*) from public.tournaments
    where id = 'cccccccc-0000-0000-0000-0000000000c5'
      and status = 'ongoing' and started_at is not null), 1);
select pg_temp.check_equal('le calendrier toutes rondes reste intact',
  (select count(*) from public.rounds
    where tournament_id = 'cccccccc-0000-0000-0000-0000000000c5'), 2);
select pg_temp.check_equal('la saisie devient possible apres demarrage',
  (select count(*) from public.pairings
    where id = 'eeeeeeee-0000-0000-0000-0000000000c5' and result = '1-0'), 1);
select pg_temp.check_equal('validation toutes rondes journalisee sur la ronde',
  (select count(*) from public.rounds where id='dddddddd-0000-0000-0000-0000000000c5'
    and validated_at is not null and validated_by='11111111-1111-1111-1111-111111111111'), 1);
set role anon;
select pg_temp.check_equal('ronde suivante visible apres validation',
  (select count(*) from public.rounds where tournament_id='cccccccc-0000-0000-0000-0000000000c5'), 2);
reset role;
select pg_temp.check_equal('resultats verrouilles apres validation',
  (select count(*) from public.pairings where id='eeeeeeee-0000-0000-0000-0000000000c5' and result='1-0'), 1);

-- --------------------------------------------------------------------------
-- Transactional tournament creation
-- --------------------------------------------------------------------------
set role anon;
select pg_temp.check_refused('creation transactionnelle interdite au public',
  $$select public.create_tournament_with_players(
    '90000000-0000-0000-0000-000000000001','{}',array[]::uuid[],null,false)$$);
reset role;
set role authenticated;
set test.uid='11111111-1111-1111-1111-111111111111';
select public.create_tournament_with_players(
  '90000000-0000-0000-0000-000000000001',
  '{"name":"Creation atomique suisse","format":"swiss","rounds_planned":1,"rating_type":"rapid","ranking_type":"elo","fide_rated":false,"tiebreaks":["buchholz","wins"]}',
  array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002']::uuid[],null,false);
-- Same idempotency key returns the original row rather than creating twice.
select public.create_tournament_with_players(
  '90000000-0000-0000-0000-000000000001',
  '{"name":"Ignore lors du retry","format":"swiss","rounds_planned":1,"tiebreaks":["buchholz","wins"]}',
  array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002']::uuid[],null,false);
reset role; reset test.uid;
select pg_temp.check_equal('retry idempotent : un seul tournoi',
  (select count(*) from public.tournaments where name='Creation atomique suisse'),1);
select pg_temp.check_equal('suisse cree participants sans ronde',
  (select count(*) from public.tournament_players tp join public.tournaments t on t.id=tp.tournament_id where t.name='Creation atomique suisse'),2);
select pg_temp.check_equal('aucune ronde suisse avant demarrage',
  (select count(*) from public.rounds r join public.tournaments t on t.id=r.tournament_id where t.name='Creation atomique suisse'),0);

set role authenticated;
set test.uid='11111111-1111-1111-1111-111111111111';
select pg_temp.check_refused('calendrier invalide annule toute la transaction',
  $$select public.create_tournament_with_players(
    '90000000-0000-0000-0000-000000000002',
    '{"name":"Doit rollback","format":"round_robin","rounds_planned":1,"tiebreaks":["buchholz","wins"]}',
    array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002']::uuid[],
    '[[{"white":"aaaaaaaa-0000-0000-0000-000000000001","black":"aaaaaaaa-0000-0000-0000-000000000002","result":"1-0"}]]',false)$$);
reset role; reset test.uid;
select pg_temp.check_equal('echec : zero tournoi partiel',(select count(*) from public.tournaments where name='Doit rollback'),0);
select pg_temp.check_equal('echec : zero cle idempotente partielle',(select count(*) from public.tournament_creation_requests where request_id='90000000-0000-0000-0000-000000000002'),0);

set role authenticated; set test.uid='11111111-1111-1111-1111-111111111111';
select public.create_tournament_with_players(
  '90000000-0000-0000-0000-000000000003',
  '{"name":"Cercle atomique","format":"round_robin","rounds_planned":99,"tiebreaks":["buchholz","wins"]}',
  array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002']::uuid[],
  '[[{"white":"aaaaaaaa-0000-0000-0000-000000000001","black":"aaaaaaaa-0000-0000-0000-000000000002","result":null}]]',true);
reset role; reset test.uid;
select pg_temp.check_equal('cercle atomique : tournoi, joueurs, ronde et appariement',
  (select count(*) from public.tournaments t join public.tournament_players tp on tp.tournament_id=t.id join public.rounds r on r.tournament_id=t.id join public.pairings p on p.round_id=r.id where t.name='Cercle atomique'),2);
select pg_temp.check_equal('cercle publie facultativement et nombre de rondes recalcule',
  (select count(*) from public.tournaments where name='Cercle atomique' and published_at is not null and rounds_planned=1),1);

-- Player merge is super-admin only and repoints references transactionally.
-- The realistic duplicate: a locally created sheet, with no FIDE identity,
-- absorbed by the official one. Since 20260812120000_safe_player_merge, a
-- source that carries its own distinct FIDE id is refused outright.
insert into public.players(id,name,fide_id) values
 ('aaaaaaaa-0000-0000-0000-000000000010','Doublon source',null),
 ('aaaaaaaa-0000-0000-0000-000000000011','Joueur cible',900002),
 ('aaaaaaaa-0000-0000-0000-000000000012','Autre identite FIDE',900001);
insert into public.tournament_players(tournament_id,player_id) values
 ('cccccccc-0000-0000-0000-0000000000c5','aaaaaaaa-0000-0000-0000-000000000010');
insert into public.rounds(id,tournament_id,number,released_at) values
 ('dddddddd-0000-0000-0000-000000000010','cccccccc-0000-0000-0000-0000000000c5',3,now());
insert into public.pairings(id,round_id,board,white_player_id,black_player_id) values
 ('eeeeeeee-0000-0000-0000-000000000010','dddddddd-0000-0000-0000-000000000010',1,
  'aaaaaaaa-0000-0000-0000-000000000010','aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;set test.uid='11111111-1111-1111-1111-111111111111';
select pg_temp.check_refused('admin ne modifie pas une donnee FIDE synchronisee',
 $$update public.players set fide_title='GM' where id='aaaaaaaa-0000-0000-0000-000000000010'$$);
update public.players set club='Club local' where id='aaaaaaaa-0000-0000-0000-000000000010';
select pg_temp.check_refused('admin non super ne fusionne pas',
 $$select public.merge_players('aaaaaaaa-0000-0000-0000-000000000010','aaaaaaaa-0000-0000-0000-000000000011','doublon')$$);
reset role;reset test.uid;set role authenticated;set test.uid='33333333-3333-3333-3333-333333333333';
select pg_temp.check_refused('deux identites FIDE distinctes ne fusionnent pas',
 $$select public.merge_players('aaaaaaaa-0000-0000-0000-000000000012','aaaaaaaa-0000-0000-0000-000000000011','doublon FIDE')$$);
select pg_temp.check_refused('la fiche FIDE doit rester la fiche principale',
 $$select public.merge_players('aaaaaaaa-0000-0000-0000-000000000011','aaaaaaaa-0000-0000-0000-000000000010','cible sans FIDE')$$);
select public.merge_players('aaaaaaaa-0000-0000-0000-000000000010','aaaaaaaa-0000-0000-0000-000000000011','doublon local');
reset role;reset test.uid;
select pg_temp.check_equal('fusion marque la source',(select count(*) from public.players where id='aaaaaaaa-0000-0000-0000-000000000010' and merged_into='aaaaaaaa-0000-0000-0000-000000000011'),1);
select pg_temp.check_equal('fusion deplace les inscriptions',(select count(*) from public.tournament_players where tournament_id='cccccccc-0000-0000-0000-0000000000c5' and player_id='aaaaaaaa-0000-0000-0000-000000000011'),1);
select pg_temp.check_equal('fusion deplace les appariements',(select count(*) from public.pairings where id='eeeeeeee-0000-0000-0000-000000000010' and white_player_id='aaaaaaaa-0000-0000-0000-000000000011'),1);

-- Club scoping: public, A, B, disabled member, unscoped legacy admin, super-admin.
insert into auth.users(id) values
 ('44444444-4444-4444-4444-444444444444'),('55555555-5555-5555-5555-555555555555');
insert into public.profiles(id,role) values
 ('44444444-4444-4444-4444-444444444444','admin'),('55555555-5555-5555-5555-555555555555','admin');
insert into public.clubs(id,name,slug,active) values
 ('bbbbbbbb-0000-0000-0000-000000000001','Club A','club-a',true),
 ('bbbbbbbb-0000-0000-0000-000000000002','Club B','club-b',true),
 ('bbbbbbbb-0000-0000-0000-000000000003','Club masqué','club-masque',false);
insert into public.club_memberships(club_id,user_id,role,active) values
 ('bbbbbbbb-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','owner',true),
 ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','admin',true),
 ('bbbbbbbb-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','admin',false);
set role authenticated;set test.uid='11111111-1111-1111-1111-111111111111';
select public.create_tournament_with_players(
 '90000000-0000-0000-0000-000000000009',
 '{"name":"Création Club A","format":"swiss","rounds_planned":1,"tiebreaks":["buchholz","wins"]}',
 array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002']::uuid[],null,false);
reset role;reset test.uid;
select pg_temp.check_equal('creation atomique rattache le club unique',(select count(*) from public.tournaments where name='Création Club A' and club_id='bbbbbbbb-0000-0000-0000-000000000001'),1);
insert into public.tournaments(id,name,format,rounds_planned,status,created_by,club_id) values
 ('cccccccc-0000-0000-0000-0000000000a1','Tournoi A','swiss',3,'draft','11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000001'),
 ('cccccccc-0000-0000-0000-0000000000b1','Tournoi B','swiss',3,'draft','22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000002'),
 ('cccccccc-0000-0000-0000-0000000000d1','Tournoi personnel','swiss',3,'draft','55555555-5555-5555-5555-555555555555',null);
set role anon;
select pg_temp.check_equal('public voit les clubs actifs',(select count(*) from public.clubs where slug in('club-a','club-b')),2);
select pg_temp.check_equal('public ne voit pas le club inactif',(select count(*) from public.clubs where slug='club-masque'),0);
select pg_temp.check_equal('public ne voit aucune membership',(select count(*) from public.club_memberships),0);
reset role;set role authenticated;set test.uid='11111111-1111-1111-1111-111111111111';
update public.tournaments set description='A autorise' where id='cccccccc-0000-0000-0000-0000000000a1';
select pg_temp.check_equal('admin A gere le tournoi A',(select count(*) from public.tournaments where id='cccccccc-0000-0000-0000-0000000000a1' and description='A autorise'),1);
update public.tournaments set description='interdit' where id='cccccccc-0000-0000-0000-0000000000b1';
select pg_temp.check_equal('admin A ne gere pas le tournoi B',(select count(*) from public.tournaments where id='cccccccc-0000-0000-0000-0000000000b1' and description='interdit'),0);
reset role;reset test.uid;set role authenticated;set test.uid='22222222-2222-2222-2222-222222222222';
update public.tournaments set description='B autorise' where id='cccccccc-0000-0000-0000-0000000000b1';
select pg_temp.check_equal('admin B gere le tournoi B',(select count(*) from public.tournaments where id='cccccccc-0000-0000-0000-0000000000b1' and description='B autorise'),1);
reset role;reset test.uid;set role authenticated;set test.uid='44444444-4444-4444-4444-444444444444';
update public.tournaments set description='interdit' where id='cccccccc-0000-0000-0000-0000000000a1';
select pg_temp.check_equal('membre desactive sans ecriture',(select count(*) from public.tournaments where id='cccccccc-0000-0000-0000-0000000000a1' and description='interdit'),0);
reset role;reset test.uid;set role authenticated;set test.uid='55555555-5555-5555-5555-555555555555';
update public.tournaments set description='heritage conserve' where id='cccccccc-0000-0000-0000-0000000000d1';
select pg_temp.check_equal('admin sans club conserve son tournoi personnel',(select count(*) from public.tournaments where id='cccccccc-0000-0000-0000-0000000000d1' and description='heritage conserve'),1);
reset role;reset test.uid;set role authenticated;set test.uid='33333333-3333-3333-3333-333333333333';
update public.tournaments set description='super' where id in('cccccccc-0000-0000-0000-0000000000a1','cccccccc-0000-0000-0000-0000000000b1');
select pg_temp.check_equal('super admin gere tous les clubs',(select count(*) from public.tournaments where description='super'),2);
reset role;reset test.uid;

\echo ''
\echo 'Toutes les verifications RLS sont passees.'
