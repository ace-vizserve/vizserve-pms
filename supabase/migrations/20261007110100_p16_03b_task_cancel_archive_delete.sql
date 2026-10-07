-- P16-03b — a client task can be cancelled, archived or deleted, each with a
-- reason; a form can be force-deleted with everything behind it (7 Oct 2026).
--
-- Run 20261007110000_p16_03a_task_cancelled_status.sql FIRST.
--
--   Cancel   status CANCELLED. Work stops, hours stay, and it leaves every
--            open-work count (capacity, sidebar, form workload) and the
--            performance figures. Its request is CANCELLED too. Reopenable.
--            Team Leader of the department or the Manager.
--   Archive  `archived_at`. Only a finished or cancelled task, so nothing open
--            is ever hidden. Lists and boards leave it out; the request page
--            still links to it. Restorable. Team Leader or Manager.
--   Delete   gone, with subtasks, hours, comments and files. The audit row
--            keeps what was removed and why. Its request is CANCELLED with the
--            reason. Manager or Admin only.
--
-- Client tasks only (`request_id` set). Internal work keeps P7-19's delete and
-- its free status picker, which now offers Cancelled too.
--
-- Also: vizserve_pms_cancel_request accepts APPROVED requests (it cancels the
-- task), the client's tracking page says "Cancelled", and the force path of
-- vizserve_pms_delete_form is the Manager's or Admin's and takes the form's
-- tasks with it.
--
-- The new columns sit outside the tasks UPDATE grant; only these functions
-- write them.
--
-- ⚠️ APPLY BY HAND in the SQL editor. Never `db:push`.

alter table vizserve_pms_tasks
  add column if not exists cancel_reason  text,
  add column if not exists archived_at    timestamptz,
  add column if not exists archived_by    uuid references vizserve_pms_users (id) on delete set null,
  add column if not exists archive_reason text;

comment on column vizserve_pms_tasks.archived_at is
  'P16-03. Set by vizserve_pms_archive_task, only on a finished or cancelled client task. Lists and boards leave it out.';


-- ---------------------------------------------------------------------------
-- Cancel and reopen.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_cancel_task(p_task_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task   vizserve_pms_tasks;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;
  if v_task.request_id is null then
    raise exception 'Only client tasks are cancelled this way. Move an internal task to Cancelled.'
      using errcode = 'invalid_parameter_value';
  end if;
  if not vizserve_pms_can_approve(v_task.department_id) then
    raise exception 'Only this department''s Team Leader or the Manager can cancel it.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_task.status in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED') then
    raise exception 'That task is already %.', lower(replace(v_task.status::text, '_', ' '))
      using errcode = 'invalid_parameter_value';
  end if;
  if v_reason is null then
    raise exception 'Say why it is being cancelled.' using errcode = 'check_violation';
  end if;

  update vizserve_pms_tasks
     set status = 'CANCELLED', cancel_reason = v_reason
   where id = p_task_id;

  insert into vizserve_pms_task_status_history (task_id, from_status, to_status, actor_id, comment)
  values (p_task_id, v_task.status, 'CANCELLED', auth.uid(), v_reason);

  update vizserve_pms_requests
     set status = 'CANCELLED', decision_reason = v_reason, reviewed_by = auth.uid(), reviewed_at = now()
   where id = v_task.request_id;

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'cancelled', auth.uid(),
    jsonb_build_object('status', v_task.status),
    jsonb_build_object('status', 'CANCELLED', 'reason', v_reason)
  );
end;
$$;

revoke all on function vizserve_pms_cancel_task(uuid, text) from public, anon;
grant execute on function vizserve_pms_cancel_task(uuid, text) to authenticated;

