-- Official round validation workflow. Future round-robin rounds remain in
-- storage but are hidden from public SELECT and Realtime until released.

alter table public.rounds
  add column released_at timestamptz,
  add column validated_at timestamptz,
  add column validated_by uuid references public.profiles(id);

create table public.round_reopen_log (
  id bigint generated always as identity primary key,
  round_id uuid not null,
  tournament_id uuid not null,
  round_number integer not null,
  reopened_by uuid not null references public.profiles(id),
  reason text not null check (length(btrim(reason)) > 0),
  rollback_following boolean not null,
  reopened_at timestamptz not null default now()
);
alter table public.round_reopen_log enable row level security;
create policy "super_admin reads round reopen log" on public.round_reopen_log
  for select to authenticated using (public.is_super_admin());

-- Preserve visibility of already-running installations during migration.
update public.rounds r set released_at = r.created_at
 where exists (select 1 from public.tournaments t where t.id = r.tournament_id
                and t.status in ('ongoing', 'archived'));

drop policy "rounds follow their tournament" on public.rounds;
create policy "released rounds follow their tournament" on public.rounds for select
using (
  (released_at is not null or public.can_write_tournament(tournament_id))
  and exists (select 1 from public.tournaments t where t.id = tournament_id)
);

drop policy "pairings follow their round" on public.pairings;
create policy "pairings follow released rounds" on public.pairings for select
using (exists (select 1 from public.rounds r where r.id = round_id));

create or replace function public.enforce_pairing_edit_rules()
returns trigger language plpgsql set search_path = '' as $$
declare expected public.pairings; parent_status public.tournament_status;
        released timestamptz; validated timestamptz;
begin
  expected := old; expected.result := new.result;
  if new is distinct from expected then
    raise exception 'Un appariement ne peut pas etre deplace : seul le resultat est modifiable.'
      using errcode = 'ISC01';
  end if;
  if new.result is distinct from old.result then
    select t.status, r.released_at, r.validated_at
      into parent_status, released, validated
      from public.rounds r join public.tournaments t on t.id = r.tournament_id
     where r.id = old.round_id;
    if parent_status is distinct from 'ongoing' then
      raise exception 'Un resultat ne peut etre saisi que sur un tournoi en cours.' using errcode='ISC01';
    end if;
    if released is null then
      raise exception 'Cette ronde n''est pas encore debloquee.' using errcode='ISC01';
    end if;
    if validated is not null then
      raise exception 'Cette ronde est validee : ses resultats sont verrouilles.' using errcode='ISC01';
    end if;
    if new.result is null and old.result = 'bye' then
      raise exception 'Un exempt ne peut pas etre efface.' using errcode='ISC01';
    end if;
  end if;
  return new;
end; $$;

