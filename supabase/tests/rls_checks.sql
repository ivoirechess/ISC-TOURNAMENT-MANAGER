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

select pg_temp.check_refused(
  'resultat d''un archive non effacable',
  $$update public.pairings set result = null where id = 'eeeeeeee-0000-0000-0000-000000000002'$$);

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

\echo ''
\echo 'Toutes les verifications RLS sont passees.'
