-- Recovery and deletion audit. Additive schema; existing migrations stay immutable.

alter table public.tournaments
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deletion_reason text;

create table public.tournament_reopen_log (
  id bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments(id) on delete restrict,
  reopened_by uuid not null references auth.users(id),
  reason text not null check (btrim(reason) <> ''),
  previous_finished_at timestamptz,
  reopened_round_id uuid references public.rounds(id) on delete set null,
  rollback_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.tournament_deletion_log (
  id bigint generated always as identity primary key,
  tournament_id uuid not null,
  deleted_by uuid not null references auth.users(id),
  reason text,
  previous_status public.tournament_status not null,
  created_at timestamptz not null default now()
);

alter table public.tournament_reopen_log enable row level security;
alter table public.tournament_deletion_log enable row level security;
create policy "super admins read tournament reopen log" on public.tournament_reopen_log
  for select to authenticated using (public.is_super_admin());
create policy "super admins read tournament deletion log" on public.tournament_deletion_log
  for select to authenticated using (public.is_super_admin());
-- No INSERT/UPDATE/DELETE policies: only the SECURITY DEFINER RPCs append rows.

create or replace function public.reopen_tournament(
  p_tournament_id uuid,
  p_reason text,
  p_reopen_last_round boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
  last_round public.rounds;
  moment timestamptz := now();
begin
  if not public.is_super_admin() then
    raise exception 'Seul un super-admin peut rouvrir un tournoi.' using errcode='ISC01';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'La raison est obligatoire.' using errcode='ISC01';
  end if;

  select * into t from public.tournaments where id=p_tournament_id for update;
  if t.id is null then raise exception 'Tournoi introuvable.' using errcode='ISC01'; end if;
  if t.deleted_at is not null then raise exception 'Un tournoi supprime ne peut pas etre rouvert.' using errcode='ISC01'; end if;
  if t.cancelled_at is not null then raise exception 'Un tournoi annule ne peut pas etre rouvert.' using errcode='ISC01'; end if;
  if t.status <> 'archived' then
    raise exception 'Seul un tournoi termine peut etre rouvert.' using errcode='ISC01';
  end if;

  if p_reopen_last_round then
    select * into last_round from public.rounds
      where tournament_id=t.id order by number desc limit 1 for update;
    if last_round.id is null or last_round.validated_at is null then
      raise exception 'La derniere ronde validee est introuvable.' using errcode='ISC01';
    end if;
    update public.rounds set validated_at=null, validated_by=null where id=last_round.id;
  end if;

  update public.tournaments set status='ongoing', finished_at=null,
    last_activity_at=moment where id=t.id;
  insert into public.tournament_reopen_log
    (tournament_id,reopened_by,reason,previous_finished_at,reopened_round_id,rollback_details)
  values (t.id,auth.uid(),btrim(p_reason),t.finished_at,last_round.id,
    jsonb_build_object('reopened_last_round',p_reopen_last_round,
      'round_number',last_round.number,'invalidated_round_ids',
      case when last_round.id is null then '[]'::jsonb else jsonb_build_array(last_round.id) end));
  return jsonb_build_object('status','ongoing','reopened_round_id',last_round.id,
    'round_number',last_round.number,'reopened_at',moment);
end; $$;

-- State-aware soft deletion. Exact-name confirmation is checked server-side,
-- so bypassing the interface cannot widen the permission.
create or replace function public.soft_delete_tournament(
  t_id uuid, p_reason text default null, p_confirmation_name text default null
) returns timestamptz language plpgsql security definer set search_path = '' as $$
declare t public.tournaments; marked timestamptz := now(); super boolean := public.is_super_admin();
begin
  select * into t from public.tournaments where id=t_id for update;
  if t.id is null or t.deleted_at is not null then
    raise exception 'Ce tournoi est introuvable ou deja supprime.' using errcode='ISC01';
  end if;
  if not (super or (public.is_admin() and
      (t.created_by=auth.uid() or public.is_active_club_admin(t.club_id)))) then
    raise exception 'Vous n''avez pas le droit de supprimer ce tournoi.' using errcode='ISC01';
  end if;
  if super then
    if p_confirmation_name is distinct from t.name then
      raise exception 'Retapez exactement le nom du tournoi.' using errcode='ISC01'; end if;
    if t.status in ('ongoing','archived') and nullif(btrim(coalesce(p_reason,'')),'') is null then
      raise exception 'Une raison est obligatoire pour ce tournoi.' using errcode='ISC01'; end if;
  else
    if t.status='ongoing' and t.cancelled_at is null then
      raise exception 'Annulez le tournoi avant de le supprimer.' using errcode='ISC01'; end if;
    if t.status='archived' then raise exception 'Un tournoi termine ne peut pas etre supprime.' using errcode='ISC01'; end if;
    if t.published_at is not null and t.cancelled_at is null and p_confirmation_name is distinct from t.name then
      raise exception 'Confirmez la suppression en retapant le nom.' using errcode='ISC01'; end if;
  end if;
  update public.tournaments set deleted_at=marked,deleted_by=auth.uid(),
    deletion_reason=nullif(btrim(coalesce(p_reason,'')),'') where id=t.id;
  insert into public.tournament_deletion_log(tournament_id,deleted_by,reason,previous_status)
    values(t.id,auth.uid(),nullif(btrim(coalesce(p_reason,'')),''),t.status);
  return marked;
end; $$;

revoke all on public.tournament_reopen_log, public.tournament_deletion_log from public, anon;
revoke execute on function public.reopen_tournament(uuid,text,boolean),
  public.soft_delete_tournament(uuid,text,text) from public, anon;
grant execute on function public.reopen_tournament(uuid,text,boolean),
  public.soft_delete_tournament(uuid,text,text) to authenticated;
-- Retire the obsolete one-argument endpoint so callers cannot bypass the new rules.
revoke execute on function public.soft_delete_tournament(uuid) from authenticated, public, anon;

-- Keep exceptional round recovery consistent with tournament recovery.
-- `rollback_following` is the caller's explicit acknowledgement of impact.
create or replace function public.reopen_round(r_id uuid, reason text, rollback_following boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.rounds; t public.tournaments; affected integer := 0;
begin
  if not public.is_super_admin() then raise exception 'Seul un super-admin peut rouvrir une ronde.' using errcode='ISC01'; end if;
  if nullif(btrim(coalesce(reason,'')),'') is null then raise exception 'La raison est obligatoire.' using errcode='ISC01'; end if;
  select * into r from public.rounds where id=r_id for update;
  if r.id is null or r.validated_at is null then raise exception 'Cette ronde n''est pas validee.' using errcode='ISC01'; end if;
  select * into t from public.tournaments where id=r.tournament_id for update;
  if exists(select 1 from public.rounds where tournament_id=t.id and number>r.number and validated_at is not null)
     and not rollback_following then
    raise exception 'Confirmez explicitement l''invalidation des rondes suivantes.' using errcode='ISC01';
  end if;
  if t.format='swiss' and exists(select 1 from public.rounds where tournament_id=t.id and number>r.number) then
    if not rollback_following then raise exception 'Le rollback transactionnel des rondes suivantes est obligatoire en Suisse.' using errcode='ISC01'; end if;
    select count(*) into affected from public.rounds where tournament_id=t.id and number>r.number;
    delete from public.rounds where tournament_id=t.id and number>r.number;
  else
    update public.rounds set validated_at=null,validated_by=null
      where tournament_id=t.id and number>=r.number and validated_at is not null;
    get diagnostics affected = row_count;
  end if;
  update public.rounds set validated_at=null,validated_by=null where id=r.id;
  insert into public.round_reopen_log(round_id,tournament_id,round_number,reopened_by,reason,rollback_following)
  values(r.id,r.tournament_id,r.number,auth.uid(),
    btrim(reason)||format(' [conséquence: %s validation(s)/ronde(s) ultérieure(s)]',affected),rollback_following);
end; $$;
