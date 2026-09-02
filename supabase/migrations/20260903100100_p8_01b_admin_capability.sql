-- ---------------------------------------------------------------------------
-- P8-01b — `owner` takes over what `admin` meant, and Admin becomes a TICK
-- scoped to one department.
--
-- ⚠️ DEPENDS ON 20260903100000_p8_01a_owner_role.sql HAVING BEEN APPLIED FIRST,
-- IN ITS OWN TRANSACTION. Every statement below reads or writes the enum value
-- 'owner'; run them in the same batch as the `alter type` and Postgres refuses
-- the lot with:
--
--     unsafe use of new value "owner" of enum type vizserve_pms_user_role
--     (55P04)
--
-- ---------------------------------------------------------------------------
-- THE MODEL, and why it is shaped this way.
--
-- Asked for on 3 Sep 2026. Amier wants a person who is a MEMBER OF A DEPARTMENT
-- BY RANK — still reporting to their Team Leader — who ALSO holds
-- administrative capability, scoped to that one department. Today the only way
-- to give somebody any admin power at all is `role = 'admin'`, which means
-- "oversees everything, every department".
--
--     member -> team_leader -> manager -> owner     rank    (the ladder)
--     Admin                                          tick    (own department)
--     HR                                             tick    (company-wide)
--
-- ⚠️ ADMIN IS A BOOLEAN, NOT A RUNG, AND THAT IS THE WHOLE DESIGN — the
-- identical argument D33 made for HR, for the identical reason. The role enum
-- is a TOTAL ORDER: `vizserve_pms_has_role` compares it with `>=` and the TS
-- side compares it with indexOf, so every value must sit SOMEWHERE on
-- member->owner. "Department admin" sits nowhere on it — a member can hold it,
-- and a manager who does not hold it must keep every power they have today.
-- Forcing it into the enum would silently grant or revoke everything above or
-- below the slot it was wedged into.
--
-- ⚠️ THE SCOPING IS FREE, AND FIGHTING IT IS THE MISTAKE. A member holding the
-- Admin tick is still a `member` by rank, and P7-17's RLS already scopes a
-- member to their own department. Nothing here narrows an existing policy,
-- nothing here touches `departmentScopeFilter`, and there is no department
-- switcher. The tick says "administrative capability"; the rank says "over
-- what".
--
-- ⚠️ THIS MIGRATION GRANTS NOBODY ANY NEW POWER. It is a RENAME plus a column.
-- Every existing admin becomes an owner with exactly what they had; every
-- existing check is re-pointed so it still means the same set of people; and
-- `is_dept_admin` defaults to false on every row, so the new predicate returns
-- true for nobody but owners until somebody ticks a box. The POWERS the tick
-- will confer are a separate follow-up — P8-01a is the role model only.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7/P8 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Promote today's admins.
--
-- This is the rename. `admin` meant "oversees everything" and that meaning is
-- now spelled `owner`, so everyone who holds the old spelling gets the new one.
-- Nobody gains or loses anything: `owner` sits directly above `admin`, so any
-- check still reading `>= 'admin'` (and several deliberately still do — see the
-- note on vizserve_pms_manages_department at the bottom) continues to pass for
-- exactly the same people.
-- ---------------------------------------------------------------------------
update vizserve_pms_users
   set role = 'owner'
 where role = 'admin';


