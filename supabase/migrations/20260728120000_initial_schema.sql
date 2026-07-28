-- Initial schema and RLS policies for ISC Tournament Manager.
--
-- Access model (see CLAUDE.md):
--   - public (no account): read-only access to everything
--   - admin: can create tournaments; can write only inside their own
--   - super_admin: can write everywhere and manage roles
--
-- Enforcement lives HERE, server-side, in RLS. Browser-side checks are
-- interface comfort only, never a protection.
--
-- No policy references or requires the service_role key. Bootstrapping the
-- first super_admin is done once by the project owner from the Supabase
-- dashboard SQL editor (insert into public.profiles), not from any code in
-- this repository.

-- ---------------------------------------------------------------------------
-- profiles — links auth.users to an application role
-- ---------------------------------------------------------------------------
-- Visitors without an account have no row here: they are implicitly
-- "public" (read-only). Only super_admin manages roles.
--
-- The table comes first, then the helper functions that read it (their SQL
-- bodies are validated at creation time), then the policies that call them.
-- RLS is enabled right after CREATE TABLE, before any policy exists: within
-- this transaction the table is briefly deny-all, never unprotected.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('super_admin', 'admin')),
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Helper functions. SECURITY DEFINER so policies on profiles can call them
-- without recursing through profiles' own RLS. search_path is pinned
-- against hijacking.

create or replace function public.user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.user_role() in ('admin', 'super_admin'), false);
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.user_role() = 'super_admin', false);
$$;

-- Note: a super_admin can demote or delete their own profile; the last
-- super_admin can therefore lock themselves out (recoverable from the
-- Supabase dashboard SQL editor, like the initial bootstrap).

create policy "profiles are readable by everyone"
  on public.profiles for select
  using (true);

create policy "only super_admin inserts profiles"
  on public.profiles for insert
  to authenticated
  with check (public.is_super_admin());

create policy "only super_admin updates profiles"
  on public.profiles for update
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy "only super_admin deletes profiles"
  on public.profiles for delete
  to authenticated
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- players — permanent directory, independent from tournaments
-- ---------------------------------------------------------------------------
-- Only name is required. FIDE provides the federation, never the club:
-- club is entered by hand. Shared directory: any admin may edit it.

create table public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  fide_id integer unique,
  club text,
  sex text check (sex in ('M', 'F')),
  birth_year smallint check (birth_year between 1900 and 2100),
  rating_std smallint check (rating_std between 0 and 4000),
  rating_rapid smallint check (rating_rapid between 0 and 4000),
  rating_blitz smallint check (rating_blitz between 0 and 4000),
  created_at timestamptz not null default now()
);

alter table public.players enable row level security;

create policy "players are readable by everyone"
  on public.players for select
  using (true);

create policy "admins insert players"
  on public.players for insert
  to authenticated
  with check (public.is_admin());

create policy "admins update players"
  on public.players for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "admins delete players"
  on public.players for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- tournaments
-- ---------------------------------------------------------------------------
-- v1 only enables the swiss format in the UI; the other formats exist in
-- the enum so the data model will not need a migration when they arrive.

create type public.tournament_format as enum
  ('swiss', 'round_robin', 'knockout', 'double_round_robin');

create type public.tournament_status as enum
  ('draft', 'ongoing', 'archived');

create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  format public.tournament_format not null default 'swiss',
  rounds_planned integer not null check (rounds_planned >= 1),
  status public.tournament_status not null default 'draft',
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.tournaments enable row level security;

-- Ownership helper, defined once tournaments exists. Writes on child tables
-- (tournament_players, rounds, pairings) all funnel through it.
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
            where t.id = t_id and t.created_by = auth.uid()
          ));
$$;

create policy "tournaments are readable by everyone"
  on public.tournaments for select
  using (true);

-- An admin creates tournaments only in their own name; super_admin may
-- create on behalf of anyone.
create policy "admins create their own tournaments"
  on public.tournaments for insert
  to authenticated
  with check (
    public.is_super_admin()
    or (public.is_admin() and created_by = auth.uid())
  );

