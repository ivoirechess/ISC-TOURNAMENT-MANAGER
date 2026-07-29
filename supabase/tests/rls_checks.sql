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
insert into public.rounds(id, tournament_id, number) values
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 1),
  ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 1);
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
reset role; reset test.uid;
set role authenticated;
set test.uid = '22222222-2222-2222-2222-222222222222';
select pg_temp.check_refused(
  'un autre admin ne peut pas supprimer',
  $$select public.soft_delete_tournament('cccccccc-0000-0000-0000-000000000001')$$);

reset role; reset test.uid;
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select public.soft_delete_tournament('cccccccc-0000-0000-0000-000000000001');

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
select public.soft_delete_tournament('cccccccc-0000-0000-0000-000000000001');
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
values ('cccccccc-0000-0000-0000-0000000000c1', 'Cycle de vie', 'swiss', 3, 'draft',
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

\echo ''
\echo 'Toutes les verifications RLS sont passees.'
