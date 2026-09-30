-- P14-05 — MULTIPLE ROLES, A SWITCHER, AND WHO SEES WHAT (30 Sep 2026).
--
-- Decided by Ace:
--
--   * A person may HOLD several roles (Amier: Team Leader + Business Manager).
--     `vizserve_pms_users.role` stays the column every policy reads, and now
--     means the role they are ACTING AS. They switch between the roles they
--     hold; the last one used sticks. Supersedes D15's "one role, the highest"
--     — recorded as D22.
--   * Admin = IT: sees everything, plus the configuration screens. Approves
--     nothing (P14-04 already made approval an equality test).
--   * Business Manager and CEO: see everything (oversight). Approve nothing.
--   * HR screens: the HR tick, or Manager and above.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p14_04. Never `db:push`.
--
-- ⚠️ BEFORE DEPLOYING THE APP CODE: the admin screens (/admin/users, settings,
-- events, audit) become ADMIN-ONLY in the same release. Nobody holds `admin`
-- today, so section 6 gives it to the account named "Admin". Check that it
-- picked the right row (the query at the bottom) BEFORE the deploy, or nobody
-- will be able to reach user management.


-- ===========================================================================
-- 1. THE ROLES A PERSON HOLDS.
-- ===========================================================================
create table if not exists vizserve_pms_user_roles (
  user_id    uuid not null references vizserve_pms_users (id) on delete cascade,
  role       vizserve_pms_user_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

comment on table vizserve_pms_user_roles is
  'P14-05. Every role a person holds. vizserve_pms_users.role is the one they are '
  'ACTING AS and is always one of these (trigger below). Written only by the admin '
  'screen (service role) and the trigger; read by the person and by admins.';

alter table vizserve_pms_user_roles enable row level security;
revoke all on vizserve_pms_user_roles from anon;
grant select on vizserve_pms_user_roles to authenticated;
grant all on vizserve_pms_user_roles to service_role;

-- No insert/update/delete policy: nobody grants themselves a role.
drop policy if exists "user roles readable by self and admins" on vizserve_pms_user_roles;
create policy "user roles readable by self and admins"
  on vizserve_pms_user_roles for select to authenticated
  using (user_id = auth.uid() or (select vizserve_pms_is_admin()));

-- Everybody holds the role they have today.
insert into vizserve_pms_user_roles (user_id, role)
select u.id, u.role from vizserve_pms_users u
on conflict do nothing;


-- ===========================================================================
-- 2. THE ACTIVE ROLE IS ALWAYS A HELD ROLE.
--
-- Any write to vizserve_pms_users.role (the admin screen, the auth trigger that
-- creates profiles) records it as held, so the two can never disagree.
-- ===========================================================================
create or replace function vizserve_pms_users_role_is_held()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into vizserve_pms_user_roles (user_id, role)
  values (new.id, new.role)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_users_role_is_held on vizserve_pms_users;
create trigger vizserve_pms_users_role_is_held
  after insert or update of role on vizserve_pms_users
  for each row execute function vizserve_pms_users_role_is_held();


-- ===========================================================================
-- 3. SWITCHING. The only way a person changes their own active role, and only
-- to one they hold.
-- ===========================================================================
create or replace function vizserve_pms_switch_role(p_role vizserve_pms_user_role)
returns vizserve_pms_user_role
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user   uuid := auth.uid();
  v_before vizserve_pms_user_role;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from vizserve_pms_user_roles r
     where r.user_id = v_user and r.role = p_role
  ) then
    raise exception 'You do not hold that role.' using errcode = 'insufficient_privilege';
  end if;

  select u.role into v_before
    from vizserve_pms_users u
   where u.id = v_user and u.is_active
   for update;

  if v_before is null then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  if v_before = p_role then
    return p_role;
  end if;

  update vizserve_pms_users set role = p_role where id = v_user;

  perform vizserve_pms_write_audit_log(
    'user', v_user, 'role_switched', v_user,
    jsonb_build_object('role', v_before),
    jsonb_build_object('role', p_role)
  );

  return p_role;
end;
$$;

revoke all on function vizserve_pms_switch_role(vizserve_pms_user_role) from public, anon;
grant execute on function vizserve_pms_switch_role(vizserve_pms_user_role) to authenticated;


-- ===========================================================================
-- 4. WHO SEES EVERYTHING: Admin, Business Manager, CEO.
--
-- vizserve_pms_is_admin() is the "sees everything" gate ~54 policies call, and
-- it meant "owner" since P8-01. It now means `admin` and above on the ladder —
-- admin, business_manager, owner — which is exactly the three oversight roles.
-- The name is kept for the reason p8_01b gives: renaming it touches every
-- policy to change nothing.
--
-- ⚠️ It confers NO approval: vizserve_pms_can_approve and the approver pools
-- (p14_04) test the role by equality and do not consult this.
-- ===========================================================================
create or replace function vizserve_pms_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select vizserve_pms_has_role('admin')
$$;

