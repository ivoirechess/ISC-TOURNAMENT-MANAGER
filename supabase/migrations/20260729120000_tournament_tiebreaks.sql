-- Tie-breaks chosen for a tournament, applied in order after Points.
--
-- Points is never stored here: it is always the first criterion, and
-- alphabetical order is always the last net. Both are implicit, so this
-- column holds only what the organizer actually picked.
--
-- No RLS change is needed: the column belongs to public.tournaments, whose
-- existing policies (public read, writes restricted to the owning admin or
-- a super_admin) already cover it.

-- Rejects a selection listing the same tie-break twice. Written as an
-- IMMUTABLE function because a CHECK constraint cannot hold a subquery,
-- and this rule must live server-side rather than in the browser.
create or replace function public.array_has_no_duplicates(values text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select cardinality(values) = (select count(distinct value) from unnest(values) as value);
$$;

alter table public.tournaments
  add column tiebreaks text[] not null
    default array['buchholz', 'sonnebornBerger']::text[];

alter table public.tournaments
  add constraint tournaments_tiebreaks_valid check (
    cardinality(tiebreaks) between 2 and 6
    and tiebreaks <@ array[
      'buchholz',
      'buchholzCut1',
      'sonnebornBerger',
      'cumulative',
      'wins',
      'directEncounter'
    ]::text[]
    and public.array_has_no_duplicates(tiebreaks)
  );
