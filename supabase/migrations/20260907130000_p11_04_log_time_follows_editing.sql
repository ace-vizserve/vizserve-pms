-- ============================================================================
-- P11-04 — logging time follows editing.
--
-- P11-03 opened a department's tasks to every active member of that department.
-- `vizserve_pms_may_log_time` did not follow, so a colleague could retitle a
-- task, move its dates, reassign it and comment on it — and then be refused when
-- they tried to record the hour they had just spent on it. Amier, 7 Sep 2026:
-- make it follow.
--
-- ⚠️ THE GAP WAS SMALLER THAN IT LOOKED, and this is worth stating because the
-- obvious reading of the codebase gets it wrong. `may_log_time` is defined by
-- `create or replace` in THREE files, and grepping finds the oldest first:
--
--   20260817090000_p6_01_timesheet.sql          PIC or QA        (superseded)
--   20260818160000_p7_13_task_assignees.sql     is_on_task
--   20260904100000_p8_13_may_log_time_repair    is_on_task       (current)
--
-- So the live rule already admitted every assignee on the join table and every
-- covering reliever. What it did not admit is the department.
--
-- ----------------------------------------------------------------------------
-- ⚠️ THIS FILE IS NOW THE NEWEST DEFINITION, AND THAT MATTERS HERE MORE THAN
-- ANYWHERE. P8-13 exists precisely because migrations reach this database BY
-- HAND, and re-pasting an older file after a newer one silently reinstates the
-- narrower rule. Nothing raises. The policies call the function by name and
-- never restate its body, so the only symptom is an INSERT refused with 42501,
-- which the app renders as a sentence about three unrelated rules.
--
-- IF SOMEBODY REPORTS "I CAN EDIT THIS TASK BUT NOT LOG TIME AGAINST IT", check
-- which of the four definitions is live before looking anywhere else.
-- ============================================================================

create or replace function vizserve_pms_may_log_time(p_task_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  -- On the task: assignee, QA reviewer, on the join table, or covering it while
  -- somebody is on leave (P7-13, P9-01). Unchanged.
  select vizserve_pms_is_on_task(p_task_id, p_user_id)

  -- P11-04. An active member of the task's own department, matching what
  -- `p11_03` opened for editing.
  or exists (
    select 1
      from vizserve_pms_tasks t
      join vizserve_pms_users u on u.id = p_user_id
     where t.id = p_task_id
       and u.is_active
       and u.primary_department_id = t.department_id
  )

  /*
   * And a lead of that department, which editing has always allowed.
   *
   * ⚠️ READ FROM THE TABLE, NOT THROUGH `vizserve_pms_manages_department`. That
   * helper answers about `auth.uid()`, and this function takes an explicit
   * `p_user_id` — every caller happens to pass `auth.uid()` today, but a
   * function whose answer silently ignores its own argument is a trap set for
   * whoever calls it differently later.
   */
  or exists (
    select 1
      from vizserve_pms_tasks t
      join vizserve_pms_user_managed_departments m
        on m.department_id = t.department_id
       and m.user_id = p_user_id
     where t.id = p_task_id
  );
$$;

grant execute on function vizserve_pms_may_log_time(uuid, uuid) to authenticated;

comment on function vizserve_pms_may_log_time(uuid, uuid) is
  'P11-04. Who may record hours against a task: anyone on it (assignee, QA, join table, '
  'covering reliever), any active member of its department, or a lead of that department. '
  'Deliberately the same set that may EDIT the task — see p11_03.';

-- ============================================================================
-- WHAT THIS DOES NOT CHANGE.
--
-- The other three rules on a timesheet entry are untouched, and they are the
-- ones that actually protect the record: you may only log against a day that
-- has happened, only in a week you have not submitted yet, and only as
-- yourself. This widens WHICH TASK, and nothing else.
--
-- ⚠️ ONE CONSEQUENCE WORTH KNOWING. Hours can now be recorded against a task
-- the person was never assigned to. That is the point — it is how somebody who
-- helped for an hour records the hour — but it does mean "time logged against
-- this task" and "people assigned to this task" are now genuinely different
-- questions. Phase 6 reporting should not treat one as a proxy for the other.
-- ============================================================================