create policy "owner or super_admin updates tournaments"
  on public.tournaments for update
  to authenticated
  using (public.can_write_tournament(id))
  with check (
    public.is_super_admin()
    or (public.is_admin() and created_by = auth.uid())
  );

create policy "owner or super_admin deletes tournaments"
  on public.tournaments for delete
  to authenticated
  using (public.can_write_tournament(id));

-- ---------------------------------------------------------------------------
-- tournament_players — junction table
-- ---------------------------------------------------------------------------
-- A tournament references permanent players, it never copies them.
-- withdrawn mirrors the engine's player model (src/swiss.js).

create table public.tournament_players (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete restrict,
  withdrawn boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

alter table public.tournament_players enable row level security;

create policy "tournament_players are readable by everyone"
  on public.tournament_players for select
  using (true);

create policy "owner or super_admin inserts tournament_players"
  on public.tournament_players for insert
  to authenticated
  with check (public.can_write_tournament(tournament_id));

create policy "owner or super_admin updates tournament_players"
  on public.tournament_players for update
  to authenticated
  using (public.can_write_tournament(tournament_id))
  with check (public.can_write_tournament(tournament_id));

create policy "owner or super_admin deletes tournament_players"
  on public.tournament_players for delete
  to authenticated
  using (public.can_write_tournament(tournament_id));

-- ---------------------------------------------------------------------------
-- rounds
-- ---------------------------------------------------------------------------

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  number integer not null check (number >= 1),
  created_at timestamptz not null default now(),
  unique (tournament_id, number)
);

alter table public.rounds enable row level security;

create policy "rounds are readable by everyone"
  on public.rounds for select
  using (true);

create policy "owner or super_admin inserts rounds"
  on public.rounds for insert
  to authenticated
  with check (public.can_write_tournament(tournament_id));

create policy "owner or super_admin updates rounds"
  on public.rounds for update
  to authenticated
  using (public.can_write_tournament(tournament_id))
  with check (public.can_write_tournament(tournament_id));

create policy "owner or super_admin deletes rounds"
  on public.rounds for delete
  to authenticated
  using (public.can_write_tournament(tournament_id));

-- ---------------------------------------------------------------------------
-- pairings — mirrors the engine's {white, black, result} model
-- ---------------------------------------------------------------------------
-- black_player_id null means a bye; a bye's result is always 'bye' and is
-- worth 1 point. result null means the game has not been played yet.

create table public.pairings (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  white_player_id uuid not null references public.players (id) on delete restrict,
  black_player_id uuid references public.players (id) on delete restrict,
  result text check (result in ('1-0', '0-1', '1/2-1/2', 'bye')),
  board integer check (board >= 1),
  created_at timestamptz not null default now(),
  check (white_player_id <> black_player_id),
  check (
    (black_player_id is null and result = 'bye')
    or (black_player_id is not null and (result is null or result <> 'bye'))
  ),
  unique (round_id, board)
);

-- The engine's invariants (each player paired once per round, opponents
-- registered in the tournament, single bye...) are not duplicated as
-- database constraints: the pairing engine is the source of pairings, and
-- RLS already restricts writers to the tournament's own organizer.

alter table public.pairings enable row level security;

-- Round -> tournament ownership, resolved once per policy check.
create or replace function public.can_write_round(r_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.rounds r
    where r.id = r_id and public.can_write_tournament(r.tournament_id)
  );
$$;

create policy "pairings are readable by everyone"
  on public.pairings for select
  using (true);

create policy "owner or super_admin inserts pairings"
  on public.pairings for insert
  to authenticated
  with check (public.can_write_round(round_id));

create policy "owner or super_admin updates pairings"
  on public.pairings for update
  to authenticated
  using (public.can_write_round(round_id))
  with check (public.can_write_round(round_id));

create policy "owner or super_admin deletes pairings"
  on public.pairings for delete
  to authenticated
  using (public.can_write_round(round_id));
