-- P0-05 — Authorization primitives, database side.
--
-- These are the SQL half of the single authorization layer. The TypeScript half
-- is lib/auth/authorization.ts and it answers the same questions the same way.
-- Scattered `if (role === 'admin')` checks are the thing both exist to prevent
-- — and keeping all scoping in one place is also hedge #1 for the deferred
-- multi-tenancy decision (Q3).
--
-- Every function here is SECURITY DEFINER on purpose: policies ON
-- vizserve_pms_users need to READ vizserve_pms_users to resolve a role, which
-- would recurse infinitely under RLS. SECURITY DEFINER runs the body as the
-- owner, for whom RLS is not applied, breaking the cycle.
--
-- They read `vizserve_pms_users.role` — never `auth.jwt()`, never
-- `user_metadata`. That field is user-writable through GoTrue and a policy that
-- trusts it is a full privilege escalation with no audit trail (D18).

-- The caller's role, or null if they have no profile or are deactivated.
-- Deactivation is a real gate here, not just a UI flag: an inactive user
-- resolves to null and therefore fails every `>=` comparison below.
create or replace function vizserve_pms_current_role()
returns vizserve_pms_user_role
language sql
stable
security definer
set search_path = public, extensions
as $$
  select u.role
    from vizserve_pms_users u
   where u.id = auth.uid()
     and u.is_active
$$;

-- Inclusive comparison — `role >= required`, never `role = required` (D15).
create or replace function vizserve_pms_has_role(required vizserve_pms_user_role)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(vizserve_pms_current_role() >= required, false)
$$;

create or replace function vizserve_pms_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select vizserve_pms_has_role('admin')
$$;

-- The departments this user leads or oversees. Empty for a plain member, and
-- empty for an admin who leads nothing in particular — an admin's reach comes
-- from vizserve_pms_is_admin(), not from this set.
create or replace function vizserve_pms_managed_department_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select md.department_id
    from vizserve_pms_user_managed_departments md
    join vizserve_pms_users u on u.id = md.user_id
   where md.user_id = auth.uid()
     and u.is_active
$$;

-- "Does the caller have department scope over this department?"
-- Admins always do. Everyone else must both hold team_leader-or-above AND have
-- the department in their managed set — holding the role is not enough.
create or replace function vizserve_pms_manages_department(target_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    vizserve_pms_is_admin()
    or (
      vizserve_pms_has_role('team_leader')
      and target_department_id in (select vizserve_pms_managed_department_ids())
    )
$$;

grant execute on function vizserve_pms_current_role() to authenticated;
grant execute on function vizserve_pms_has_role(vizserve_pms_user_role) to authenticated;
grant execute on function vizserve_pms_is_admin() to authenticated;
grant execute on function vizserve_pms_managed_department_ids() to authenticated;
grant execute on function vizserve_pms_manages_department(uuid) to authenticated;
