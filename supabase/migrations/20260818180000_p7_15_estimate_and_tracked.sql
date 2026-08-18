-- P7-15 / K5 — what a task row shows without being opened.
--
-- Two things, and only one of them is a column.
--
--   1. `estimate_minutes` — how long somebody thinks it will take.
--   2. `vizserve_pms_task_time_tracked` — how long it actually took, which
--      CANNOT be read with a plain sum. See below; this is the whole reason the
--      function exists.
--
-- Progress and "date closed" need neither: progress is completed children over
-- total children (P7-09, one level, enforced by trigger), and the closing date
-- is already in `vizserve_pms_task_status_history`. Adding a `completed_at`
-- would be a second copy of a fact the trail already holds, free to disagree
-- with it — and it would be wrong the first time an internal task is reopened,
-- which P7-13 now allows freely.

-- ---------------------------------------------------------------------------
-- 1. The estimate.
--
-- THIS PARTIALLY LIFTS A DEFERRAL THAT WAS MADE ON PURPOSE.
-- `docs/07-phase-3-tasks-qa.md:105` puts "Time estimates and burndown" out of
-- scope. The estimate is now in; BURNDOWN STAYS OUT. An estimate is a field on
-- a task. Burndown is a report with a velocity model behind it, and nobody has
-- asked for one — recorded here so the next person reads a decision rather than
-- an inconsistency.
--
-- Minutes, like every other duration in this schema, so `2h` parses the same
-- way in this field as in a timesheet cell (`parseCellDuration`).
-- ---------------------------------------------------------------------------
alter table vizserve_pms_tasks
  add column estimate_minutes integer;

alter table vizserve_pms_tasks
  add constraint vizserve_pms_tasks_estimate_sane
  check (estimate_minutes is null or (estimate_minutes > 0 and estimate_minutes <= 100000));

comment on column vizserve_pms_tasks.estimate_minutes is
  'P7-15. How long the work is expected to take, in minutes. NULL means nobody '
  'estimated it, which is the ordinary case. Compared against the rollup in '
  'vizserve_pms_task_time_tracked, never against a stored actual.';

-- Editable like the other task metadata, and for the same reason: re-estimating
-- is ordinary work. ADDITIVE grant — the column list on this table is never
-- restated. P7-11 restated it, silently dropped `start_date` and
-- `parent_task_id`, and made both read-only across the whole app until P7-11a
-- put them back.
grant update (estimate_minutes) on vizserve_pms_tasks to authenticated;

-- 100000 minutes is about ten working weeks. Not a policy — a typo ceiling, so
-- a mis-keyed `2000` hours fails here rather than rendering as a task that
-- takes two years.

-- ---------------------------------------------------------------------------
-- 2. Time tracked.
--
-- A PLAIN SUM WOULD BE WRONG FOR EVERY VIEWER, AND WOULD LOOK RIGHT.
--
-- `vizserve_pms_timesheet_entries`' SELECT policy is "your own rows, or your
-- team's if you lead their department" (20260817090000:154-164). So a member
-- summing that table for a task gets ONLY THE HOURS THEY LOGGED THEMSELVES.
-- Two people on one task read two different totals from the same row, a lead
-- reads a third, and none of them is the task's actual time. Nobody would
-- report it — they would quietly stop trusting the column, which is worse.
--
-- So the sum happens INSIDE a definer, and the only thing the policy still
-- decides is which tasks appear in the result at all. Same shape and same
-- reason as `vizserve_pms_leave_calendar`: a policy grants a ROW, and an
-- aggregate over rows the caller cannot individually read has nowhere else to
-- live.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN: who logged what. The total is a
-- property of the task; the breakdown is somebody's timesheet, and the
-- timesheet's own policy is the right place for that question to be asked.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_task_time_tracked(p_task_ids uuid[])
returns table (task_id uuid, minutes integer)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select e.task_id, sum(e.minutes)::integer
    from vizserve_pms_timesheet_entries e
   where e.task_id = any(p_task_ids)
     -- The caller must already be able to see the TASK. Without this line the
     -- definer would report hours on any task whose id somebody could guess,
     -- which is the failure mode every SECURITY DEFINER in this schema is
     -- written to avoid.
     and exists (
       select 1 from vizserve_pms_tasks t
        where t.id = e.task_id
          and (
            t.assignee_id = auth.uid()
            or t.qa_assignee_id = auth.uid()
            or vizserve_pms_manages_department(t.department_id)
            or vizserve_pms_is_on_task(t.id, auth.uid())
          )
     )
   group by e.task_id;
$$;

revoke all on function vizserve_pms_task_time_tracked(uuid[]) from public, anon;
grant execute on function vizserve_pms_task_time_tracked(uuid[]) to authenticated;

comment on function vizserve_pms_task_time_tracked(uuid[]) is
  'P7-15. Total minutes logged against each task the caller can see. SECURITY '
  'DEFINER because the timesheet policy is per-person: a plain sum would show '
  'each viewer only their own hours and call it the task total.';