create or replace function public.validate_round(r_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare r public.rounds; t public.tournaments; moment timestamptz := now();
begin
  select * into r from public.rounds where id = r_id for update;
  if r.id is null then raise exception 'Ronde introuvable.' using errcode='ISC01'; end if;
  t := public.assert_tournament_writable(r.tournament_id);
  if t.status <> 'ongoing' then raise exception 'Le tournoi doit etre en cours.' using errcode='ISC01'; end if;
  if r.released_at is null then raise exception 'Cette ronde n''est pas debloquee.' using errcode='ISC01'; end if;
  if r.validated_at is not null then raise exception 'Cette ronde est deja validee.' using errcode='ISC01'; end if;
  if exists (select 1 from public.rounds p where p.tournament_id=r.tournament_id
             and p.number < r.number and p.validated_at is null) then
    raise exception 'Les rondes doivent etre validees dans l''ordre.' using errcode='ISC01';
  end if;
  if not exists (select 1 from public.pairings p where p.round_id=r.id)
     or exists (select 1 from public.pairings p where p.round_id=r.id and p.result is null) then
    raise exception 'Tous les resultats doivent etre saisis avant validation.' using errcode='ISC01';
  end if;
  update public.rounds set validated_at=moment, validated_by=auth.uid() where id=r.id;
  if t.format in ('round_robin','double_round_robin') then
    update public.rounds set released_at=moment
     where tournament_id=t.id and number=r.number+1 and released_at is null;
  end if;
  update public.tournaments set last_activity_at=moment where id=t.id;
  return moment;
end; $$;

create or replace function public.create_swiss_round(t_id uuid, round_number integer, pairing_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.tournaments; new_id uuid; item jsonb; board_no integer := 0;
begin
  t := public.assert_tournament_writable(t_id);
  if t.status <> 'ongoing' or t.format <> 'swiss' then
    raise exception 'Une ronde suisse ne se genere que sur un tournoi suisse en cours.' using errcode='ISC01';
  end if;
  if round_number < 2 or round_number > t.rounds_planned
     or round_number <> coalesce((select max(number)+1 from public.rounds where tournament_id=t_id),1) then
    raise exception 'Numero de ronde suisse invalide.' using errcode='ISC01';
  end if;
  if not exists (select 1 from public.rounds where tournament_id=t_id
                 and number=round_number-1 and validated_at is not null) then
    raise exception 'Validez la ronde precedente avant de generer la suivante.' using errcode='ISC01';
  end if;
  if jsonb_typeof(pairing_rows) <> 'array' or jsonb_array_length(pairing_rows)=0 then
    raise exception 'Les appariements sont obligatoires.' using errcode='ISC01';
  end if;
  insert into public.rounds(tournament_id,number,released_at) values(t_id,round_number,now()) returning id into new_id;
  for item in select value from jsonb_array_elements(pairing_rows) loop
    board_no := board_no+1;
    insert into public.pairings(round_id,white_player_id,black_player_id,result,board)
    values(new_id,(item->>'white')::uuid,nullif(item->>'black','')::uuid,item->>'result',board_no);
  end loop;
  return jsonb_build_object('id',new_id,'number',round_number);
end; $$;

create or replace function public.reopen_round(r_id uuid, reason text, rollback_following boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.rounds; t public.tournaments;
begin
  if not public.is_super_admin() then raise exception 'Seul un super-admin peut rouvrir une ronde.' using errcode='ISC01'; end if;
  if nullif(btrim(coalesce(reason,'')),'') is null then raise exception 'La raison est obligatoire.' using errcode='ISC01'; end if;
  select * into r from public.rounds where id=r_id for update;
  if r.id is null or r.validated_at is null then raise exception 'Cette ronde n''est pas validee.' using errcode='ISC01'; end if;
  select * into t from public.tournaments where id=r.tournament_id for update;
  if t.format='swiss' and exists(select 1 from public.rounds where tournament_id=t.id and number>r.number) then
    if not rollback_following then raise exception 'Supprimez transactionnellement les rondes suivantes pour rouvrir.' using errcode='ISC01'; end if;
    delete from public.rounds where tournament_id=t.id and number>r.number;
  elsif rollback_following then
    delete from public.rounds where tournament_id=t.id and number>r.number;
  end if;
  insert into public.round_reopen_log(round_id,tournament_id,round_number,reopened_by,reason,rollback_following)
  values(r.id,r.tournament_id,r.number,auth.uid(),btrim(reason),rollback_following);
  update public.rounds set validated_at=null,validated_by=null where id=r.id;
end; $$;

create or replace function public.finish_tournament(t_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tournaments; moment timestamptz:=now();
begin
  t:=public.assert_tournament_writable(t_id);
  if t.cancelled_at is not null or t.status<>'ongoing' then raise exception 'Seul un tournoi en cours se cloture.' using errcode='ISC01'; end if;
  if not exists(select 1 from public.rounds where tournament_id=t_id and number=t.rounds_planned and validated_at is not null) then
    raise exception 'La derniere ronde doit etre validee avant la cloture.' using errcode='ISC01';
  end if;
  update public.tournaments set status='archived',finished_at=moment,last_activity_at=moment where id=t_id;
end; $$;

-- Starting releases exactly round 1, regardless of schedule strategy.
create or replace function public.release_first_round() returns trigger language plpgsql set search_path='' as $$
begin
  if new.status='ongoing' and old.status='draft' then
    update public.rounds set released_at=coalesce(released_at,now()) where tournament_id=new.id and number=1;
  end if; return new;
end; $$;
create trigger tournaments_release_first_round after update of status on public.tournaments
for each row execute function public.release_first_round();

create or replace function public.release_new_first_round() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.number=1 and exists(select 1 from public.tournaments t where t.id=new.tournament_id and t.status='ongoing') then
    new.released_at:=coalesce(new.released_at,now());
  end if; return new;
end; $$;
create trigger rounds_release_new_first before insert on public.rounds
for each row execute function public.release_new_first_round();

revoke execute on function public.validate_round(uuid), public.create_swiss_round(uuid,integer,jsonb),
  public.reopen_round(uuid,text,boolean) from public, anon;
grant execute on function public.validate_round(uuid), public.create_swiss_round(uuid,integer,jsonb),
  public.reopen_round(uuid,text,boolean) to authenticated;