-- ---------------------------------------------------------------------------
-- 2. `admin` STAYS IN THE ENUM, as a dead rung between manager and owner.
--
-- Not an oversight, and not tidiness deferred. Dropping an enum value means
-- rebuilding the type — every column, default, index and dependent function
-- that references it — on a LIVE database carrying real staff rows. Leaving it
-- costs exactly nothing: no row holds it after the UPDATE above, no picker
-- offers it (ROLE_LABELS drops it), and keeping it means legacy rows,
-- historical audit-log payloads and anything restored from an old backup stay
-- COMPARABLE with `>=` rather than erroring on an unknown label.
--
-- `lib/auth/roles.ts` therefore keeps "admin" in ROLE_ORDER too. That file's own
-- comment is the reason: the array must mirror this declaration order exactly,
-- or `indexOf` and the SQL `>=` disagree, "and that disagreement shows up as a
-- security bug".
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 3. Re-point vizserve_pms_is_admin() at the new top rung.
--
-- All 54 call sites across 19 migration files are CALLS, so every one of them
-- inherits this new meaning with no edit — which is the entire dividend of
-- P0-05 having insisted on one function instead of scattered `role = 'admin'`
-- tests.
--
-- Strictly speaking nothing would break if this were left alone: owner already
-- satisfies `>= 'admin'`. It is re-pointed anyway so that a STRAY LEGACY 'admin'
-- ROW — restored from a backup, inserted by hand, replayed from an old seed —
-- cannot quietly inherit owner powers. After this, holding the dead rung grants
-- nothing.
--
-- The NAME is left alone deliberately. Renaming it to `vizserve_pms_is_owner()`
-- would touch 19 files and 54 lines to change nothing, and would leave every
-- one of those policies momentarily referring to a function that does not exist.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select vizserve_pms_has_role('owner')
$$;

comment on function vizserve_pms_is_admin() is
  'P0-05, re-pointed by P8-01. True for an OWNER — the rung that took over what '
  '`admin` used to mean. The name is kept because 54 policies call it and a '
  'rename would change nothing but the blast radius. Not to be confused with '
  'vizserve_pms_is_dept_admin(uuid), which is the department-scoped tick.';


-- ---------------------------------------------------------------------------
-- 4. ⚠️ THE TRAP. vizserve_pms_is_hr() MUST MOVE TOO.
--
-- P7-52 wrote its own warning on this line and it is worth repeating in full:
-- that branch is "the one change this migration must not make". Without it,
-- granting HR to somebody REVOKES it from every admin.
--
-- Section 1 above just promoted every admin to 'owner'. Leave `u.role = 'admin'`
-- as it stands and there is now NOBODY on earth matching it, so EVERY CURRENT
-- ADMIN SILENTLY LOSES HR — no error, no permission denied, just zero rows on
-- /hr/balances and an insufficient_privilege from
-- vizserve_pms_leave_balance_summary on a screen that worked yesterday.
--
-- `>= 'owner'` rather than `= 'owner'`, so that if a rung is ever added above
-- owner this widens with it rather than stranding the new top role.
--
-- Body is otherwise byte-identical to p7_52:61-80.
-- ---------------------------------------------------------------------------
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
       -- OWNER IS HR. Was `u.role = 'admin'` until P8-01; the meaning is
       -- unchanged, only the spelling of the top rung is. Dropping this branch
       -- would revoke HR from every owner the instant somebody is granted it.
       and (u.is_hr or u.role >= 'owner')
  )
$$;

revoke all on function vizserve_pms_is_hr() from public, anon;
grant execute on function vizserve_pms_is_hr() to authenticated;

comment on function vizserve_pms_is_hr() is
  'P7-52, re-pointed by P8-01. True for a user carrying is_hr, and true for any '
  'OWNER. The owner branch is what keeps every policy widened to this function a '
  'strict widening rather than a transfer — it was `role = admin` before the '
  'owner rung took that meaning over. See D33.';


-- ---------------------------------------------------------------------------
-- 5. The column.
--
-- NAMED `is_dept_admin`, NOT `is_admin`, and the extra five characters are
-- load-bearing: `vizserve_pms_is_admin()` already exists and means the OPPOSITE
-- SCOPE — the whole company. A column one character from that function name is
-- a misreading waiting to happen in every policy anybody writes next.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_users
  add column if not exists is_dept_admin boolean not null default false;

