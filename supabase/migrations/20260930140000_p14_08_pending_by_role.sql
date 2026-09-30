-- P14-08 — "YOU HAVE WORK WAITING UNDER YOUR OTHER ROLE" (30 Sep 2026).
--
-- Anybody who holds more than one role is notified about work for all of them,
-- but can act only as the role they are switched to. The top bar tells them
-- what is waiting under each other role they hold, with a button to switch.
-- Only the approving roles (Team Leader, Manager) ever have work waiting.
--
-- ⚠️ SECURITY DEFINER ON PURPOSE. While acting as Team Leader, a person's own
-- policies hide the Manager's queue, so the app cannot count it itself. This
-- returns COUNTS only — never rows — and only for roles the caller holds,
-- computed from the same pools that decide who a request waits on (p14_07).
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p14_07. Never `db:push`.

create or replace function vizserve_pms_pending_by_role()
returns table (role vizserve_pms_user_role, pending integer)
language sql
stable
security definer
set search_path = public, extensions
as $$
  -- Team Leader: the Team Leader step of internal requests, plus client Gate 1
  -- for the departments ticked for them.
  select 'team_leader'::vizserve_pms_user_role,
         (
           (select count(*)
              from vizserve_pms_internal_requests q
             where q.status = 'PENDING_REVIEW'
               and q.approval_stage = 2
               and auth.uid() in (select vizserve_pms_team_leaders_of(q.department_id, q.requester_id)))
           +
           (select count(*)
              from vizserve_pms_requests r
              join vizserve_pms_forms f on f.id = r.form_id
             where r.status = 'PENDING_REVIEW'
               and f.department_id in (
                 select md.department_id
                   from vizserve_pms_user_managed_departments md
                  where md.user_id = auth.uid()
               ))
         )::integer
   where exists (
     select 1 from vizserve_pms_user_roles h
      where h.user_id = auth.uid() and h.role = 'team_leader'
   )

  union all

  -- Manager: the final step of internal requests, plus submitted timesheets.
  select 'manager'::vizserve_pms_user_role,
         (
           (select count(*)
              from vizserve_pms_internal_requests q
             where q.status = 'PENDING_REVIEW'
               and q.approval_stage = 3
               and auth.uid() in (select vizserve_pms_managers(q.requester_id)))
           +
           (select count(*)
              from vizserve_pms_timesheet_weeks w
             where w.status = 'SUBMITTED'
               and w.user_id <> auth.uid())
         )::integer
   where exists (
     select 1 from vizserve_pms_user_roles h
      where h.user_id = auth.uid() and h.role = 'manager'
   )
$$;

revoke all on function vizserve_pms_pending_by_role() from public, anon;
grant execute on function vizserve_pms_pending_by_role() to authenticated;
