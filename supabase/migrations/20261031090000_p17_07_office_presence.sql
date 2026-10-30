-- P17-07 — who is in, for the virtual office on /dtr (31 Oct 2026).
--
-- The office used to read the DTR through its ordinary policies, which show a
-- member nobody's punches but their own and a team leader only the departments
-- they lead. The rule wanted is different:
--
--   * Team leader and above (by the LADDER, `has_role('team_leader')`) see
--     everybody — TL, manager, admin, business manager, CEO.
--   * Anybody else sees the whole floor, but only their own department's room
--     is open: every other department's room is drawn closed, its walls up and
--     a roof on. So they get a row for everyone, and for anyone outside their
--     department the row says only WHICH DEPARTMENT — the name, the times and
--     leave come back null / false, and `visible` false. That is what sizes a
--     closed room (its desk count) and nothing more.
--
-- ⚠️ IT RETURNS PRESENCE, NOT THE DTR. Time in, time out, an open shift from
-- yesterday, and whether today is approved leave — no corrections, no
-- requests, no deviations, no leave TYPE. The DTR page itself is untouched and
-- still scoped by its own policies.
--
-- SECURITY DEFINER, because it reads past those policies by design; the scope
-- is `visible` below, and `current_role()` being null (deactivated, or no
-- access to this app) returns nothing at all. "Today" is Manila's, the same
-- day `todayInAppZone()` gives the app.
--
-- ⚠️ APPLY BY HAND in the SQL editor, like the other P17 files. Until it is
-- there the office falls back to the old reads: leads see what their policies
-- allow, and a member sees only themselves.

-- The return type changed while this was unapplied; dropping first lets a
-- re-paste of this file replace an earlier paste.
drop function if exists vizserve_pms_office_presence();

create function vizserve_pms_office_presence()
returns table (
  user_id         uuid,
  full_name       text,
  department_id   uuid,
  department_name text,
  time_in         timestamptz,
  time_out        timestamptz,
  open_since      timestamptz,
  on_leave        boolean,
  visible         boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (
    select u.id,
           u.primary_department_id,
           vizserve_pms_has_role('team_leader') as sees_all
      from vizserve_pms_users u
     where u.id = auth.uid()
       and vizserve_pms_current_role() is not null
  ),
  today as (
    select (now() at time zone 'Asia/Manila')::date as day
  )
  select p.id,
         case when v.visible then p.full_name end,
         dept.id,
         dept.name,
         case when v.visible then t.time_in end,
         case when v.visible then t.time_out end,
         case when v.visible then y.time_in end,
         v.visible and exists (
           select 1
             from vizserve_pms_internal_requests r
            where r.requester_id = p.id
              and r.request_type = 'LEAVE'
              and r.status = 'APPROVED'
              and r.start_date <= today.day
              and r.end_date >= today.day
         ),
         v.visible
    from me
    cross join today
    join vizserve_pms_users p
      on p.is_active
     and 'vizserve-pms' = any(p.app_access)
    -- ⚠️ COALESCE, AND IT IS NOT DECORATION. Somebody with no department makes
    -- the department comparison NULL, and `false or NULL` is NULL — so for a
    -- member (for whom `sees_all` is false) `visible` came back NULL, not
    -- false, and the app refused the whole answer. A lead never saw it:
    -- `true or NULL` is true.
    cross join lateral (
      select coalesce(
        me.sees_all
        or p.id = me.id
        or (me.primary_department_id is not null and p.primary_department_id = me.primary_department_id),
        false
      ) as visible
    ) v
    left join vizserve_pms_departments dept
      on dept.id = p.primary_department_id
     and dept.is_active
     and not dept.is_shared
    left join vizserve_pms_dtr_entries t
      on t.user_id = p.id
     and t.work_date = today.day
    -- A shift still open from yesterday: somebody who forgot to time out, or
    -- who works across midnight. Either way the office draws them in.
    left join vizserve_pms_dtr_entries y
      on y.user_id = p.id
     and y.work_date = today.day - 1
     and y.time_in is not null
     and y.time_out is null
$$;

comment on function vizserve_pms_office_presence() is
  'P17-07. Presence for the virtual office. Everyone for team leader and above; '
  'for anybody else, their own department in full and everyone else as a '
  'department only (name, times and leave withheld). Never the DTR detail.';

revoke all on function vizserve_pms_office_presence() from public, anon;
grant execute on function vizserve_pms_office_presence() to authenticated;
