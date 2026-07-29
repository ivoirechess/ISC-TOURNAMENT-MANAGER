-- A tournament must never be born deleted.
--
-- 20260731120000 added `deleted_at` but left it unconstrained on INSERT:
-- the WITH CHECK of "admins create their own tournaments" only looks at the
-- role and at `created_by`. A caller could therefore create a tournament
-- with `deleted_at` already set — straight into the trash, visible to no
-- one but a super_admin, and unreachable for its own author.
--
-- It also produced a thoroughly opaque failure. PostgREST always inserts
-- with RETURNING, and PostgreSQL requires a returned row to satisfy the
-- SELECT policy; a non-super_admin creating such a row therefore got
-- `42501 new row violates row-level security policy for table "tournaments"`
-- with nothing pointing at `deleted_at`. Reproduced on PostgreSQL 16 before
-- this fix.
--
-- Note this is a WITH CHECK addition only: no existing policy is dropped,
-- and the INSERT policies of `tournaments` and `tournament_players` are
-- otherwise exactly the ones from the initial schema.

drop policy "admins create their own tournaments" on public.tournaments;

create policy "admins create their own tournaments"
  on public.tournaments for insert
  to authenticated
  with check (
    deleted_at is null
    and (
      public.is_super_admin()
      or (public.is_admin() and created_by = auth.uid())
    )
  );
