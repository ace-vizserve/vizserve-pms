-- P7-01 — a member records work they made for themselves.
--
-- Not all work is client work. Until now a task could only be created by a team
-- leader, so internal effort with no form behind it had nowhere to live — and
-- since the timesheet can only log time against a task (task_id NOT NULL, the
-- whole feature), work with no task was work with no hours.
--
-- THREE KINDS OF WORK, one table. The distinction settled on 18 Aug 2026:
--
--   request   arrived through a shared form, became a task when the TL approved
--             it at Gate 1. `request_id is not null`.
--   internal  the TL created it by hand (P3-12). No request, not personal.
--   personal  the member created it for themselves. THIS FILE.
--
-- `is_personal` is stored rather than derived, and that is a deliberate choice
-- over the tempting `created_by = assignee_id`: reassigning a task would flip
-- that derivation, silently changing which transitions are legal to a task
-- somebody is halfway through. A category that changes under you is worse than
-- no category.

alter table vizserve_pms_tasks
  add column is_personal boolean not null default false;

comment on column vizserve_pms_tasks.is_personal is
  'True only for a task created by its own assignee through '
  'vizserve_pms_create_personal_task. Never updatable — see the grant note below.';

-- `default false` backfills every existing row as non-personal, which is
-- correct: everything created before today came from a team leader.
--
-- NOTE WHAT IS *NOT* HERE: `is_personal` is deliberately absent from the
-- column-level UPDATE grant established in 20260803130000_p3_tasks_qa.sql. That
-- grant lists the columns `authenticated` may write, and this is not one of
-- them, so the flag cannot be changed after creation by anybody going through
-- PostgREST. This is the same mechanism that makes `status` unwritable.
--
-- It matters more than it looks. If a member could set `is_personal` on work
-- their lead assigned them, they could then close it themselves without review
-- — which is the one thing the three-way model must not allow.

-- ---------------------------------------------------------------------------
-- A second function, not a relaxed first one.
--
-- `vizserve_pms_create_task` answers "may I create work FOR SOMEONE ELSE" and
-- opens with `if not vizserve_pms_manages_department(...)`. This one answers
-- "may I record work FOR MYSELF". Collapsing them would give one function whose
-- parameter legality depends on another parameter — the department is fine if
-- you lead it, or if it is yours and the assignee is also you — which is two
-- rules wearing one name.
--
-- Keeping them separate also means no drop, no re-grant, no signature change,
-- and the existing "refuse a member outright" test in tests/db/tasks.test.ts
-- keeps its exact original meaning rather than quietly becoming a different
-- assertion.
--
-- NO p_department_id AND NO p_assignee_id. Both come from the caller's own user
-- row, so neither is the client's to send. Same reasoning as
-- vizserve_pms_submit_internal_request (20260804152000): a parameter that
-- cannot be supplied is a rule that cannot be bent.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_create_personal_task(
  p_title       text,
  p_description text default '',
  p_due_date    date default null,
  p_list_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor      uuid := auth.uid();
  v_user       vizserve_pms_users;
  v_title      text := nullif(btrim(coalesce(p_title, '')), '');
  v_task_id    uuid;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_user from vizserve_pms_users where id = v_actor;

  if v_user.id is null or not v_user.is_active then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  -- Same sentence as the internal-request path, because it is the same problem:
  -- a person with no department has nowhere for their work to be seen by the
  -- lead who is supposed to see it.
  if v_user.primary_department_id is null then
    raise exception 'You are not assigned to a department, so there is nowhere to file this.'
      using errcode = 'check_violation';
  end if;

  if v_title is null then
    raise exception 'A task needs a title.' using errcode = 'check_violation';
  end if;

  -- Lists are department-scoped, and a member can already read the ones in
  -- their own department. Borrowing another department's list would file the
  -- task somewhere its own lead does not look.
  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id and l.department_id = v_user.primary_department_id
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, list_id, created_by, is_personal
  ) values (
    -- No request: this did not come from a form. No QA reviewer: nobody was
    -- asked to review it, and P7-02 is what lets it finish without one.
    null, v_user.primary_department_id, v_title, coalesce(btrim(p_description), ''), 'OPEN',
    v_actor, null, p_due_date, p_list_id, v_actor, true
  )
  returning id into v_task_id;

  perform vizserve_pms_write_audit_log(
    'task', v_task_id, 'created', v_actor, null,
    jsonb_build_object('manual', true, 'personal', true, 'title', v_title)
  );

  -- Deliberately no vizserve_pms_notify. `vizserve_pms_create_task` notifies
  -- because it hands work to somebody else; nobody needs telling that they
  -- gave themselves a job.

  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- No RLS change, and no INSERT policy — this is not an omission.
--
-- The SELECT and UPDATE policies from 20260803110000_p2_00_approval_engine.sql
-- already read:
--
--   assignee_id = auth.uid()
--   or qa_assignee_id = auth.uid()
--   or vizserve_pms_manages_department(department_id)
--
-- A personal task is assigned to its creator and filed in their department, so
-- the member sees it by the first clause and their team leader by the third.
-- That is exactly the visibility the decision asked for: personal work is not
-- secret work, it is just not client work.
--
-- `vizserve_pms_tasks` has NO INSERT POLICY ANYWHERE, and still does not. Every
-- task in this system is born inside a `security definer` function — the
-- approval transaction, `vizserve_pms_create_task`, or this one. That is why
-- lib/database.types.ts declares `Insert: never` for the table.
-- ---------------------------------------------------------------------------

grant execute on function vizserve_pms_create_personal_task(text, text, date, uuid)
  to authenticated;
