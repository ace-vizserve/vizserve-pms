-- ============================================================================
-- P11-03 — a department's tasks and lists are the department's to edit,
--          and every edit is now recorded.
--
-- P7-14 settled this the other way: you could edit a task only if you were the
-- assignee, the QA reviewer, on `vizserve_pms_task_assignees`, a covering
-- reliever, or a lead of that department. Its own comment set out the choice —
-- "you may hand this to someone in this department" rather than "members of
-- this department may edit anything". Amier, 7 Sep 2026: the second one. A
-- colleague who spots a wrong due date should fix it, not go and find whoever
-- the task is filed under.
--
-- ----------------------------------------------------------------------------
-- ⚠️ THE AUDIT TRIGGER IS THE CONDITION, NOT A NICETY, AND IT IS FIRST IN THIS
-- FILE FOR THAT REASON.
--
-- The permission was granted on the basis that every action is logged, and the
-- surprise is that task edits were NOT. This app has no audit triggers at all:
-- every row in `vizserve_pms_audit_logs` is written by hand inside an RPC, and
-- `updateTaskField` is not an RPC — it is a direct PostgREST UPDATE on the
-- table. So a PIC retitling a task, moving its dates or changing its priority
-- has never left a trace. Widening the policy without fixing that would take a
-- blind spot and hand it to the whole department.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS DOES NOT TOUCH, and it is most of the app.
--
--   DTR                 your own punches, and a lead's corrections
--   Timesheet           your own hours, and your lead's approval of them
--   Internal approvals  leave, overtime, corrections, reimbursement
--
-- Those are records ABOUT a person rather than work owned by a team, and the
-- chain that approves them is the whole point of the feature. Nothing below
-- goes near their policies.
--
-- ⚠️ AND `status` IS STILL NOT EDITABLE HERE. It is outside the column-level
-- UPDATE grant (p7_11a), so no policy can open it — a status only ever changes
-- through `vizserve_pms_transition_task`, which keeps its own actor rules
-- ("Only the person in charge can do that"). Widening this policy does not let
-- a member move somebody else's task through a gate.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. THE RECORD.
--
-- One generic trigger function, used by both tables. It logs only the columns
-- that actually CHANGED, because a diff of forty columns to say a due date
-- moved is a log nobody reads twice.
--
-- ⚠️ TG_ARGV[1] IS A SKIP LIST, AND IT EXISTS TO STOP DOUBLE-LOGGING. Several
-- RPCs already write their own, better audit rows — `transition_task` records a
-- status move with its comment, and every table carries an `updated_at` that
-- changes on every write and means nothing on its own. Both are skipped, and an
-- update that touches nothing else produces no row at all rather than an empty
-- one.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_audit_row_update()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_before  jsonb := to_jsonb(old);
  v_after   jsonb := to_jsonb(new);
  v_skip    text[] := coalesce(tg_argv[1]::text[], array[]::text[]);
  v_changed_before jsonb := '{}'::jsonb;
  v_changed_after  jsonb := '{}'::jsonb;
  v_key     text;
begin
  for v_key in select jsonb_object_keys(v_after) loop
    continue when v_key = any (v_skip);

    -- `is distinct from` rather than `<>`: a column going to or from NULL is a
    -- change, and `<>` would return NULL for it and quietly log nothing.
    if v_before -> v_key is distinct from v_after -> v_key then
      v_changed_before := v_changed_before || jsonb_build_object(v_key, v_before -> v_key);
      v_changed_after  := v_changed_after  || jsonb_build_object(v_key, v_after  -> v_key);
    end if;
  end loop;

  if v_changed_after = '{}'::jsonb then
    return new;
  end if;

  perform vizserve_pms_write_audit_log(
    tg_argv[0], new.id, 'updated', auth.uid(), v_changed_before, v_changed_after
  );

  return new;
end;
$$;

