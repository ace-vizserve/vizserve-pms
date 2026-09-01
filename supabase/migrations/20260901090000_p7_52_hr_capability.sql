-- ---------------------------------------------------------------------------
-- P7-52 — HR as a capability, not a rank.
--
-- Asked for on 1 Sep 2026. Today ADMIN IS HR, and this schema says so out loud
-- two files back:
--
--     -- WRITE IS ADMIN ONLY, not lead. ... HR — which here means admin — owns
--     -- the number.
--     -- 20260824100000_p7_33_leave_balances.sql:260-262
--
-- That forces a real HR person to hold a full admin account: they can create
-- users, change roles, revoke app access and read the audit trail, none of
-- which is their job. This separates the two.
--
-- ⚠️ HR IS A BOOLEAN, NOT A ROLE, AND THAT IS THE WHOLE DESIGN. The role enum
-- is a TOTAL ORDER — `vizserve_pms_has_role` compares it with `>=` and the TS
-- side compares it with indexOf — so every value must sit somewhere on the
-- member→admin ladder. HR is sideways to that ladder: an HR person may be a
-- member, and an admin who is not HR must keep every power they have today.
-- There is no correct slot for it in an ordered enum, and forcing one in would
-- silently grant or revoke everything above or below it. Orthogonal booleans
-- already exist on this table (`is_active`, `app_access`), so this follows a
-- precedent rather than inventing a concept. See D33.
--
-- ⚠️ EVERY POLICY CHANGE BELOW IS A STRICT WIDENING. `vizserve_pms_is_hr()`
-- returns true for admins as well as for the flag, so no actor loses a power
-- here. Adding the column grants nobody anything: every existing row gets
-- `false`, and an admin ticks the box afterwards in the UI.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The column.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_users
  add column if not exists is_hr boolean not null default false;

comment on column vizserve_pms_users.is_hr is
  'P7-52. Orthogonal to role, deliberately: HR is not a rank on the '
  'member->admin ladder, it is a job somebody of any rank may hold. Only an '
  'admin can set it, so HR cannot appoint itself. See D33.';

-- NOT mirrored into auth metadata by vizserve_pms_users_sync_role. That trigger
-- copies role/app_access/is_active for DISPLAY, and D18 forbids the auth path
-- reading any of it. Nothing routes on is_hr — the nav reads it from the
-- AuthContext, which reads this table — so mirroring it would only create a
-- second copy to drift.


-- ---------------------------------------------------------------------------
-- The predicate.
--
-- Gated on is_active AND app_access exactly as vizserve_pms_current_role() is
-- (20260804120000_app_access_gate.sql:140-152), so a deactivated or
-- access-revoked HR person loses the capability in the same instant they lose
-- their role.
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
       -- ADMIN IS HR. Not a convenience: admin owns the number today
       -- (p7_33:262), and every check below is widened FROM is_admin() TO
       -- this. Without this branch, granting HR to somebody would REVOKE it
       -- from every admin — the one change this migration must not make.
       and (u.is_hr or u.role = 'admin')
  )
$$;

revoke all on function vizserve_pms_is_hr() from public, anon;
grant execute on function vizserve_pms_is_hr() to authenticated;

comment on function vizserve_pms_is_hr() is
  'P7-52. True for a user carrying is_hr, and true for any admin. The admin '
  'branch is what makes every policy widened to this function a strict '
  'widening rather than a transfer. See D33.';


-- ---------------------------------------------------------------------------
-- The index p7_33:220-222 named in advance.
--
-- That comment said the whole-year-across-everybody read "is an admin report
-- that does not exist yet; when it does, it wants (balance_year, user_id) and
-- can add it then." /hr/balances is that report. This is then.
-- ---------------------------------------------------------------------------
create index if not exists vizserve_pms_leave_balances_year_user_idx
  on vizserve_pms_leave_balances (balance_year, user_id);


-- ---------------------------------------------------------------------------
-- Widen the four policies and the one restated check.
--
-- Drop-and-create inside the single transaction this file runs as, so no
-- window exists in which a table sits unprotected.
-- ---------------------------------------------------------------------------

-- 1. Leave balances, read. HR reads everybody's; the person, their lead and
--    admins keep exactly what they had.
drop policy if exists "leave balances readable by the person, their lead and admins"
  on vizserve_pms_leave_balances;

create policy "leave balances readable by the person, their lead and HR"
  on vizserve_pms_leave_balances for select to authenticated
  using (
    user_id = auth.uid()
    or vizserve_pms_is_hr()
    or exists (
      select 1
        from vizserve_pms_users u
       where u.id = vizserve_pms_leave_balances.user_id
         and vizserve_pms_manages_department(u.primary_department_id)
    )
  );

-- 2. Leave balances, write. STILL NOT THE LEAD — the reason p7_33 gave holds
--    exactly as written: a team leader deciding leave and setting the allowance
--    it is measured against is the same person on both sides of the question.
--    What changes is only that "HR" stops being a synonym for "admin".
drop policy if exists "leave balances writable by admin"
  on vizserve_pms_leave_balances;