create or replace function vizserve_pms_reopen_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task vizserve_pms_tasks;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null or v_task.request_id is null then
    raise exception 'That client task no longer exists.' using errcode = 'no_data_found';
  end if;
  if not vizserve_pms_can_approve(v_task.department_id) then
    raise exception 'Only this department''s Team Leader or the Manager can reopen it.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_task.status <> 'CANCELLED' then
    raise exception 'Only a cancelled task can be reopened.' using errcode = 'invalid_parameter_value';
  end if;
  if v_task.archived_at is not null then
    raise exception 'Restore it from the archive first.' using errcode = 'invalid_parameter_value';
  end if;

  update vizserve_pms_tasks set status = 'OPEN', cancel_reason = null where id = p_task_id;

  insert into vizserve_pms_task_status_history (task_id, from_status, to_status, actor_id, comment)
  values (p_task_id, 'CANCELLED', 'OPEN', auth.uid(), 'Reopened');

  update vizserve_pms_requests
     set status = 'APPROVED', decision_reason = null
   where id = v_task.request_id and status = 'CANCELLED';

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'reopened', auth.uid(),
    jsonb_build_object('status', 'CANCELLED'),
    jsonb_build_object('status', 'OPEN')
  );
end;
$$;

revoke all on function vizserve_pms_reopen_task(uuid) from public, anon;
grant execute on function vizserve_pms_reopen_task(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Archive and restore.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_archive_task(p_task_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task   vizserve_pms_tasks;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null or v_task.request_id is null then
    raise exception 'Only client tasks are archived.' using errcode = 'invalid_parameter_value';
  end if;
  if not vizserve_pms_can_approve(v_task.department_id) then
    raise exception 'Only this department''s Team Leader or the Manager can archive it.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_task.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED') then
    raise exception 'Only a finished or cancelled task can be archived. Cancel it first.'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_task.archived_at is not null then
    return;
  end if;
  if v_reason is null then
    raise exception 'Say why it is being archived.' using errcode = 'check_violation';
  end if;

  update vizserve_pms_tasks
     set archived_at = now(), archived_by = auth.uid(), archive_reason = v_reason
   where id = p_task_id;

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'archived', auth.uid(), null,
    jsonb_build_object('reason', v_reason)
  );
end;
$$;

revoke all on function vizserve_pms_archive_task(uuid, text) from public, anon;
grant execute on function vizserve_pms_archive_task(uuid, text) to authenticated;

create or replace function vizserve_pms_restore_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task vizserve_pms_tasks;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;
  if not vizserve_pms_can_approve(v_task.department_id) then
    raise exception 'Only this department''s Team Leader or the Manager can restore it.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_task.archived_at is null then
    return;
  end if;

  update vizserve_pms_tasks
     set archived_at = null, archived_by = null, archive_reason = null
   where id = p_task_id;

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'restored', auth.uid(),
    jsonb_build_object('archive_reason', v_task.archive_reason), null
  );
end;
$$;

