-- P7-43 — internal tasks have no person in charge.
--
-- THE RULE. On a CLIENT task — one with a `request_id` — somebody has to be
-- answerable to the person who filed the request, and that is what
-- `assignee_id` names. On an INTERNAL task there is no such person: the work
-- belongs to the team doing it, and everyone on it is an equal assignee.
--
-- This file changes ONE function, `vizserve_pms_remove_task_assignee`, and the
-- change is small. It matters because without it "everyone is equal" is a claim
-- the screens make and the database refuses:
--
--   P7-13 wrote "the accountable name cannot be removed from here. It is a
--   column, not a row in this table, and emptying it is a reassignment rather
--   than a removal." That was exactly right while every task had a PIC. On an
--   internal task it now means one of the equal assignees cannot be taken off
--   while the others can — a rank, reintroduced by the one operation that is
--   supposed to prove there isn't one.
--
-- SO: on an internal task, removing the person named in `assignee_id` PROMOTES
-- another assignee into the column and then removes them. On a client task the
-- refusal stands, word for word.
--
-- WHY PROMOTE RATHER THAN JUST NULL THE COLUMN. Three things still read
-- `assignee_id` directly on every task, internal or not — the "assigned to you"
-- notification, the board's ordering, and the first clause of both tasks
-- policies. Nulling it while other people are demonstrably on the task would
-- make it a task with assignees that reads as unassigned everywhere those three
-- look. Promotion keeps the column truthful: it names *an* assignee, and on an
-- internal task that is all it ever claims to be.
--
-- WHEN THE LAST ONE LEAVES, the column does go null — an unassigned task, which
-- is an ordinary state this schema has always allowed. It is also recoverable:
-- both tasks policies carry `vizserve_pms_manages_department(department_id)`, so
-- a department lead can always put somebody back on. That clause is what makes
-- this safe, and it is the reason this file does not need to forbid the case.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor.
--
-- READ BEFORE EDITING. The body below is P7-13's, with the accountable-name
-- branch replaced. Both of the guards above it must survive any rewrite:
--   * the `coalesce(…, false)` on the authorization test — P7-00's fix. A
--     nullable comparison yields NULL, `not NULL` is NULL, and `IF NULL THEN`
--     does not fire.
--   * "you must already be on it or lead its department". A member may not take
--     somebody off work they have nothing to do with.

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

  if not (
    coalesce(vizserve_pms_is_on_task(p_task_id, v_actor), false)
    or coalesce(vizserve_pms_manages_department(v_task.department_id), false)
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

-- Signature unchanged, so this is a plain replace — no drop, and the existing
-- grant still stands. Restated anyway: P7-11 restated a column grant list and
-- silently dropped two columns, and the habit of making privileges explicit
-- after a `create or replace` is cheaper than the outage that taught it.
grant execute on function vizserve_pms_remove_task_assignee(uuid, uuid) to authenticated;

comment on function vizserve_pms_remove_task_assignee(uuid, uuid) is
  'P7-43. Takes somebody off a task. On a CLIENT task the person named in '
  'assignee_id cannot be removed here — that is a reassignment. On an INTERNAL '
  'task there is no person in charge, so removing them promotes the next '
  'assignee into the column first, or leaves it null if they were the last.';
