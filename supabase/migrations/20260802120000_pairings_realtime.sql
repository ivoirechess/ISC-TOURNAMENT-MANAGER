-- Publishes `pairings` so spectators see results appear without reloading.
--
-- Realtime only forwards rows from tables in the `supabase_realtime`
-- publication. It applies the same RLS policies as any other read, so this
-- exposes nothing new: a spectator is pushed exactly the rows they could
-- already fetch, and the pairings of a deleted tournament stay hidden.
--
-- Written to be replayable — adding a table already in the publication is
-- an error, so the state is checked first.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pairings'
  ) then
    alter publication supabase_realtime add table public.pairings;
  end if;
exception
  when undefined_object then
    -- No `supabase_realtime` publication: a plain PostgreSQL, or a project
    -- where Realtime has never been switched on. Nothing to publish to, and
    -- no reason to fail the migration — the site simply stays static until
    -- Realtime is enabled from the dashboard.
    raise notice 'Publication supabase_realtime absente : Realtime non active sur ce projet.';
end;
$$;
