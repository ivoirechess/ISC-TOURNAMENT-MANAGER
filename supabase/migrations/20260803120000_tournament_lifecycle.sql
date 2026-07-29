-- Tournament life cycle: public identity, dates, venue, and the five states
-- a tournament moves through.
--
-- Purely additive on the columns: nothing is dropped, every new column is
-- nullable or carries a default, so the existing front-end keeps working
-- unchanged. The policies, however, ARE rewritten — see the RLS section for
-- what changes and why.
--
--   Brouillon  status draft,    published_at null   private
--   À venir    status draft,    published_at set    public, entries open
--   En cours   status ongoing,  started_at set      structurally locked
--   Terminé    status archived, finished_at set     frozen
--   Annulé     cancelled_at set                     frozen, page kept if published

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.tournaments
  add column slug text,
  add column description text,
  add column starts_at timestamptz,
  add column ends_at timestamptz,
  add column timezone text not null default 'Africa/Abidjan',
  add column venue_name text,
  add column venue_address text,
  add column city text,
  add column organizer_name text,
  add column public_contact_email text,
  add column registration_url text,
  add column poster_url text,
  add column rating_type text,
  add column published_at timestamptz,
  add column started_at timestamptz,
  add column finished_at timestamptz,
  add column cancelled_at timestamptz,
  add column cancellation_reason text,
  add column updated_at timestamptz not null default now(),
  add column last_activity_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- Slug
-- ---------------------------------------------------------------------------
-- Normalisation lives in one IMMUTABLE function so the CHECK constraint, the
-- insert trigger and the backfill all agree on what a slug is. Accents are
-- folded by hand rather than with unaccent, which is an extension this
-- migration should not have to assume.

