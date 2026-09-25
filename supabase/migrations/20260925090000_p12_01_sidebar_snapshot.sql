-- P12-01 (ported from `staging`) — THE RAIL IN ONE READ.
--
-- `app/(app)/sidebar-panel.tsx` issued nine PostgREST requests on every shell
-- render, two of which downloaded one row per open task and one row per
-- pending request purely to count them in a `Map`. Past 1,000 open tasks that
-- download was also silently truncated by PostgREST's row cap, so the per-list
-- counts under-reported. This does the counting where the rows are.
--
-- ⚠️ SECURITY INVOKER. Every existing policy still decides what comes back —
-- a DEFINER function here would hand every department to every member. No
-- scope filter is restated below; `owner_id` predicates select a KIND of list,
-- not a set of rows somebody may not see (P11-06).
--
-- ⚠️ DIFFERS FROM THE STAGING VERSION IN ONE PLACE: empty departments are NOT
-- dropped here. P13-01's collaboration space is kept while empty, and that
-- test reads `AuthContext.sharedDepartmentIds`, which is TypeScript. The
-- sidebar panel drops empty departments itself, as it did before.

create or replace function vizserve_pms_sidebar_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
with
  open_by_list as (
    select t.list_id, count(*)::int as n
    from vizserve_pms_tasks t
    where t.list_id is not null
      and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
    group by t.list_id
  ),
  -- P7-26. A pending request has no task; it is counted against the list it
  -- WILL land in, through its form.
  pending_by_list as (
    select f.default_list_id as list_id, count(*)::int as n
    from vizserve_pms_requests r
    join vizserve_pms_forms f on f.id = r.form_id
    where r.status = 'PENDING_REVIEW'
      and f.default_list_id is not null
    group by f.default_list_id
  ),
  dept_list as (
    select
      l.id,
      l.name,
      l.department_id,
      l.group_id,
      l.sort_order,
      coalesce(o.n, 0) as open_tasks,
      coalesce(p.n, 0) as pending_requests,
      jsonb_build_object(
        'id', l.id,
        'name', l.name,
        'openTasks', coalesce(o.n, 0),
        'pendingRequests', coalesce(p.n, 0)
      ) as node
    from vizserve_pms_lists l
    left join open_by_list o on o.list_id = l.id
    left join pending_by_list p on p.list_id = l.id
    -- P11-06: a personal list carries a department but is not part of its tree.
    where l.owner_id is null
      and l.is_active
  ),
  folder as (
    select
      g.id,
      g.department_id,
      g.is_system,
      g.sort_order,
      g.name,
      jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'isSystem', g.is_system,
        'lists', coalesce(held.items, '[]'::jsonb),
        'openTasks', coalesce(held.open_tasks, 0),
        'pendingRequests', coalesce(held.pending_requests, 0)
      ) as node
    from vizserve_pms_task_groups g
    left join lateral (
      select
        jsonb_agg(l.node order by l.sort_order, l.name) as items,
        sum(l.open_tasks)::int as open_tasks,
        sum(l.pending_requests)::int as pending_requests,
        count(*)::int as n
      from dept_list l
      where l.group_id = g.id
        and l.department_id = g.department_id
    ) held on true
    where g.is_active
      -- The reserved folder is dropped while empty, and only that one.
      and (not g.is_system or coalesce(held.n, 0) > 0)
  )
select jsonb_build_object(
  -- RLS ("notifications read own") scopes this to the caller.
  'unread', (
    select count(*)::int
    from vizserve_pms_notifications n
    where n.read_at is null
  ),
  -- P7-50. Scoped by the requests policy, exactly as the old head count was.
  'awaiting_review', (
    select count(*)::int
    from vizserve_pms_requests r
    where r.status = 'PENDING_REVIEW'
  ),
  'spaces', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'departmentId', d.id,
               'departmentName', d.name,
               -- Folderless lists, rendered ABOVE the folders.
               'lists', coalesce((
                 select jsonb_agg(l.node order by l.sort_order, l.name)
                 from dept_list l
                 where l.department_id = d.id
                   and l.group_id is null
               ), '[]'::jsonb),
               -- System folder last, tie-broken on the flag, not sort_order.
               'folders', coalesce((
                 select jsonb_agg(f.node order by f.is_system, f.sort_order, f.name)
                 from folder f
                 where f.department_id = d.id
               ), '[]'::jsonb)
             )
             order by d.name
           )
    from vizserve_pms_departments d
    where d.is_active
  ), '[]'::jsonb),
  -- P11-06. The caller's own lists, archived included: the Personal group is
  -- the only place a member can un-archive one.
  'personal', coalesce((
    select jsonb_agg(
             jsonb_build_object('id', l.id, 'name', l.name, 'isActive', l.is_active)
             order by l.sort_order, l.name
           )
    from vizserve_pms_lists l
    where l.owner_id = auth.uid()
  ), '[]'::jsonb)
);
$$;

revoke all on function vizserve_pms_sidebar_snapshot() from public, anon;
grant execute on function vizserve_pms_sidebar_snapshot() to authenticated;

comment on function vizserve_pms_sidebar_snapshot() is
  'P12-01. The whole sidebar in one jsonb: unread, awaiting_review, every active '
  'department''s tree (folderless lists first, system folder last, empty system '
  'folders dropped) and the caller''s own lists including archived ones. '
  'SECURITY INVOKER — every existing policy still decides what comes back.';
