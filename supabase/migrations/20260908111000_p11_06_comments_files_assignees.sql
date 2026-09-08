-- P11-06 — comments, files and assignees follow the task.
--
-- The rest of the 7 Sep decision. P11-03 opened the task's columns, P11-04 its
-- timesheet, P11-05 its status. Four things were still shut, and none of them
-- was shut on purpose — each is a rule that was WRITTEN as "follows the task"
-- and then hand-rolled a narrower predicate beside it.
--
-- ⚠️ THE COMMENT ONE IS A BUG THAT PREDATES ALL OF THIS. The INSERT policy was
-- `assignee_id OR qa_assignee_id OR manages_department`, and it never got
-- `vizserve_pms_is_on_task` when P7-13 added second assignees. So somebody
-- handed a task could edit it, move it and log hours against it, and could not
-- say a word on it. Nobody reported it because the button was simply absent.
--
-- ⚠️ WHAT CHANGES IS THE SHAPE, NOT JUST THE AUDIENCE. Both tables now DEFER to
-- the task's own readability instead of restating it:
--
--     exists (select 1 from vizserve_pms_tasks t where t.id = task_id)
--
-- RLS applies inside that subquery, so it reads exactly "if you can open the
-- task" — which is what all four policy comments already claimed, in those
-- words, while doing something else. Restating a rule is how it drifts; the
-- P7-08 header says so itself and then drifts anyway. This is the same fix
-- P11-01 made for the approval timeline with `may_read_internal_request`: one
-- rule, one place, and a future change to task visibility carries the
-- conversation and the files along with it.
--
-- WHAT DID NOT OPEN:
--   * The QA gate. Everybody is a member of their own department, so a Gate 2
--     that admitted the department seat is a gate every person walks through on
--     the work they just finished. Still `v_is_qa OR v_leads` in
--     `vizserve_pms_transition_task`.
--   * Deleting a task, and creating or deleting a list — decided 7 Sep.
--   * Deleting somebody ELSE'S attachment. Your own upload is yours to withdraw;
--     removing another person's output is still a lead decision, on the same
--     reasoning that keeps a lead out of other people's comments.


-- ---------------------------------------------------------------------------
-- 1. COMMENTS.
--
-- `author_id = auth.uid()` stays on the INSERT and is the load-bearing half:
-- it is what stops a comment being posted under somebody else's name, which no
-- amount of UI care can prevent on its own.
-- ---------------------------------------------------------------------------
drop policy if exists "task comments follow their task" on vizserve_pms_task_comments;
create policy "task comments follow their task"
  on vizserve_pms_task_comments for select to authenticated
  using (exists (select 1 from vizserve_pms_tasks t where t.id = task_id));

drop policy if exists "task comments writable by people on the task" on vizserve_pms_task_comments;
drop policy if exists "task comments writable by anyone who can read the task" on vizserve_pms_task_comments;
create policy "task comments writable by anyone who can read the task"
  on vizserve_pms_task_comments for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (select 1 from vizserve_pms_tasks t where t.id = task_id)
  );

-- Unchanged, and stated here so the whole rule is readable in one file: your own
-- words are yours to fix or withdraw, and nobody else's are. Moderation is not a
-- feature anybody asked for, and silently editable discussion is worse than none.


-- ---------------------------------------------------------------------------
-- 2. ATTACHMENTS.
--
-- The SELECT was the quieter failure of the two: a colleague could open a task
-- in their own department and find the Outputs panel empty, with no indication
-- that anything was being withheld.
--
-- The INSERT keeps its terminal-status guard. A finished task's files are a
-- record, and that has nothing to do with who is asking.
-- ---------------------------------------------------------------------------
drop policy if exists "task attachments follow their task" on vizserve_pms_task_attachments;
create policy "task attachments follow their task"
  on vizserve_pms_task_attachments for select to authenticated
  using (exists (select 1 from vizserve_pms_tasks t where t.id = task_id));

drop policy if exists "task attachments insertable by participants" on vizserve_pms_task_attachments;
drop policy if exists "task attachments insertable by anyone who can read the task" on vizserve_pms_task_attachments;
create policy "task attachments insertable by anyone who can read the task"
  on vizserve_pms_task_attachments for insert to authenticated
  with check (
    exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id
         and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
    )
  );


