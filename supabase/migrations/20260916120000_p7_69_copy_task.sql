-- P7-69 — copying a task into another list.
--
-- THE CASE THIS EXISTS FOR is the monthly audit: the same nineteen-step
-- procedure, a new cycle, a new task. Today that means retyping it, which is
-- why the checklists were in ClickUp and not here.
--
-- ⚠️ A COPY IS A NEW TASK, NOT A CLONE, and four fields say so no matter what
-- the caller asks for:
--
--   `status`      always OPEN. Copying a COMPLETED task as COMPLETED is a claim
--                 that work has happened, and the state machine has no legal
--                 path into COMPLETED at birth anyway (`import_01` hit the same
--                 wall and said so).
--   `request_id`  always null. A client request has ONE task. A copy is not that
--                 task, and a second task pointing at the request would show up
--                 on the Gate 3 approval page as a rival answer.
--   `resolution`  always null. It describes work that was done once.
--   `is_personal` always false. A personal task is one somebody made for
--                 themselves; `is_personal` is outside the UPDATE grant
--                 precisely so it cannot be acquired later, and a copy is a
--                 later.
--
-- ⚠️ SAME DEPARTMENT ONLY, and that is narrower than "any list you can see".
-- A task belongs to a department and that is who can read it; copying VizBytes
-- work into a VizMedia list would hand it to a different audience under the
-- guise of a convenience. The target list must already belong to the source's
-- department — the same rule `create_task` applies to `p_list_id`, for the same
-- reason.
--
-- ⚠️ `p_include text[]`, NOT EIGHT BOOLEANS. Adding an option later is then a
-- new value in an array rather than a changed argument list — and a changed
-- argument list means drop, recreate and regrant, which P7-14 calls "the dance"
-- and avoided for exactly this reason. Unknown values are ignored rather than
-- refused: a newer client asking for something this version has not heard of
-- should get a copy without it, not an error.

create or replace function vizserve_pms_copy_task(
  p_task_id uuid,
  p_list_id uuid,
  p_include text[] default array['description', 'priority', 'estimate', 'checklist']
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor  uuid := auth.uid();
  v_mine   uuid;
  v_source vizserve_pms_tasks;
  v_dept   uuid;
  v_new    uuid;
  v_title  text;
  v_has    boolean;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_source from vizserve_pms_tasks t where t.id = p_task_id;

  if v_source.id is null then
    raise exception 'That task does not exist.' using errcode = 'no_data_found';
  end if;

  /*
   * ⚠️ THE READ IS CHECKED BY HAND BECAUSE THIS IS `security definer`. RLS is
   * bypassed inside here, so the predicate the task's own SELECT policy would
   * have applied has to be restated — the one place in this file where the
   * P11-06 "defer, do not restate" rule cannot be followed, and the reason it
   * is written out rather than assumed. A member reads their department's
   * tasks; a lead reads the departments they lead.
   */
  select u.primary_department_id into v_mine
    from vizserve_pms_users u
   where u.id = v_actor and u.is_active;

  v_dept := v_source.department_id;

  if not (
    coalesce(vizserve_pms_manages_department(v_dept), false)
    or (v_mine is not null and v_dept = v_mine)
  ) then
    raise exception 'That task is outside your scope.' using errcode = 'insufficient_privilege';
  end if;

  -- The target list, in the SAME department. Null means "no list", which is a
  -- real place for a task to live and is how a copy lands unfiled.
  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id and l.department_id = v_dept
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  /*
   * ⚠️ "(copy)" ONLY WHEN IT LANDS BESIDE THE ORIGINAL. Two identical titles in
   * one list is a list you cannot read; two identical titles in two lists is
   * the normal case — "Updating of Student P-Files" is the same work in a new
   * month and does not want a suffix it will carry forever.
   */
  v_title := case
    when p_list_id is not distinct from v_source.list_id then left(v_source.title || ' (copy)', 200)
    else v_source.title
  end;

  insert into vizserve_pms_tasks (
    request_id, department_id, list_id, is_personal, title, description, status,
    assignee_id, qa_assignee_id, due_date, start_date, priority, estimate_minutes,
    created_by
  ) values (
    null,
    v_dept,
    p_list_id,
    false,
    v_title,
    case when 'description' = any(p_include) then v_source.description else '' end,
    'OPEN',
    case when 'assignees' = any(p_include) then v_source.assignee_id else null end,
    case when 'assignees' = any(p_include) then v_source.qa_assignee_id else null end,
    case when 'dates' = any(p_include) then v_source.due_date else null end,
    case when 'dates' = any(p_include) then v_source.start_date else null end,
    case when 'priority' = any(p_include) then v_source.priority else null end,
    case when 'estimate' = any(p_include) then v_source.estimate_minutes else null end,
    v_actor
  )
  returning id into v_new;

  -- P7-13's second assignees. Only alongside the PIC — a task carrying five
  -- participants and no owner is not a state this app produces on purpose.
  if 'assignees' = any(p_include) then
    insert into vizserve_pms_task_assignees (task_id, user_id)
    select v_new, a.user_id
      from vizserve_pms_task_assignees a
     where a.task_id = p_task_id
    on conflict do nothing;
  end if;

  -- P7-68. Unticked, whatever the original says: the procedure is about to be
  -- followed again, and copying the ticks would claim it already has been.
  if 'checklist' = any(p_include) then
    insert into vizserve_pms_task_checklist_items (task_id, group_label, label, is_done, position)
    select v_new, c.group_label, c.label, false, c.position
      from vizserve_pms_task_checklist_items c
     where c.task_id = p_task_id;
  end if;

  /*
   * ⚠️ SUBTASKS ARE COPIED AS SUBTASKS OF THE COPY, and only one level deep —
   * which costs nothing to enforce here because one level is all that can
   * exist. The P7-09 trigger refuses a parent that already has one.
   *
   * They inherit nothing but their titles: a subtask's assignee and dates
   * belong to the cycle that produced them.
   */
  if 'subtasks' = any(p_include) then
    select exists (select 1 from vizserve_pms_tasks s where s.parent_task_id = p_task_id) into v_has;

    if v_has then
      insert into vizserve_pms_tasks (
        request_id, department_id, list_id, is_personal, title, description,
        status, parent_task_id, created_by
      )
      select null, v_dept, p_list_id, false, s.title,
             case when 'description' = any(p_include) then s.description else '' end,
             'OPEN', v_new, v_actor
        from vizserve_pms_tasks s
       where s.parent_task_id = p_task_id
       order by s.created_at;
    end if;
  end if;

  return v_new;
end;
$$;

-- Attachments and comments are deliberately absent and have no option. An
-- attachment is a file somebody produced for THAT task and a comment is
-- something somebody said about it; copying either puts words in people's
-- mouths under a new heading. The storage cost is the smaller argument.

grant execute on function vizserve_pms_copy_task(uuid, uuid, text[]) to authenticated;
