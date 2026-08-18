-- ---------------------------------------------------------------------------
-- P7-17 — a department can see itself.
--
-- Two gaps, and the first is a live bug rather than a feature request.
--
-- 1. A MEMBER COULD NOT SEE THEIR OWN COLLEAGUES. `vizserve_pms_users` is
--    readable as "yourself, or anyone in a department you MANAGE, or everything
--    if you are an admin" (P0-06). A member manages nothing, so they read
--    exactly one row: their own. P7-14 then gave members the right to create and
--    reassign work to a colleague in their own department — and never widened
--    this, so the assignee picker was empty for the very people the migration
--    was written for. The capability was real and unusable.
--
-- 2. A member could not see their department's WORK. Tasks are readable by the
--    PIC, the QA reviewer, anyone on the join table, and department leads. So
--    two people in one department, neither on the other's tasks, worked in the
--    same room and saw none of each other's client or internal work.
--
-- ⚠️ WHAT THIS COSTS, STATED RATHER THAN DISCOVERED. After this, every active
-- member of a department can read every non-personal task in it — client work
-- included — and can read the name and department of everyone in it. That is a
-- real widening and it is what was asked for: a team that cannot see its own
-- board is a team that keeps a second board somewhere else.
--
-- PERSONAL TASKS ARE THE EXPLICIT EXCEPTION AND STAY PRIVATE. `is_personal`
-- exists to mean "work I recorded for myself" (P7-01), and the whole point of it
-- is that its owner closes it without a reviewer. Publishing it to the
-- department would turn a private to-do list into a public one, which is not
-- what anybody agreed to when the column was added. A lead still sees them,
-- exactly as before — that is not new, and it is what makes a department's hours
-- add up on the timesheet.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, and paste this file as it stands
-- at that moment.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The caller's own department.
--
-- SECURITY DEFINER IS NOT OPTIONAL HERE. This function is called from a policy
-- ON `vizserve_pms_users`, and reading that table from inside its own policy
-- re-enters the policy — infinite recursion, which Postgres reports as a stack
-- depth error on every single query against the table. A definer function runs
-- as the owner, so the read inside it is not policed and the recursion cannot
-- start.
--
-- `stable` so it is evaluated once per statement rather than once per row.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_my_department()
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select u.primary_department_id
    from vizserve_pms_users u
   where u.id = auth.uid()
     and u.is_active
$$;

comment on function vizserve_pms_my_department() is
  'P7-17. The caller''s own department. SECURITY DEFINER because it is called from a policy on the table it reads.';

-- It runs INSIDE a policy, and policy expressions run as the querying role — so
-- without this grant every query against the table reads `permission denied for
-- function`, which is a GRANT diagnosis and never a policy one.
grant execute on function vizserve_pms_my_department() to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Colleagues.
--
-- Additive: the three existing policies stay exactly as they are. RLS policies
-- for the same command are OR-ed, so this only ever widens, and dropping the
-- others to "simplify" would take an admin's or a lead's access with it.
--
-- Active people only. A deactivated colleague is not somebody to assign work to,
-- and their row staying readable is how a leaver keeps appearing in pickers.
-- ---------------------------------------------------------------------------
-- `if exists` on both drops so this file is safe to re-run: the first paste of
-- it failed partway through on the wrong policy name below, and a migration that
-- cannot be run twice is one you have to hand-unpick before fixing it.
drop policy if exists "users read own department" on vizserve_pms_users;

create policy "users read own department"
  on vizserve_pms_users for select to authenticated
  using (
    is_active
    and primary_department_id is not null
    and primary_department_id = vizserve_pms_my_department()
  );

-- ---------------------------------------------------------------------------
-- 2. The department's work.
--
-- Dropped and recreated because a policy's USING cannot be altered in place.
-- Every clause P7-13 had is kept verbatim; one is added.
-- ---------------------------------------------------------------------------
-- ⚠️ THE NAME MUST MATCH EXACTLY — "readable", not "visible".
--
-- The first version of this file said "visible" and the paste failed with
-- `42704: policy ... does not exist`. p7_13 records the danger in the other
-- direction and it is the worse one: a DROP that silently matches nothing leaves
-- the old policy alive beside the new one, and two permissive policies are OR-ed,
-- so the result is WIDER than either was meant to be. Failing loudly was the
-- lucky outcome.
drop policy if exists "tasks readable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    -- P7-13. Without this line a second assignee cannot see the task at all,
    -- and every other right depending on it is unreachable for them.
    or vizserve_pms_is_on_task(id, auth.uid())
    -- P7-17. Anyone in the department, for work that is not somebody's own
    -- private list. `is_personal` is false on every client task and on every
    -- task a lead created by hand, so this covers both kinds of shared work.
    --
    -- The three clauses above still matter: a personal task is visible to its
    -- owner through `assignee_id`, and to a lead through
    -- `manages_department` — this clause is the only one that excludes them.
    or (not is_personal and department_id = vizserve_pms_my_department())
  );

-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE.
--
-- THE UPDATE POLICY. Seeing your department's work does not mean editing it:
-- `tasks updatable by participants and department leads` still requires you to
-- be a participant or a lead to touch a row at all (P7-14 widened only its WITH
-- CHECK, so that a task could be handed to a colleague — never its USING).
-- Widening SELECT and UPDATE together would have made every member an editor of
-- everything in their department, which is a different decision that nobody
-- made.
--
-- `vizserve_pms_transition_task` is untouched for the same reason: its ownership
-- guard reads participation, not visibility. A member can now WATCH a colleague's
-- task move; they still cannot move it.
--
-- The timesheet entries policy is untouched. It is owner-or-their-lead, and
-- hours are a payroll record rather than a board — which is also why
-- `vizserve_pms_task_time_tracked` is SECURITY DEFINER: the task total has to be
-- readable by people who cannot read the individual entries behind it.
-- ---------------------------------------------------------------------------
