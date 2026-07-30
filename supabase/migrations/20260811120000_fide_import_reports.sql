create table public.fide_import_reports (
  id bigint generated always as identity primary key,
  period text not null,
  source text not null,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  rows_read integer not null check (rows_read >= 0),
  civ_players integer not null check (civ_players >= 0),
  players_created integer not null check (players_created >= 0),
  players_updated integer not null check (players_updated >= 0),
  players_unchanged integer not null check (players_unchanged >= 0),
  potential_duplicates integer not null check (potential_duplicates >= 0),
  errors jsonb not null default '[]',
  started_at timestamptz not null,
  finished_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.fide_import_reports enable row level security;
create policy "super admins read FIDE import reports" on public.fide_import_reports
  for select to authenticated using (public.is_super_admin());
comment on table public.fide_import_reports is 'Audit des imports mensuels de la liste combinée FIDE.';