comment on function vizserve_pms_is_admin() is
  'P0-05, re-pointed by P8-01 and P14-05. True for Admin (IT), Business Manager and '
  'CEO — the roles that see every department. Confers no approval rights. The '
  'configuration screens are gated to Admin alone in the app (requireAdmin).';


-- ===========================================================================
-- 5. HR SCREENS: the HR tick, or Manager and above.
-- ===========================================================================
create or replace function vizserve_pms_is_hr()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_users u
     where u.id = auth.uid()
       and u.is_active
       and 'vizserve-pms' = any(u.app_access)
       and (u.is_hr or u.role >= 'manager')
  )
$$;


-- ===========================================================================
-- 5b. CONFIGURATION IS WRITTEN BY ADMIN (IT) ALONE.
--
-- ⚠️ THE REASON THIS SECTION EXISTS: widening is_admin() in section 4 would, on
-- its own, have let a Business Manager UPDATE vizserve_pms_users directly —
-- including their own `role` — because "users writable by admin" is a FOR ALL
-- policy on is_admin(). Every configuration table's write policy moves to the
-- exact `admin` role; the READ those policies also granted stays with the
-- oversight roles through a separate select policy.
--
-- Forms are not configuration (they are department work) and keep their
-- existing policies.
-- ===========================================================================
create or replace function vizserve_pms_is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(vizserve_pms_current_role() = 'admin', false)
$$;

revoke all on function vizserve_pms_is_system_admin() from public, anon;
grant execute on function vizserve_pms_is_system_admin() to authenticated;

do $$
declare
  v_row record;
begin
  for v_row in
    select * from (values
      ('vizserve_pms_users',                   'users writable by admin'),
      ('vizserve_pms_user_managed_departments','managed departments writable by admin'),
      ('vizserve_pms_departments',             'departments writable by admin'),
      ('vizserve_pms_events',                  'events writable by admin'),
      ('vizserve_pms_attachment_rules',        'attachment rules writable by admin'),
      ('vizserve_pms_notification_type_settings','notification settings writable by admin'),
      ('vizserve_pms_public_submission_limits','submission limits writable by admin')
    ) as t(tbl, pol)
  loop
    execute format('drop policy if exists %I on %I', v_row.pol, v_row.tbl);
    execute format('drop policy if exists %I on %I', v_row.pol || ' (read)', v_row.tbl);
    execute format('drop policy if exists %I on %I', v_row.pol || ' (insert)', v_row.tbl);
    execute format('drop policy if exists %I on %I', v_row.pol || ' (update)', v_row.tbl);
    execute format('drop policy if exists %I on %I', v_row.pol || ' (delete)', v_row.tbl);

    execute format(
      'create policy %I on %I for select to authenticated using ((select vizserve_pms_is_admin()))',
      v_row.pol || ' (read)', v_row.tbl);
    execute format(
      'create policy %I on %I for insert to authenticated with check ((select vizserve_pms_is_system_admin()))',
      v_row.pol || ' (insert)', v_row.tbl);
    execute format(
      'create policy %I on %I for update to authenticated using ((select vizserve_pms_is_system_admin())) with check ((select vizserve_pms_is_system_admin()))',
      v_row.pol || ' (update)', v_row.tbl);
    execute format(
      'create policy %I on %I for delete to authenticated using ((select vizserve_pms_is_system_admin()))',
      v_row.pol || ' (delete)', v_row.tbl);
  end loop;
end;
$$;

drop policy if exists "app settings insertable by admin" on vizserve_pms_app_settings;
drop policy if exists "app settings updatable by admin" on vizserve_pms_app_settings;

create policy "app settings insertable by admin"
  on vizserve_pms_app_settings for insert to authenticated
  with check ((select vizserve_pms_is_system_admin()));

create policy "app settings updatable by admin"
  on vizserve_pms_app_settings for update to authenticated
  using ((select vizserve_pms_is_system_admin()))
  with check ((select vizserve_pms_is_system_admin()));


-- ===========================================================================
-- 6. SOMEBODY MUST HOLD ADMIN BEFORE THE ADMIN SCREENS BECOME ADMIN-ONLY.
--
-- The account named "Admin" (currently an owner) becomes an admin, as its
-- active role, and keeps owner as a second held role. If no such account
-- exists this does nothing, and the check below says so.
-- ===========================================================================
update vizserve_pms_users
   set role = 'admin'
 where full_name = 'Admin'
   and is_active;

-- Run this and read it before deploying the app code:
--
--   select u.full_name, u.email, u.role as acting_as,
--          array_agg(r.role order by r.role) as holds
--     from vizserve_pms_users u
--     join vizserve_pms_user_roles r on r.user_id = u.id
--    where u.is_active
--    group by u.id
--   having count(*) > 1 or bool_or(r.role in ('admin','business_manager','owner','manager'))
--    order by u.full_name;
