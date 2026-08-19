-- ---------------------------------------------------------------------------
-- P7-19 — deleting an INTERNAL task.
--
-- There has never been a way to delete a task. `vizserve_pms_tasks` has policies
-- for select, insert and update and NONE for delete, so `authenticated` cannot
-- remove a row at all — only the service role can. A task created by mistake
-- stayed forever, which is why people keep a second list somewhere else.
--
-- ⚠️ INTERNAL WORK ONLY. A task with a `request_id` came through a form, and
-- deleting one would destroy a record the client is on the other end of:
-- `vizserve_pms_client_decisions`, `vizserve_pms_approval_tokens` and
-- `vizserve_pms_feedback` all cascade from the task, and all three exist only on
-- request-backed work. Restricting to `request_id is null` means those three
-- cascades can never fire, which is most of what made a delete button dangerous.
--
-- ⚠️ WHAT IT STILL DESTROYS, and the reason the UI has to say so out loud.
-- Nine tables cascade from a task. After the client-side three are excluded,
-- these still go:
--
--   vizserve_pms_timesheet_entries      HOURS SOMEBODY LOGGED. Payroll.
--   vizserve_pms_task_status_history    the audit trail of how it moved
--   vizserve_pms_task_comments          the conversation on it
--   vizserve_pms_task_attachments       (storage objects are cleaned separately)
--   vizserve_pms_task_assignees         who else was on it
--   tasks.parent_task_id CASCADE        EVERY SUBTASK BENEATH IT, silently
--
-- The last two lines are the ones that surprise people. Deleting a parent takes
-- its whole subtree with it, and the hours logged against those subtasks go with
-- them. `vizserve_pms_task_delete_impact` below exists so the confirm dialog can
-- name that damage before it happens rather than after.
--
-- The decision was taken deliberately: hard delete, with a confirmation that
-- states the consequence. Not a soft archive — an archive that fills with typos
-- is a second list nobody reads either.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, and paste this file as it stands
-- at that moment.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Who may delete.
--
-- Three ways in, and no fourth:
--
--   * a lead of the task's department  — they own the shape of their board
--   * whoever created it               — P7-14 lets a member create a task, so
--                                        a member must be able to undo that
--   * the owner of a personal task     — it is their own private list (P7-01)
--
-- NOT the assignee of somebody else's task, and not a colleague who can merely
-- SEE it. P7-17 widened SELECT to the whole department and deliberately left
-- UPDATE alone; delete is further than update, not nearer.
--
-- `stable` and SECURITY DEFINER: it is called from the two functions below and
-- from nothing else, and it reads rows the caller may not be able to read.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_can_delete_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_tasks t
     where t.id = p_task_id
       and t.request_id is null
       and (
         vizserve_pms_manages_department(t.department_id)
         or t.created_by = auth.uid()
         or (t.is_personal and t.assignee_id = auth.uid())
       )
  );
$$;

grant execute on function vizserve_pms_can_delete_task(uuid) to authenticated;

comment on function vizserve_pms_can_delete_task(uuid) is
  'P7-19. Whether the caller may delete this task. Internal work only — a request-backed task is never deletable.';

