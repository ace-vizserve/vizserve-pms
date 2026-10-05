-- P15-10 — LEADING A DEPARTMENT IS PART OF BEING ITS TEAM LEADER (5 Oct 2026).
--
-- `vizserve_pms_user_managed_departments` and the Team Leader role were two
-- unconnected facts. From 7 to 30 Sep Joel (then owner, later Manager) had all
-- five departments ticked, and the pre-P14 Team Leader step asked only "is this
-- person listed as leading the department?" — so he signed the VizBytes Team
-- Leader step on three leave requests that Amier, VizBytes' actual lead, never
-- saw. The ticks came from scripts/seed-team.mjs giving every manager
-- `manages: ALL_DEPARTMENTS`.
--
-- P14-07 already reads both facts at decision time, and the Users screen clears
-- the ticks on save (P14-05). This puts the rule where it cannot be skipped:
--
--   1. A led department can only be recorded for somebody who HOLDS team_leader.
--   2. Losing the Team Leader role drops every department they led.
--
-- The admin save writes held roles BEFORE led departments (actions.ts), so
-- promoting somebody to Team Leader and ticking their department in one save
-- passes (1).
--
-- ⚠️ APPLY BY HAND in the SQL editor. Never `db:push`.


-- ===========================================================================
-- 0. ANYTHING ALREADY OUT OF STEP. Zero rows on prod as of 5 Oct; here so the
-- migration is correct wherever it runs.
-- ===========================================================================
delete from vizserve_pms_user_managed_departments md
 where not exists (
   select 1 from vizserve_pms_user_roles r
    where r.user_id = md.user_id and r.role = 'team_leader'
 );


-- ===========================================================================
-- 1. NO LED DEPARTMENT WITHOUT THE TEAM LEADER ROLE.
-- ===========================================================================
create or replace function vizserve_pms_led_department_needs_team_leader()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (
    select 1 from vizserve_pms_user_roles r
     where r.user_id = new.user_id and r.role = 'team_leader'
  ) then
    raise exception 'Only a Team Leader can lead a department. Give them the Team Leader role first.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_led_department_needs_team_leader
  on vizserve_pms_user_managed_departments;
create trigger vizserve_pms_led_department_needs_team_leader
  before insert or update on vizserve_pms_user_managed_departments
  for each row execute function vizserve_pms_led_department_needs_team_leader();


-- ===========================================================================
-- 2. LOSING TEAM LEADER DROPS WHAT THEY LED.
-- ===========================================================================
create or replace function vizserve_pms_team_leader_role_removed()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if old.role = 'team_leader' and (tg_op = 'DELETE' or new.role is distinct from 'team_leader') then
    delete from vizserve_pms_user_managed_departments where user_id = old.user_id;
  end if;
  return null;
end;
$$;

drop trigger if exists vizserve_pms_team_leader_role_removed on vizserve_pms_user_roles;
create trigger vizserve_pms_team_leader_role_removed
  after delete or update of role on vizserve_pms_user_roles
  for each row execute function vizserve_pms_team_leader_role_removed();

revoke all on function vizserve_pms_led_department_needs_team_leader() from public, anon, authenticated;
revoke all on function vizserve_pms_team_leader_role_removed() from public, anon, authenticated;
