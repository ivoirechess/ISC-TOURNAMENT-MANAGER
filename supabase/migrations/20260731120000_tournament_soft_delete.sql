-- Soft deletion for tournaments.
--
-- An admin never destroys anything: deleting marks `deleted_at`, which
-- hides the tournament from everyone — the public and the admins alike,
-- including its own owner. Only a super_admin still sees it, in the trash,
-- and only a super_admin can restore it or destroy it for good.
--
-- This migration therefore REPLACES several policies from the initial
-- schema. Every replacement is spelled out below with what it changes.

alter table public.tournaments
  add column deleted_at timestamptz default null;

create index tournaments_not_deleted_idx
  on public.tournaments (deleted_at)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Reading: a deleted tournament disappears
-- ---------------------------------------------------------------------------
-- Was: `using (true)`. Now the row is visible only while it is not deleted,
-- or to a super_admin. Everything else keys off this one policy: the child
-- tables below test the parent's visibility rather than repeating the rule,
-- so there is a single place where "deleted" is defined.

drop policy "tournaments are readable by everyone" on public.tournaments;

create policy "tournaments are readable unless deleted"
  on public.tournaments for select
  using (deleted_at is null or public.is_super_admin());

-- The children of a deleted tournament must vanish with it, otherwise its
-- rounds, pairings and player list would stay readable and the tournament
-- could be reconstructed from them.
--
-- These policies rely on RLS applying to the tournaments reference inside
-- the sub-select: a deleted tournament is already invisible there, so the
-- EXISTS simply finds nothing. Deliberately not wrapped in a SECURITY
-- DEFINER helper, which would bypass exactly the policy being leaned on.

drop policy "tournament_players are readable by everyone" on public.tournament_players;

create policy "tournament_players follow their tournament"
  on public.tournament_players for select
  using (
    exists (select 1 from public.tournaments t where t.id = tournament_id)
  );

drop policy "rounds are readable by everyone" on public.rounds;

create policy "rounds follow their tournament"
  on public.rounds for select
  using (
    exists (select 1 from public.tournaments t where t.id = tournament_id)
  );

drop policy "pairings are readable by everyone" on public.pairings;

create policy "pairings follow their round"
  on public.pairings for select
  using (
    exists (select 1 from public.rounds r where r.id = round_id)
  );

-- ---------------------------------------------------------------------------
-- Writing: an admin marks, only a super_admin destroys
-- ---------------------------------------------------------------------------
-- Was: `using (public.can_write_tournament(id))`, which let the owning admin
-- destroy the row. There is now no real DELETE for an admin at all: the only
-- deletion within reach is setting `deleted_at`, through the UPDATE policy.

drop policy "owner or super_admin deletes tournaments" on public.tournaments;

create policy "only super_admin deletes tournaments for good"
  on public.tournaments for delete
  to authenticated
  using (public.is_super_admin());

-- A deleted tournament is frozen: no more results, rounds or players may be
-- written to it. Restoring it is a super_admin decision, and this function
-- lets one through unchanged.
create or replace function public.can_write_tournament(t_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin()
      or (public.is_admin()
          and exists (
            select 1 from public.tournaments t
            where t.id = t_id
              and t.created_by = auth.uid()
              and t.deleted_at is null
          ));
$$;

-- ---------------------------------------------------------------------------
-- Marking a tournament deleted
-- ---------------------------------------------------------------------------
-- Why a function rather than a plain UPDATE on `deleted_at`:
--
-- PostgreSQL requires the updated row to still satisfy the SELECT policy.
-- Since a deleted tournament must become invisible to its own owner, the
-- owner cannot perform that UPDATE — the row would vanish from under them
-- and the write is rejected. Verified on PostgreSQL 16: the same statement
-- succeeds the moment the SELECT policy is relaxed.
--
-- The two requirements — "an admin marks it" and "it disappears for admins"
-- — cannot both hold through RLS alone. So the marking goes through this
-- function, which is SECURITY DEFINER *only* to get past that one obstacle
-- and re-implements the very same ownership test the policies use. It takes
-- no other parameter, writes no other column, and grants nothing else:
-- calling it on someone else's tournament raises, exactly as RLS would.

create or replace function public.soft_delete_tournament(t_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  marked timestamptz;
begin
  if not (
    public.is_super_admin()
    or (public.is_admin() and exists (
          select 1 from public.tournaments t
          where t.id = t_id
            and t.created_by = auth.uid()
            and t.deleted_at is null
        ))
  ) then
    raise exception 'Vous n''avez pas le droit de supprimer ce tournoi.'
      using errcode = 'ISC01';
  end if;

  update public.tournaments
     set deleted_at = now()
   where id = t_id and deleted_at is null
   returning deleted_at into marked;

  if marked is null then
    raise exception 'Ce tournoi est introuvable ou deja supprime.'
      using errcode = 'ISC01';
  end if;
  return marked;
end;
$$;

-- Anonymous visitors have no business calling it; the ownership test above
-- would refuse them anyway, but the grant says so up front.
revoke execute on function public.soft_delete_tournament(uuid) from public;
grant execute on function public.soft_delete_tournament(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Clearing a result
-- ---------------------------------------------------------------------------
-- Emptying a result (back to NULL) is only meaningful while the tournament
-- is running: not on a draft, which has nothing played, and not on an
-- archive, whose standings are published. Correcting a result to another
-- result stays allowed at any stage, as before.
--
-- Replaces the function installed by 20260730120000; the trigger already
-- points at this name, so it picks the new body up.

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

  if new.result is null and old.result is not null then
    select t.status into parent_status
      from public.rounds r
      join public.tournaments t on t.id = r.tournament_id
     where r.id = old.round_id;

    if parent_status is distinct from 'ongoing' then
      raise exception
        'Un resultat ne peut etre efface que sur un tournoi en cours (statut %).',
        coalesce(parent_status::text, 'inconnu')
        using errcode = 'ISC01';
    end if;

    if old.result = 'bye' then
      raise exception 'Un exempt ne peut pas etre efface.'
        using errcode = 'ISC01';
    end if;
  end if;

  return new;
end;
$$;