-- ---------------------------------------------------------------------------
-- What deleting it would destroy.
--
-- SECURITY DEFINER because it counts rows the caller cannot read: the timesheet
-- entries policy is owner-or-their-lead, so a member deleting their own task
-- could not otherwise be told that four hours are attached to it. Totals only —
-- it returns counts and minutes, never whose hours they were, which keeps it on
-- the right side of the same privacy line `vizserve_pms_task_time_tracked` draws.
--
-- Counts the WHOLE SUBTREE, because that is what the cascade takes. A parent
-- reporting only its own two hours while silently deleting twenty from beneath
-- it is precisely the surprise this function exists to prevent.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_task_delete_impact(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_task    record;
  v_ids     uuid[];
  v_subs    integer;
  v_minutes integer;
  v_comments integer;
  v_files   integer;
begin
  select id, title, request_id, department_id into v_task
    from vizserve_pms_tasks where id = p_task_id;

  if v_task is null then
    return jsonb_build_object('ok', false, 'reason', 'That task no longer exists.');
  end if;

  if v_task.request_id is not null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'This task came from a client request, so it cannot be deleted. Close it instead.'
    );
  end if;

  if not vizserve_pms_can_delete_task(p_task_id) then
    return jsonb_build_object(
      'ok', false,
      'reason', 'Only a team leader of this department, or whoever created the task, can delete it.'
    );
  end if;

  -- The task and everything beneath it. One level is all `parent_task_id`
  -- allows (P7-09 enforces it), so a recursive CTE would be answering a question
  -- the schema cannot ask.
  select array_agg(id) into v_ids
    from vizserve_pms_tasks
   where id = p_task_id or parent_task_id = p_task_id;

  select count(*) - 1 into v_subs from vizserve_pms_tasks
   where id = any(v_ids);

  select coalesce(sum(minutes), 0) into v_minutes
    from vizserve_pms_timesheet_entries where task_id = any(v_ids);

  select count(*) into v_comments
    from vizserve_pms_task_comments where task_id = any(v_ids);

  select count(*) into v_files
    from vizserve_pms_task_attachments where task_id = any(v_ids);

  return jsonb_build_object(
    'ok', true,
    'title', v_task.title,
    'subtasks', v_subs,
    'tracked_minutes', v_minutes,
    'comments', v_comments,
    'attachments', v_files
  );
end;
$$;

grant execute on function vizserve_pms_task_delete_impact(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The delete.
--
-- A FUNCTION RATHER THAN A DELETE POLICY, deliberately. A policy could express
-- "internal work, and you are a lead or the creator" — but it could not write
-- the audit row, and an untracked deletion is the one operation where the trail
-- matters most because the evidence is what just disappeared. Keeping the
-- capability in a function means there is exactly one route in, and it always
-- records.
--
-- No delete policy is added, so a direct `DELETE` through PostgREST still
-- affects zero rows. That is the intended state: the function is the only door.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_delete_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task   record;
  v_impact jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select id, title, request_id, department_id, is_personal into v_task
    from vizserve_pms_tasks where id = p_task_id;

  if v_task is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_task.request_id is not null then
    raise exception 'This task came from a client request, so it cannot be deleted. Close it instead.'
      using errcode = 'insufficient_privilege';
  end if;

  if not vizserve_pms_can_delete_task(p_task_id) then
    raise exception 'Only a team leader of this department, or whoever created the task, can delete it.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Recorded BEFORE the row goes, with the whole cascade counted. This is the
  -- only trace that will exist afterwards, and "a task was deleted" without the
  -- hours attached to it is a log entry nobody can act on.
  v_impact := vizserve_pms_task_delete_impact(p_task_id);

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'deleted', auth.uid(),
    to_jsonb(v_task),
    v_impact
  );

  -- Notifications point at an entity that is about to stop existing, and an
  -- inbox row that opens onto a 404 is the bug docs/13 already records once.
  delete from vizserve_pms_notifications where entity_id = p_task_id;

  delete from vizserve_pms_tasks where id = p_task_id;

  return jsonb_build_object('ok', true, 'impact', v_impact);
end;
$$;

grant execute on function vizserve_pms_delete_task(uuid) to authenticated;

comment on function vizserve_pms_delete_task(uuid) is
  'P7-19. Hard-deletes an internal task and its subtree. Writes the audit row first, with the impact counts, because afterwards there is nothing left to count.';

-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE.
--
-- NO DELETE POLICY ON `vizserve_pms_tasks`. Adding one would create a second
-- route that skips the audit log and the request_id guard. The table stays
-- undeletable through PostgREST; `vizserve_pms_delete_task` is the only door.
--
-- LISTS AND FOLDERS ARE STILL ARCHIVED, NOT DELETED (`is_active`). A list holds
-- tasks, `tasks.list_id` is `on delete set null`, and deleting one would quietly
-- unfile every task in it — which looks like data loss to whoever owned them and
-- is not what "delete this list" is meant to mean. P7-18's guards say the same
-- for the reserved Client Requests folder.
--
-- STORAGE OBJECTS behind `vizserve_pms_task_attachments` are not removed here.
-- The rows cascade; the files in the bucket do not, because a database function
-- cannot reach storage. They are already orphaned by the same route when a
-- request is purged, and cleaning them up is its own job.
-- ---------------------------------------------------------------------------