-- ---------------------------------------------------------------------------
-- 3. ASSIGNEES — both functions, reproduced whole.
--
-- ⚠️ REPRODUCED, not patched, because that is the only safe way to change one
-- line of a function this schema redefines across several files. Re-pasting an
-- older migration silently reinstates an older rule and nothing raises — the
-- trap `may_log_time` and `transition_task` are both in. THESE ARE NOW THE LIVE
-- DEFINITIONS.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_add_task_assignee(p_task_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_task  vizserve_pms_tasks;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- P11-06 — the department may put people on its own work.
  --
  -- This read `is_on_task OR manages_department`, which meant a colleague could
  -- edit every field on a task, move it, and log hours against it, but could not
  -- add the second person who was going to help — the one change that makes all
  -- of the others make sense.
  --
  -- The person being ADDED is still checked below, and that check is the real
  -- guard: they must be an active member of this task's department. Widening who
  -- may press the button does not widen who can end up on the task.
  if not (
    coalesce(vizserve_pms_is_on_task(p_task_id, v_actor), false)
    or coalesce(vizserve_pms_manages_department(v_task.department_id), false)
    or coalesce(
         exists (
           select 1 from vizserve_pms_users u
            where u.id = v_actor
              and u.is_active
              and u.primary_department_id = v_task.department_id
         ),
         false
       )
  ) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_user_id and u.is_active
       and u.primary_department_id = v_task.department_id
  ) then
    raise exception 'That person is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  -- Already on it is not an error. Two people pressing the same button is the
  -- ordinary case, and a raise here would surface as a failure for something
  -- that is already true.
  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  values (p_task_id, p_user_id, v_actor)
  on conflict (task_id, user_id) do nothing;

  -- They are being handed work. Same channel and same shape as
  -- `vizserve_pms_create_task`'s assignment notice.
  if p_user_id <> v_actor then
    perform vizserve_pms_notify(
      p_user_id, 'assigned', 'Added to: ' || v_task.title,
      coalesce(v_task.description, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true);
end;
$$;


create or replace function vizserve_pms_remove_task_assignee(p_task_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_task  vizserve_pms_tasks;
  v_next  uuid;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- P11-06 — the department may put people on its own work.
  --
  -- This read `is_on_task OR manages_department`, which meant a colleague could
  -- edit every field on a task, move it, and log hours against it, but could not
  -- add the second person who was going to help — the one change that makes all
  -- of the others make sense.
  --
  -- The person being ADDED is still checked below, and that check is the real
  -- guard: they must be an active member of this task's department. Widening who
  -- may press the button does not widen who can end up on the task.
  if not (
    coalesce(vizserve_pms_is_on_task(p_task_id, v_actor), false)
    or coalesce(vizserve_pms_manages_department(v_task.department_id), false)
    or coalesce(
         exists (
           select 1 from vizserve_pms_users u
            where u.id = v_actor
              and u.is_active
              and u.primary_department_id = v_task.department_id
         ),
         false
       )
  ) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  if p_user_id = v_task.assignee_id then
    -- P7-43. A CLIENT task keeps its person in charge, and taking them off is a
    -- reassignment — a different decision, with its own control and its own
    -- department rule (P7-14).
    if v_task.request_id is not null then
      raise exception 'That is the person this task is assigned to. Reassign it instead.'
        using errcode = 'check_violation';
    end if;

    -- An INTERNAL task has no such person. Hand the column to somebody else who
    -- is already on the task, oldest membership first so the choice is stable
    -- and explicable rather than whatever the planner returned. `user_id`
    -- breaks a tie on identical `added_at`, which the import files produce
    -- because they insert in one statement.
    select a.user_id into v_next
      from vizserve_pms_task_assignees a
     where a.task_id = p_task_id
       and a.user_id <> p_user_id
     order by a.added_at, a.user_id
     limit 1;

    -- Null when they were the last one. That is an unassigned task, not an
    -- error — see the header.
    update vizserve_pms_tasks
       set assignee_id = v_next
     where id = p_task_id;
  end if;

  delete from vizserve_pms_task_assignees
   where task_id = p_task_id and user_id = p_user_id;

  return jsonb_build_object('ok', true);
end;
$$;