create policy "leave balances writable by HR"
  on vizserve_pms_leave_balances for all to authenticated
  using (vizserve_pms_is_hr())
  with check (vizserve_pms_is_hr());

-- 3. Leave types. Policy data HR changes (D25); the read policy is untouched.
drop policy if exists "leave types writable by admin"
  on vizserve_pms_leave_types;

create policy "leave types writable by HR"
  on vizserve_pms_leave_types for all to authenticated
  using (vizserve_pms_is_hr())
  with check (vizserve_pms_is_hr());

-- 4. Holidays. D31 made this table the only authority on which days the company
--    is shut, and D32 recorded that editing it rewrites reported leave. That is
--    an HR consequence, so it belongs to the HR capability. Read policy
--    untouched: nothing about which days the company is shut is private.
drop policy if exists "holidays writable by admin"
  on vizserve_pms_holidays;

create policy "holidays writable by HR"
  on vizserve_pms_holidays for all to authenticated
  using (vizserve_pms_is_hr())
  with check (vizserve_pms_is_hr());


-- ---------------------------------------------------------------------------
-- 5. vizserve_pms_leave_balance_summary — the one that is easy to miss.
--
-- ⚠️ THIS IS NOT COVERED BY THE POLICY CHANGE ABOVE. The function is SECURITY
-- DEFINER, so it bypasses the policy on vizserve_pms_leave_balances entirely
-- and RESTATES the three-way test in plpgsql. Widening the policy alone would
-- leave HR refused here with insufficient_privilege — on the one call
-- /approvals already makes on every page load.
--
-- Recreated whole rather than patched, because `create or replace` on the same
-- (uuid, integer) signature is an in-place swap that needs no drop and keeps
-- the existing grants. Body is identical to p7_33:295-385 except for the
-- single `not vizserve_pms_is_admin()` -> `not vizserve_pms_is_hr()` below.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_leave_balance_summary(
  p_user_id uuid default null,
  p_year    integer default null
)
returns table (
  leave_type_id  uuid,
  code           text,
  label          text,
  is_active      boolean,
  days_allocated numeric,
  days_used      numeric,
  days_remaining numeric
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_caller     uuid := auth.uid();
  v_subject    uuid := coalesce(p_user_id, auth.uid());
  -- Manila, not UTC. On 1 January the server is still in December for eight
  -- hours, and defaulting to the wrong year would show everyone last year's
  -- allocation against this year's first request.
  v_year       integer := coalesce(
                  p_year,
                  extract(year from (now() at time zone 'Asia/Manila'))::integer
                );
  v_department uuid;
  v_exists     boolean;
begin
  if v_caller is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select true, u.primary_department_id
    into v_exists, v_department
    from vizserve_pms_users u
   where u.id = v_subject;

  if not coalesce(v_exists, false) then
    raise exception 'That user does not exist.' using errcode = 'no_data_found';
  end if;

  -- Deliberately the same three-way test as the read policy above. Restated
  -- rather than delegated because a definer function bypasses the policy, so
  -- this IS the check — there is nothing underneath it.
  -- P7-52: is_admin() -> is_hr(), which still returns true for every admin.
  if v_subject <> v_caller
     and not vizserve_pms_is_hr()
     and not vizserve_pms_manages_department(v_department)
  then
    raise exception 'You cannot read that person''s leave balance.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    lt.id,
    lt.code,
    lt.label,
    lt.is_active,
    coalesce(b.days_allocated, 0)::numeric,
    coalesce(taken.used, 0)::numeric,
    (coalesce(b.days_allocated, 0) - coalesce(taken.used, 0))::numeric
  from vizserve_pms_leave_types lt
  left join vizserve_pms_leave_balances b
         on b.leave_type_id = lt.id
        and b.user_id       = v_subject
        and b.balance_year  = v_year
  left join lateral (
    select sum(
             vizserve_pms_leave_days(r.start_date, r.end_date, r.start_half, r.end_half)
           ) as used
      from vizserve_pms_internal_requests r
     where r.request_type  = 'LEAVE'
       -- APPROVED ONLY. A pending request is not yet a fact, and deducting it
       -- would tell somebody they have less leave than they do on the strength
       -- of a decision nobody has made.
       and r.status        = 'APPROVED'
       and r.requester_id  = v_subject
       and r.leave_type_id = lt.id
       and extract(year from r.start_date) = v_year
  ) taken on true
  -- A retired type with nothing behind it is noise; one with history is not.
  where lt.is_active
     or coalesce(b.days_allocated, 0) > 0
     or coalesce(taken.used, 0) > 0
  order by lt.sort_order, lt.label;
end;
$$;

comment on function vizserve_pms_leave_balance_summary(uuid, integer) is
  'P7-33, widened by P7-52. Allocated / used / remaining per leave type for one '
  'person in one year. SECURITY DEFINER with its own authority check, because '
  'run as invoker an unauthorised caller would read days_used = 0 rather than '
  'an error — a wrong number that looks right. The check is now is_hr() rather '
  'than is_admin(), which is a widening: is_hr() is true for every admin.';