create or replace function public.slugify(value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select trim(both '-' from regexp_replace(
    lower(translate(
      value,
      'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿÇçÑñ',
      'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuYyyCcNn'
    )),
    '[^a-z0-9]+', '-', 'g'
  ));
$$;

-- Picks a slug that is free among the tournaments still alive, adding -2,
-- -3… on collision. Not IMMUTABLE: it reads the table on purpose.
create or replace function public.available_tournament_slug(base text, self uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  root text := nullif(public.slugify(coalesce(base, '')), '');
  candidate text;
  suffix integer := 1;
begin
  if root is null then
    root := 'tournoi';
  end if;
  candidate := root;
  while exists (
    select 1 from public.tournaments t
    where t.slug = candidate
      and t.deleted_at is null
      and (self is null or t.id <> self)
  ) loop
    suffix := suffix + 1;
    candidate := root || '-' || suffix;
  end loop;
  return candidate;
end;
$$;

-- The front-end never sends a slug today, so one is derived from the name.
-- A slug supplied by a caller is normalised rather than trusted.
create or replace function public.set_tournament_slug()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.slug is null or public.slugify(new.slug) = '' then
    new.slug := public.available_tournament_slug(new.name, new.id);
  else
    new.slug := public.slugify(new.slug);
  end if;
  return new;
end;
$$;

create or replace trigger tournaments_set_slug
  before insert on public.tournaments
  for each row
  execute function public.set_tournament_slug();

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Every existing tournament gets a stable slug derived from its name.
-- Nothing already private becomes public: a draft keeps published_at null.
-- Tournaments already playing or finished were public before this migration,
-- so dating their publication from their creation preserves what visitors
-- could already see.

do $$
declare
  row_id uuid;
begin
  for row_id in select id from public.tournaments where slug is null order by created_at loop
    update public.tournaments t
       set slug = public.available_tournament_slug(t.name, t.id)
     where t.id = row_id;
  end loop;
end;
$$;

update public.tournaments
   set published_at = created_at
 where published_at is null
   and status in ('ongoing', 'archived');

update public.tournaments
   set started_at = coalesce(started_at, created_at)
 where status in ('ongoing', 'archived');

update public.tournaments
   set finished_at = coalesce(finished_at, created_at)
 where status = 'archived';

alter table public.tournaments
  alter column slug set not null;

-- ---------------------------------------------------------------------------
-- Constraints and indexes
-- ---------------------------------------------------------------------------

alter table public.tournaments
  add constraint tournaments_slug_shape
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  add constraint tournaments_dates_ordered
    check (ends_at is null or starts_at is null or ends_at >= starts_at),
  add constraint tournaments_rating_type_known
    check (rating_type is null or rating_type in ('standard', 'rapid', 'blitz')),
  add constraint tournaments_contact_email_shape
    check (public_contact_email is null or public_contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  add constraint tournaments_registration_url_shape
    check (registration_url is null or registration_url ~* '^https://'),
  add constraint tournaments_poster_url_shape
    check (poster_url is null or poster_url ~* '^https://'),
  add constraint tournaments_cancellation_reason_needs_cancel
    check (cancellation_reason is null or cancelled_at is not null);

-- Unique among the living: a purged tournament must not hold its slug
-- hostage, and a deleted one keeps its own for a possible restore.
create unique index tournaments_slug_unique
  on public.tournaments (slug)
  where deleted_at is null;

create index tournaments_status_idx
  on public.tournaments (status)
  where deleted_at is null;

create index tournaments_published_idx
  on public.tournaments (published_at desc)
  where deleted_at is null and published_at is not null;

create index tournaments_starts_at_idx
  on public.tournaments (starts_at)
  where deleted_at is null;

create index tournaments_last_activity_idx
  on public.tournaments (last_activity_at desc)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger tournaments_touch_updated_at
  before update on public.tournaments
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Writing rules: an archived or cancelled tournament is frozen
-- ---------------------------------------------------------------------------
-- Replaces the body installed by 20260731120000, keeping its deleted_at
-- clause and adding the two frozen states. Every write on the children
-- (tournament_players, rounds, pairings) already funnels through here, so a
-- cancelled tournament stops accepting results by the same stroke.
--
-- The super_admin override is deliberate and unchanged: they remain the way
-- out when something has to be corrected after the fact.

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
              and t.status <> 'archived'
              and t.cancelled_at is null
          ));
$$;

-- ---------------------------------------------------------------------------
-- Reading rules: an unpublished draft is private
-- ---------------------------------------------------------------------------
-- Was: visible to everyone unless deleted. A draft that has never been
-- published is now the organizer's alone. A tournament that is playing,
-- finished, or was cancelled after publication stays public — cancelling
-- does not erase a page people may have linked to.

drop policy "tournaments are readable unless deleted" on public.tournaments;

create policy "tournaments are readable once public"
  on public.tournaments for select
  using (
    deleted_at is null
    and (
      published_at is not null
      or status in ('ongoing', 'archived')
      or public.can_write_tournament(id)
    )
    or public.is_super_admin()
  );

-- ---------------------------------------------------------------------------
-- Life-cycle transitions
-- ---------------------------------------------------------------------------
-- Each transition is a function rather than an UPDATE for the same reason as
-- soft deletion: several of them must check state and write in one atomic
-- step, and unpublishing has to make the row disappear from its own author's
-- view, which PostgreSQL forbids through an UPDATE under RLS.
--
-- All of them are SECURITY DEFINER with a pinned search_path, and every one
-- re-runs the ownership test the policies use rather than copying it.

create or replace function public.assert_tournament_writable(t_id uuid)
returns public.tournaments
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data public.tournaments;
begin
  -- FOR UPDATE serialises two tabs racing on the same tournament: the second
  -- waits, then re-reads the state the first one just wrote.
  select * into row_data from public.tournaments t where t.id = t_id for update;
  if row_data.id is null then
    raise exception 'Tournoi introuvable.' using errcode = 'ISC01';
  end if;
  if row_data.deleted_at is not null then
    raise exception 'Ce tournoi est supprime.' using errcode = 'ISC01';
  end if;
  if not (public.is_super_admin()
          or (public.is_admin() and row_data.created_by = auth.uid())) then
    raise exception 'Vous n''avez pas le droit de modifier ce tournoi.'
      using errcode = 'ISC01';
  end if;
  return row_data;
end;
$$;

create or replace function public.publish_tournament(t_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data public.tournaments;
  moment timestamptz := now();
begin
  row_data := public.assert_tournament_writable(t_id);
  if row_data.cancelled_at is not null then
    raise exception 'Un tournoi annule ne se publie pas.' using errcode = 'ISC01';
  end if;
  if row_data.status <> 'draft' then
    raise exception 'Seul un brouillon se publie (statut %).', row_data.status
      using errcode = 'ISC01';
  end if;
  if row_data.published_at is not null then
    raise exception 'Ce tournoi est deja publie.' using errcode = 'ISC01';
  end if;

  update public.tournaments
     set published_at = moment, last_activity_at = moment
   where id = t_id;
  return moment;
end;
$$;

create or replace function public.unpublish_tournament(t_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data public.tournaments;
begin
  row_data := public.assert_tournament_writable(t_id);
  if row_data.started_at is not null or row_data.status <> 'draft' then
    raise exception 'Un tournoi demarre ne se depublie pas.' using errcode = 'ISC01';
  end if;
  if row_data.published_at is null then
    raise exception 'Ce tournoi n''est pas publie.' using errcode = 'ISC01';
  end if;

  update public.tournaments
     set published_at = null, last_activity_at = now()
   where id = t_id;
end;
$$;

-- Starting is the one transition that must do several things or none:
-- flip the state, stamp it, and — in Swiss — draw round 1 with all of its
-- pairings. The row is locked first, so two tabs pressing "Démarrer" cannot
-- both get past the "already started" check.
--
-- Round 1 is drawn here rather than by src/swiss.js because it has to land
-- in the same transaction. It is also the only round that needs no engine:
-- with no games played there is no score, no colour history and no previous
-- opponent, so the draw is "sort the field, pair them two by two, the last
-- one sits out an odd field" — exactly what pairRound produces for round 1.
-- A check in supabase/tests/rls_checks.sql and one in tests/swiss.test.js
-- pin both sides to that same shape, so a divergence shows up.

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

  -- Round-robin formats already hold their whole schedule from creation.
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

create or replace function public.finish_tournament(t_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data public.tournaments;
  moment timestamptz := now();
begin
  row_data := public.assert_tournament_writable(t_id);
  if row_data.cancelled_at is not null then
    raise exception 'Un tournoi annule ne se cloture pas.' using errcode = 'ISC01';
  end if;
  if row_data.status <> 'ongoing' then
    raise exception 'Seul un tournoi en cours se cloture (statut %).', row_data.status
      using errcode = 'ISC01';
  end if;

  update public.tournaments
     set status = 'archived', finished_at = moment, last_activity_at = moment
   where id = t_id;
end;
$$;

create or replace function public.cancel_tournament(t_id uuid, reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data public.tournaments;
  moment timestamptz := now();
begin
  row_data := public.assert_tournament_writable(t_id);
  if row_data.cancelled_at is not null then
    raise exception 'Ce tournoi est deja annule.' using errcode = 'ISC01';
  end if;
  if row_data.status = 'archived' then
    raise exception 'Un tournoi termine ne s''annule pas.' using errcode = 'ISC01';
  end if;

  update public.tournaments
     set cancelled_at = moment,
         cancellation_reason = nullif(btrim(coalesce(reason, '')), ''),
         last_activity_at = moment
   where id = t_id;
end;
$$;

-- Anonymous visitors have no business calling any of these; the ownership
-- test would refuse them, and Supabase grants EXECUTE to anon by default, so
-- each one is revoked by name.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.publish_tournament(uuid)',
    'public.unpublish_tournament(uuid)',
    'public.start_tournament(uuid)',
    'public.finish_tournament(uuid)',
    'public.cancel_tournament(uuid, text)',
    'public.assert_tournament_writable(uuid)',
    'public.available_tournament_slug(text, uuid)'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    begin
      execute format('revoke execute on function %s from anon', fn);
    exception when undefined_object then
      null; -- no anon role: a plain PostgreSQL, nothing to revoke
    end;
    begin
      execute format('grant execute on function %s to authenticated', fn);
    exception when undefined_object then
      null;
    end;
  end loop;
end;
$$;

-- assert_tournament_writable is an internal helper, not an endpoint: it locks
-- a row and returns it whole. Only the transitions above should reach it.
do $$
begin
  execute 'revoke execute on function public.assert_tournament_writable(uuid) from authenticated';
exception when undefined_object then
  null;
end;
$$;