revoke all on function vizserve_pms_restore_task(uuid) from public, anon;
grant execute on function vizserve_pms_restore_task(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Delete a client task: what goes with it, then the delete.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_client_task_delete_impact(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_task vizserve_pms_tasks;
  v_ids  uuid[];
begin
  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null or v_task.request_id is null then
    return jsonb_build_object('ok', false, 'reason', 'That client task no longer exists.');
  end if;
  if coalesce(vizserve_pms_current_role()::text, '') not in ('manager', 'admin') then
    return jsonb_build_object('ok', false, 'reason', 'Only the Manager or Admin can delete a client task.');
  end if;

  select array_agg(id) into v_ids
    from vizserve_pms_tasks where id = p_task_id or parent_task_id = p_task_id;

  return jsonb_build_object(
    'ok', true,
    'title', v_task.title,
    'subtasks', cardinality(v_ids) - 1,
    'tracked_minutes', (select coalesce(sum(minutes), 0) from vizserve_pms_timesheet_entries where task_id = any(v_ids)),
    'comments', (select count(*) from vizserve_pms_task_comments where task_id = any(v_ids)),
    'attachments', (select count(*) from vizserve_pms_task_attachments where task_id = any(v_ids))
  );
end;
$$;

revoke all on function vizserve_pms_client_task_delete_impact(uuid) from public, anon;
grant execute on function vizserve_pms_client_task_delete_impact(uuid) to authenticated;

create or replace function vizserve_pms_delete_client_task(p_task_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task   vizserve_pms_tasks;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_impact jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null or v_task.request_id is null then
    raise exception 'That client task no longer exists.' using errcode = 'no_data_found';
  end if;
  if coalesce(vizserve_pms_current_role()::text, '') not in ('manager', 'admin') then
    raise exception 'Only the Manager or Admin can delete a client task.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_reason is null then
    raise exception 'Say why it is being deleted.' using errcode = 'check_violation';
  end if;

  v_impact := vizserve_pms_client_task_delete_impact(p_task_id);

  -- Written before the row goes: afterwards there is nothing left to count.
  -- The client's answers stay off it, as P7-72 keeps them off a form delete.
  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'deleted', auth.uid(),
    to_jsonb(v_task) - 'field_values',
    v_impact || jsonb_build_object('reason', v_reason)
  );

  update vizserve_pms_requests
     set status = 'CANCELLED', decision_reason = 'Task deleted: ' || v_reason,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = v_task.request_id and status <> 'CANCELLED';

  delete from vizserve_pms_notifications where entity_id = p_task_id;
  delete from vizserve_pms_tasks where id = p_task_id;

  return jsonb_build_object('ok', true, 'impact', v_impact);
end;
$$;

revoke all on function vizserve_pms_delete_client_task(uuid, text) from public, anon;
grant execute on function vizserve_pms_delete_client_task(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Cancel request — now also APPROVED (cancels its task). Same function as
-- 20261007100000_p16_02_form_list_lock_and_cancel.sql otherwise.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_cancel_request(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request       vizserve_pms_requests;
  v_department_id uuid;
  v_reason        text := nullif(btrim(coalesce(p_reason, '')), '');
  v_task_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select r.* into v_request
    from vizserve_pms_requests r
   where r.id = p_request_id
   for update;

  if v_request.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  select f.department_id into v_department_id
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  if not vizserve_pms_can_approve(v_department_id) then
    raise exception 'Only this department''s Team Leader or the Manager can cancel it.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_request.status not in ('PENDING_REVIEW', 'RETURNED', 'APPROVED') then
    raise exception 'That request has already been %.', lower(v_request.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  if v_reason is null then
    raise exception 'Say why it is being cancelled.' using errcode = 'check_violation';
  end if;

  -- P16-03. Approved work: its task is cancelled, which cancels this too.
  if v_request.status = 'APPROVED' then
    select t.id into v_task_id from vizserve_pms_tasks t where t.request_id = p_request_id;
    if v_task_id is not null then
      perform vizserve_pms_cancel_task(v_task_id, v_reason);
      return jsonb_build_object(
        'ok', true, 'status', 'CANCELLED',
        'reference_no', v_request.reference_no,
        'requester_email', v_request.requester_email,
        'requester_name', v_request.requester_name,
        'title', v_request.title
      );
    end if;
  end if;

  update vizserve_pms_requests
     set status          = 'CANCELLED',
         decision_reason = v_reason,
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_request_id;

  perform vizserve_pms_write_audit_log(
    'request', p_request_id, 'cancelled', auth.uid(),
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', 'CANCELLED', 'reason', v_reason)
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'CANCELLED',
    'reference_no', v_request.reference_no,
    'requester_email', v_request.requester_email,
    'requester_name', v_request.requester_name,
    'title', v_request.title
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Open-work counts leave cancelled tasks out. Each is the live definition
-- with only the status list changed: department_capacity (p2_00),
-- sidebar_snapshot (p14_09), form_workload (p7_72).
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_department_capacity(
  p_department_id uuid,
  p_target_date   date default null
)
returns table (
  user_id        uuid,
  full_name      text,
  role           vizserve_pms_user_role,
  open_count     integer,
  due_before     integer,
  overdue_count  integer,
  next_due_dates date[]
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    u.id,
    u.full_name,
    u.role,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
    )::integer,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
        and p_target_date is not null
        and t.due_date is not null
        and t.due_date <= p_target_date
    )::integer,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
        and t.due_date is not null
        -- Manila, not UTC. "Overdue" is a question about the local calendar day,
        -- and a UTC comparison marks work late several hours early.
        and t.due_date < (now() at time zone 'Asia/Manila')::date
    )::integer,
    coalesce(
      (
        select array_agg(d order by d)
          from (
            select t2.due_date as d
              from vizserve_pms_tasks t2
             where t2.assignee_id = u.id
               and t2.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
               and t2.due_date is not null
             order by t2.due_date
             limit 3
          ) nearest
      ),
      '{}'::date[]
    )
  from vizserve_pms_users u
  left join vizserve_pms_tasks t on t.assignee_id = u.id
  where u.is_active
    and u.primary_department_id = p_department_id
    -- Only callable by someone with scope over the department. Without this,
    -- SECURITY DEFINER would hand any signed-in user a headcount and workload
    -- report for every team in the company.
    and vizserve_pms_manages_department(p_department_id)
  group by u.id, u.full_name, u.role
  order by u.full_name
$$;

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
      and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
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
      and n.in_app
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

create or replace function vizserve_pms_form_workload(p_form_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_list_id   uuid;
  v_list_name text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  if not vizserve_pms_administers_form(p_form_id) then
    raise exception 'That form does not exist, or is outside your scope.'
      using errcode = 'insufficient_privilege';
  end if;

  select id, name into v_list_id, v_list_name from vizserve_pms_lists where form_id = p_form_id;

  return jsonb_build_object(
    'requests',
      (select count(*) from vizserve_pms_requests r where r.form_id = p_form_id),
    'pending_requests',
      (select count(*) from vizserve_pms_requests r
        where r.form_id = p_form_id
          and r.status in ('SUBMITTED', 'PENDING_REVIEW', 'RETURNED')),
    'responses',
      (select count(*) from vizserve_pms_form_responses fr where fr.form_id = p_form_id),
    'tasks_from_requests',
      (select count(*) from vizserve_pms_tasks t
         join vizserve_pms_requests r on r.id = t.request_id
        where r.form_id = p_form_id),
    'open_tasks',
      (select count(*) from vizserve_pms_tasks t
        where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
          and (
            t.request_id in (select r.id from vizserve_pms_requests r where r.form_id = p_form_id)
            or (v_list_id is not null and t.list_id = v_list_id)
          )),
    'list_name', v_list_name
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Force-delete a form, tasks and all. Same function as p7_72 otherwise.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_delete_form(p_form_id uuid, p_force boolean default false)
returns text[]
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_form        vizserve_pms_forms;
  v_workload    jsonb;
  v_submissions int;
  v_tasks       int;
  v_open        int;
  v_paths       text[];
  v_snapshot    jsonb;
begin
  v_workload := vizserve_pms_form_workload(p_form_id);  -- signed in, and in scope

  select * into v_form from vizserve_pms_forms where id = p_form_id for update;

  v_submissions := (v_workload ->> 'requests')::int + (v_workload ->> 'responses')::int;
  v_tasks := (v_workload ->> 'tasks_from_requests')::int;
  v_open := (v_workload ->> 'open_tasks')::int;

  -- P16-03. Without force, anything behind the form refuses, as before. With
  -- force, the Manager or Admin deletes all of it — requests, responses, and
  -- every task the requests became, with their hours — after typing DELETE.
  if not p_force and v_tasks > 0 then
    raise exception '% from this form became tasks. Archive the form instead, or force the delete.',
      v_tasks || case when v_tasks = 1 then ' request' else ' requests' end
      using errcode = 'restrict_violation';
  end if;

  if not p_force and v_open > 0 then
    raise exception 'Its list still has %. Close them, or force the delete.',
      v_open || case when v_open = 1 then ' open task' else ' open tasks' end
      using errcode = 'restrict_violation';
  end if;

  if v_submissions > 0 and not p_force then
    raise exception 'This form has %. Deleting it deletes them too — force the delete to go ahead.',
      v_submissions || case when v_submissions = 1 then ' submission' else ' submissions' end
      using errcode = 'restrict_violation';
  end if;

  if p_force and (v_submissions > 0 or v_tasks > 0)
     and coalesce(vizserve_pms_current_role()::text, '') not in ('manager', 'admin') then
    raise exception 'Only the Manager or Admin can force-delete a form.'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg(path), '{}') into v_paths
    from (
      select ra.storage_path as path
        from vizserve_pms_request_attachments ra
        join vizserve_pms_requests r on r.id = ra.request_id
       where r.form_id = p_form_id
      union
      select pa.storage_path
        from vizserve_pms_pending_attachments pa
       where pa.form_id = p_form_id
    ) paths;

  v_snapshot := jsonb_build_object(
    'form', to_jsonb(v_form),
    'forced', p_force and (v_submissions > 0 or v_tasks > 0),
    'tasks', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', t.id, 'title', t.title, 'status', t.status,
               'tracked_minutes', (select coalesce(sum(e.minutes), 0) from vizserve_pms_timesheet_entries e
                                    join vizserve_pms_tasks s on s.id = e.task_id
                                   where s.id = t.id or s.parent_task_id = t.id)
             )), '[]')
        from vizserve_pms_tasks t
        join vizserve_pms_requests r on r.id = t.request_id
       where r.form_id = p_form_id
    ),
    'fields', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', ff.id, 'field_key', ff.field_key, 'label', ff.label,
               'field_type', ff.field_type, 'is_active', ff.is_active
             ) order by ff.sort_order), '[]')
        from vizserve_pms_form_fields ff where ff.form_id = p_form_id
    ),
    'requests', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id, 'reference_no', r.reference_no, 'title', r.title,
               'status', r.status, 'submitted_at', r.submitted_at
             ) order by r.submitted_at), '[]')
        from vizserve_pms_requests r where r.form_id = p_form_id
    ),
    'responses', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', fr.id, 'submitted_at', fr.submitted_at
             ) order by fr.submitted_at), '[]')
        from vizserve_pms_form_responses fr where fr.form_id = p_form_id
    ),
    'files', to_jsonb(v_paths),
    'list', (
      select jsonb_build_object('id', l.id, 'name', l.name)
        from vizserve_pms_lists l where l.form_id = p_form_id
    )
  );

  -- Gate 1 decisions are polymorphic rows with no foreign key to the request.
  delete from vizserve_pms_approvals a
   using vizserve_pms_requests r
   where a.entity_type = 'request'
     and a.entity_id = r.id
     and r.form_id = p_form_id;

  -- P16-03. The tasks first (their subtasks, hours, comments and files cascade),
  -- and the inbox rows pointing at them.
  delete from vizserve_pms_notifications n
   using vizserve_pms_tasks t, vizserve_pms_requests r
   where n.entity_id = t.id and t.request_id = r.id and r.form_id = p_form_id;
  delete from vizserve_pms_tasks t
   using vizserve_pms_requests r
   where t.request_id = r.id and r.form_id = p_form_id;

  -- Requests and responses BEFORE the form: `form_field_protect` refuses to drop
  -- a field that still has answers, and the cascade would hit it.
  delete from vizserve_pms_requests where form_id = p_form_id;
  delete from vizserve_pms_form_responses where form_id = p_form_id;

  -- The list is archived and detached, never deleted.
  update vizserve_pms_lists set is_active = false, form_id = null where form_id = p_form_id;

  perform vizserve_pms_write_audit_log(
    p_entity_type => 'form',
    p_entity_id   => p_form_id,
    p_action      => case when p_force and (v_submissions > 0 or v_tasks > 0) then 'force_deleted' else 'deleted' end,
    p_actor_id    => auth.uid(),
    p_before      => v_snapshot,
    p_after       => null
  );

  delete from vizserve_pms_forms where id = p_form_id;

  return v_paths;
