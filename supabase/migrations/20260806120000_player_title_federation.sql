-- Public player metadata needed by tournament start lists.
alter table public.players
  add column title text,
  add column federation text;

alter table public.players
  add constraint players_title_shape check (
    title is null or title in ('GM', 'IM', 'FM', 'CM', 'WGM', 'WIM', 'WFM', 'WCM')
  ),
  add constraint players_federation_shape check (
    federation is null or federation ~ '^[A-Z]{3}$'
  );