comment on function vizserve_pms_audit_row_update() is
  'P11-03. AFTER UPDATE trigger. Logs the changed columns only. TG_ARGV[0] is the '
  'entity_type; TG_ARGV[1] is a skip list, for columns another audit path already covers.';

drop trigger if exists vizserve_pms_tasks_audit_update on vizserve_pms_tasks;
create trigger vizserve_pms_tasks_audit_update
  after update on vizserve_pms_tasks
  for each row
  execute function vizserve_pms_audit_row_update('task', '{updated_at,status}');

drop trigger if exists vizserve_pms_lists_audit_update on vizserve_pms_lists;
create trigger vizserve_pms_lists_audit_update
  after update on vizserve_pms_lists
  for each row
  execute function vizserve_pms_audit_row_update('list', '{updated_at}');


-- ---------------------------------------------------------------------------
-- 2. THE PERMISSION — tasks.
--
-- Every clause P7-14 had, plus one: an active member whose primary department
-- is this task's department.
--
-- ⚠️ THIS COVERS CLIENT TASKS TOO, and P7-14's comment flagged exactly that
-- before deciding the other way. It follows from the decision rather than being
-- an oversight: the department that does the work owns the record of it. Gate 2
-- and Gate 3 are unaffected — those are status moves, and status is not
-- editable through this policy at all.
--
-- `primary_department_id`, not a membership table, because that is what this
-- schema means by "a member of a department" everywhere else — the same test
-- `p3_tasks_qa.sql:66` uses to decide who can SEE a department's lists.
-- ---------------------------------------------------------------------------
drop policy if exists "tasks updatable by participants and department leads" on vizserve_pms_tasks;
drop policy if exists "tasks updatable by the department" on vizserve_pms_tasks;

create policy "tasks updatable by the department"
  on vizserve_pms_tasks for update to authenticated
  using (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    or vizserve_pms_is_on_task(id, auth.uid())
    -- P11-03.
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_tasks.department_id
    )
  )
  with check (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    or vizserve_pms_is_on_task(id, auth.uid())
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_tasks.department_id
    )
    -- P7-14, unchanged: the RESULT may name a colleague, provided they are an
    -- active member of this task's department. Kept so a reassignment does not
    -- fail because the caller wrote themselves out of the row.
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = vizserve_pms_tasks.assignee_id
         and u.is_active
         and u.primary_department_id = vizserve_pms_tasks.department_id
    )
  );


-- ---------------------------------------------------------------------------
-- 3. THE PERMISSION — lists.
--
-- P8-01c narrowed this to `vizserve_pms_is_dept_admin(department_id)`. Same
-- reasoning as above: a list is where a department's work lives, and renaming
-- one should not need a ticket.
--
-- ⚠️ INSERT AND DELETE ARE NOT TOUCHED. Creating and removing lists reshapes
-- the project tree for everybody in the department, and that is a different act
-- from correcting the name of one. Amier asked for editable; this is editable.
-- ---------------------------------------------------------------------------
drop policy if exists "lists editable by department admin" on vizserve_pms_lists;
drop policy if exists "lists updatable by the department" on vizserve_pms_lists;

create policy "lists updatable by the department"
  on vizserve_pms_lists for update to authenticated
  using (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_lists.department_id
    )
  )
  with check (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_lists.department_id
    )
  );


-- ============================================================================
-- ⚠️ ONE INCONSISTENCY THIS DOES NOT FIX, RAISED RATHER THAN QUIETLY SETTLED.
--
-- `vizserve_pms_may_log_time` is stricter than editing: it admits only the
-- assignee and the QA reviewer, so somebody on `vizserve_pms_task_assignees`
-- can edit a task and comment on it but cannot log time against it — and after
-- this migration, so can anyone in the department. Whether logging time should
-- follow editing is a policy question about the timesheet, not about tasks, and
-- the timesheet is deliberately out of scope here.
-- ============================================================================