end;
$$;

-- ---------------------------------------------------------------------------
-- The client's tracking page says "Cancelled". Same function as p7_51
-- otherwise.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_get_request_status(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_request  vizserve_pms_requests;
  v_task     vizserve_pms_tasks;
  v_timeline jsonb := '[]'::jsonb;
  v_row      record;
begin
  -- An empty or absent token must not match a row whose hash is null.
  if coalesce(btrim(p_token), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select * into v_request
    from vizserve_pms_requests
   where status_token_hash = encode(digest(p_token, 'sha256'), 'hex');

  -- One shape of answer for every failure. See the header.
  if v_request.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- ------------------------------------------------------------------ stage 1
  -- Received. Always first, always true — the request exists.
  v_timeline := v_timeline || jsonb_build_object(
    'at', v_request.submitted_at,
    'label', 'Request received',
    'detail', 'We have your request and it is queued for review.'
  );

  -- ------------------------------------------------------------------ stage 2
  -- The Gate 1 decision, from the approval engine's own record rather than the
  -- request's current status: the status is where it IS, the approval row is
  -- when it MOVED, and a timeline needs the second.
  --
  -- The reason is included for a return or a rejection ONLY. Those two were
  -- already emailed to this client verbatim (P2-08/09), so it is not new
  -- information — and it is the one thing they need in order to act. An
  -- APPROVAL's reason is an internal note between colleagues.
  for v_row in
    select a.decision, a.reason, a.created_at
      from vizserve_pms_approvals a
     where a.entity_type = 'request'
       and a.entity_id = v_request.id
     order by a.created_at
  loop
    v_timeline := v_timeline || jsonb_build_object(
      'at', v_row.created_at,
      'label', case v_row.decision
                 when 'approved' then 'Approved — work scheduled'
                 when 'returned' then 'More information needed'
                 else 'Not proceeding'
               end,
      'detail', case v_row.decision
                  when 'approved' then 'A team member has been assigned and work is scheduled.'
                  else coalesce(v_row.reason, 'See the email we sent you for details.')
                end
    );
  end loop;

  -- ------------------------------------------------------------------ stage 3
  -- The work itself. One task per approved request (P2-07).
  select * into v_task
    from vizserve_pms_tasks
   where request_id = v_request.id
   order by created_at
   limit 1;

  if v_task.id is not null then
    for v_row in
      select h.to_status, h.created_at
        from vizserve_pms_task_status_history h
       where h.task_id = v_task.id
         -- CLIENT-VISIBLE STAGES ONLY. `WAITING_FOR_INFO` is deliberately
         -- absent: it usually means the team is waiting on somebody internal,
         -- and surfacing it reads to a client as "we are waiting on YOU" when
         -- nobody has asked them for anything.
         and h.to_status in (
           'ONGOING', 'FOR_QA', 'FOR_CLIENT_APPROVAL', 'COMPLETED', 'COMPLETED_NO_RESPONSE'
         )
       order by h.created_at
    loop
      v_timeline := v_timeline || jsonb_build_object(
        'at', v_row.created_at,
        'label', case v_row.to_status
                   when 'ONGOING' then 'Work in progress'
                   when 'FOR_QA' then 'In quality check'
                   when 'FOR_CLIENT_APPROVAL' then 'Sent to you for approval'
                   when 'COMPLETED' then 'Completed'
                   else 'Closed'
                 end,
        'detail', case v_row.to_status
                    when 'ONGOING' then 'Somebody is actively working on this.'
                    when 'FOR_QA' then 'The work is done and being checked before it reaches you.'
                    when 'FOR_CLIENT_APPROVAL' then 'Check your email — we have sent it over for your sign-off.'
                    when 'COMPLETED' then 'Signed off and closed. Thank you.'
                    -- COMPLETED_NO_RESPONSE is deliberately NOT called
                    -- "approved" anywhere in this app: the clock ran out, which
                    -- is a different fact, and the wording has to survive a
                    -- dispute about it.
                    else 'Closed automatically — the approval window passed without a reply.'
                  end
      );
    end loop;
  end if;

  -- P16-03. Cancelled — the reason was already emailed to this client.
  if v_request.status = 'CANCELLED' then
    v_timeline := v_timeline || jsonb_build_object(
      'at', coalesce(v_request.reviewed_at, v_request.updated_at),
      'label', 'Cancelled',
      'detail', coalesce(v_request.decision_reason, 'See the email we sent you for details.')
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'reference_no', v_request.reference_no,
    'title', v_request.title,
    'requester_name', v_request.requester_name,
    'submitted_at', v_request.submitted_at,
    'status', v_request.status,
    -- The AGREED date where there is one, otherwise what was asked for. The
    -- page labels which it is showing; conflating them would have the app
    -- confirming a date nobody committed to.
    'target_date', v_request.target_date,
    'approved_target_date', v_request.approved_target_date,
    'timeline', v_timeline
  );
end;
$$;