comment on column vizserve_pms_users.is_dept_admin is
  'P8-01. Administrative capability SCOPED TO THIS PERSON''S OWN DEPARTMENT '
  '(primary_department_id). Orthogonal to role, deliberately: this is not a rank '
  'on the member->owner ladder, it is a job somebody of any rank may hold while '
  'still reporting to their Team Leader. Only an owner can set it, so it cannot '
  'appoint itself. Read it through vizserve_pms_is_dept_admin(uuid), never '
  'directly. Same shape as is_hr — see D33.';

-- NOT mirrored into auth metadata by vizserve_pms_users_sync_role, for exactly
-- the reason p7_52:46-50 declined to mirror is_hr. That trigger copies
-- role/app_access/is_active for DISPLAY, and D18 forbids the auth path reading
-- any of it — `user_metadata` is rewritable by the user through GoTrue with
-- their own token. Nothing routes on is_dept_admin; the AuthContext reads it
-- from this table. A second copy would only be a second thing to drift, and
-- `npm run check:metadata` would fail the build for reading it anyway.


-- ---------------------------------------------------------------------------
-- 6. The predicate.
--
-- Shape copied from vizserve_pms_is_hr() at p7_52:61-80 EXACTLY, owner branch
-- included, so that every future widening of a policy to this function is a
-- strict widening rather than a transfer — the same property that made P7-52
-- safe to apply to a live database.
--
-- Gated on is_active AND app_access exactly as vizserve_pms_current_role() is
-- (20260804120000_app_access_gate.sql:140-152), so a deactivated or
-- access-revoked department admin loses the capability in the same instant they
-- lose their role.
--
-- Note what the department branch reads: `primary_department_id`, the department
-- the person BELONGS TO — not the managed set, which is what they LEAD. A
-- department admin is a member of their department by rank; they administer the
-- team they are in, and they do not lead it. A null primary_department_id or a
-- null argument makes the `=` null, so the branch is false and only the owner
-- branch can answer — which is the correct reading of "administers no
-- department".
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_is_dept_admin(p_department_id uuid)
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
       and (
         -- OWNER ADMINISTERS EVERY DEPARTMENT. Same load-bearing branch as
         -- is_hr's: without it, ticking somebody as a department admin would
         -- read as taking the department away from the owner.
         u.role >= 'owner'
         or (u.is_dept_admin and u.primary_department_id = p_department_id)
       )
  )
$$;

revoke all on function vizserve_pms_is_dept_admin(uuid) from public, anon;
grant execute on function vizserve_pms_is_dept_admin(uuid) to authenticated;

comment on function vizserve_pms_is_dept_admin(uuid) is
  'P8-01. True for any owner, and true for an active, app-accessible user '
  'carrying is_dept_admin whose primary_department_id is the department asked '
  'about. Mirrored in TypeScript by canAdminDepartment() in '
  'lib/auth/authorization.ts, and the two must not drift. NO POLICY CONSULTS '
  'THIS YET — P8-01a is the role model only; the powers are a follow-up.';


-- ---------------------------------------------------------------------------
-- 7. ⚠️ vizserve_pms_manages_department (p0_05:75-89) IS DELIBERATELY UNTOUCHED.
--
-- Do not "fix" this later by adding an is_dept_admin branch to it. That function
-- grants APPROVAL AUTHORITY — it is what /approvals, the leave policies and the
-- task queues consult to decide who may decide — and a department admin REPORTS
-- TO THEIR TEAM LEADER. The Admin tick confers administrative capability, and
-- deliberately confers NO approval rights whatsoever. Wiring it in here would
-- hand every department admin the power to approve their own leave, which is
-- precisely the arrangement the three-gate workflow exists to prevent.
--
-- If a future phase genuinely needs a department admin to reach something, it
-- widens THAT policy to `or vizserve_pms_is_dept_admin(...)` one policy at a
-- time, visibly. It does not widen the approval predicate once and hope.
--
-- Likewise untouched: every existing RLS policy, and `departmentScopeFilter` on
-- the TypeScript side. A member holding the tick is still a member by rank, and
-- P7-17's RLS already scopes a member to their own department. That IS the
-- scoping; there is nothing to narrow.
-- ---------------------------------------------------------------------------
