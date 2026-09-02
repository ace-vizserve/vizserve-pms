-- ---------------------------------------------------------------------------
-- P8-01c — the powers behind the department-admin tick.
--
-- ⚠️ DEPENDS ON 20260903100100_p8_01b_admin_capability.sql, which creates
-- `vizserve_pms_is_dept_admin(uuid)` and the `is_dept_admin` column. Every
-- statement below calls that function; run this first and Postgres refuses the
-- lot with `function vizserve_pms_is_dept_admin(uuid) does not exist` (42883).
--
-- p8_01b said in as many words that it "GRANTS NOBODY ANY NEW POWER" and that
-- the powers were a follow-up. This is the follow-up, and it is deliberately
-- SMALL. Amier confirmed exactly three things the tick may do, all of them
-- inside the holder's own `primary_department_id`:
--
--   1. DEPARTMENT STRUCTURE   create, rename and archive their department's
--                             folders, lists and forms.
--   2. DATA HYGIENE           delete an internal task; force a stuck task's
--                             status.
--   3. THEIR AUDIT TRAIL      read audit rows for their own department's
--                             records. ⚠️ NOT IMPLEMENTED — see section 6,
--                             which is the longest section in this file
--                             because the honest answer took the most work.
--
-- ⚠️ AND THREE THINGS IT MUST NOT DO. These are the boundaries, not gaps
-- somebody forgot to fill, and each has its own guard:
--
--   ⛔ NO APPROVAL AUTHORITY. `vizserve_pms_manages_department` is untouched by
--      this file, exactly as p8_01b's closing section demanded. Members AND
--      department admins both report to the Team Leader, so the tick must not
--      put anybody into the Gate 1, internal-request or timesheet-week
--      approval queues. Not one line below names that function.
--   ⛔ NO STAFF RECORDS. Nothing here touches `vizserve_pms_users`. The write
--      policy there stays `vizserve_pms_is_admin()` and `/admin/users` stays
--      `requireRole("owner")`. THAT IS WHAT STOPS THE TICK ESCALATING ITSELF:
--      a department admin who could edit a user row could set their own
--      `role`, or hand the tick to a confederate.
--   ⛔ NOTHING COMPANY-WIDE. Not app settings, not leave types, not the holiday
--      calendar, not the unfiltered audit trail. The tick is scoped to one
--      department by construction — `vizserve_pms_is_dept_admin` compares
--      against `primary_department_id` — and a company-wide table has no
--      department to compare against, which is the tell that it is not the
--      tick's business.
--
-- ---------------------------------------------------------------------------
-- ⚠️ EVERY POLICY BELOW IS ADDITIVE. NOT ONE `drop policy` IN THIS FILE.
--
-- P7-54 wrote the reasoning and it is repeated here because it is the single
-- rule this file is organised around: multiple PERMISSIVE policies on one table
-- are OR-ed, so adding a branch as its own policy CANNOT NARROW ANYBODY'S
-- EXISTING ACCESS — and unlike a drop-and-create, there is no instant during
-- the paste where the old policy is absent and a live user is refused.
--
-- The alternative — dropping `lists writable by department leads` and
-- recreating it with `or vizserve_pms_is_dept_admin(...)` — would be the same
-- set of people at the end and strictly worse on the way there: a transaction
-- that dies between the drop and the create leaves a department with no write
-- access to its own lists, and this file is PASTED BY HAND.
--
-- The cost is that "who may write a list" is now spread across two policies. It
-- is stated at each one, and `\d+ vizserve_pms_lists` shows both.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7/P8 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`. Re-runnable: every policy is guarded
-- by a `drop policy if exists` OF ITS OWN NAME ONLY — which is a re-paste
-- guard, not a rewrite of anybody else's policy.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. FOLDERS — vizserve_pms_task_groups.
--
-- SELECT NEEDS NOTHING. `task groups readable in department` (p7_18) already
-- reads `department_id = vizserve_pms_my_department()`, and a department admin
-- is a member of the department they administer BY DEFINITION — the predicate
-- compares against `primary_department_id`, the team they belong to. So they
-- can already see the tree; what they could not do is reshape it.
--
-- ⚠️ INSERT AND UPDATE ONLY. NO DELETE, AND THE OMISSION IS THE DECISION.
--
-- The lead policy is `for all`, so this looks inconsistent beside it. It is
-- deliberate. P7-19's closing note is the reason: "LISTS AND FOLDERS ARE STILL
-- ARCHIVED, NOT DELETED (`is_active`)" — a list holds tasks, `tasks.list_id` is
-- `on delete set null`, and deleting one quietly unfiles every task in it,
-- which looks like data loss to whoever owned them. Amier asked for "create,
-- rename and archive". Archive is `update ... set is_active = false`, which
-- this grants. Hard delete is not on the list and is not granted.
--
-- The reserved "Client Requests" folder stays untouchable by anybody:
-- `vizserve_pms_task_groups_system_guard` refuses rename, move, archive,
-- reflag and delete on it, and a trigger does not care which policy let the
-- statement through.
-- ---------------------------------------------------------------------------
drop policy if exists "task groups creatable by department admin" on vizserve_pms_task_groups;
create policy "task groups creatable by department admin"
  on vizserve_pms_task_groups for insert to authenticated
  with check (vizserve_pms_is_dept_admin(department_id));

-- ⚠️ BOTH `using` AND `with check`, AND THEY ARE NOT THE SAME QUESTION. `using`
-- decides which rows may be opened; `with check` decides what they may become.
-- With only `using`, a department admin could move a folder INTO another
-- department by rewriting `department_id` — the row they opened was theirs, and
-- nothing would test the row they wrote. (`saveTaskGroup` never sends that
-- column and the guard trigger has its own reasons to refuse, but the front end
-- will be bypassed — CLAUDE.md.)
drop policy if exists "task groups editable by department admin" on vizserve_pms_task_groups;
create policy "task groups editable by department admin"
  on vizserve_pms_task_groups for update to authenticated
  using (vizserve_pms_is_dept_admin(department_id))
  with check (vizserve_pms_is_dept_admin(department_id));


-- ---------------------------------------------------------------------------
-- 2. LISTS — vizserve_pms_lists.
--
-- The same shape as folders above, for the same reasons, on the sibling level.
-- `lists readable in department` (p3_01) already covers SELECT through the
-- inline "my primary department" test it carries.
--
-- No DELETE, exactly as above — and here the consequence is the concrete one
-- P7-19 named: `vizserve_pms_tasks.list_id` is `on delete set null`, so
-- deleting a list silently unfiles every task in it.
--
-- `vizserve_pms_lists_group_guard` still runs on every insert and update, so a
-- department admin cannot put a list in another department's folder, cannot
-- drag a form's inbox list out of Client Requests, and cannot drop an ordinary
-- list into it. Those three rules are trigger-enforced and policy-independent.
-- ---------------------------------------------------------------------------
drop policy if exists "lists creatable by department admin" on vizserve_pms_lists;
create policy "lists creatable by department admin"
  on vizserve_pms_lists for insert to authenticated
  with check (vizserve_pms_is_dept_admin(department_id));

drop policy if exists "lists editable by department admin" on vizserve_pms_lists;
create policy "lists editable by department admin"
  on vizserve_pms_lists for update to authenticated
  using (vizserve_pms_is_dept_admin(department_id))
  with check (vizserve_pms_is_dept_admin(department_id));


-- ---------------------------------------------------------------------------
-- 3. FORMS — vizserve_pms_forms and vizserve_pms_form_fields.
--
-- ⚠️ CLIENT FORMS ONLY. `purpose <> 'INTERNAL'` IS ON EVERY POLICY IN THIS
-- SECTION AND IS THE MOST IMPORTANT LINE IN IT.
--
-- 20260902140000 (P7-66 Phase 5) narrowed the INTERNAL kind to
-- `vizserve_pms_is_admin()` — which after p8_01b means OWNER — on five
-- policies at once, and its own comment explains why: an internal form is a
-- company-wide instrument that reads the whole staff roster and every
-- department's answers. Its audience can be the entire company. A tick scoped
-- to one department has no business creating one, and "create an internal form
-- addressed to everybody" would be the tick reaching outside its department
-- through the one door that is not shaped like a department.
--
-- ⚠️ AND IT IS TESTED ON BOTH SIDES OF THE UPDATE, which is what closes the
-- conversion loophole. Without `purpose <> 'INTERNAL'` in the `with check`, a
-- department admin could take a client form they legitimately own and UPDATE IT
-- INTO an internal one, arriving at exactly the row the insert policy refused
-- them. The existing `forms updatable in scope` policy already refuses that
-- combination too — its `with check` demands `vizserve_pms_is_admin()` for an
-- INTERNAL row — but policies are OR-ed, so a permissive policy that allowed it
-- would be the whole gate.
--
-- SELECT IS GRANTED HERE and is not redundant. `forms readable in scope` is
-- `vizserve_pms_manages_department(department_id)`, which a member holding the
-- tick fails; the audience policy from 20260902140000 only ever shows INTERNAL
-- forms. Without this, a department admin's /forms would be empty and the
-- builder would 404 on their own department's forms.
--
-- ⚠️ AND THE SELECT POLICY CARRIES THE SAME GUARD. Leaving it off would have
-- been easy to justify — a department admin already reads published internal
-- forms addressed to them through the audience policy — and would have been a
-- real widening all the same: it would hand them their department's UNPUBLISHED
-- internal forms, schema and all, which is the draft of a survey they are the
-- subject of. The audience policy is OR-ed in beside this one and still shows
-- them every internal form they may actually answer, so nothing is lost.
-- ---------------------------------------------------------------------------
drop policy if exists "forms readable by department admin" on vizserve_pms_forms;
create policy "forms readable by department admin"
  on vizserve_pms_forms for select to authenticated
  using (
    purpose <> 'INTERNAL'
    and vizserve_pms_is_dept_admin(department_id)
  );

-- ⚠️ NO UNROUTED-DRAFT BRANCH, unlike `forms insertable by team leaders`, which
-- allows `department_id is null`. A draft with no department belongs to nobody's
-- department yet, so `vizserve_pms_is_dept_admin(null)` is false for everyone
-- but an owner — correct, and the reason `createForm` refuses a department-less
-- form for a tick-holder with a sentence instead of letting Postgres answer
-- with `new row violates row-level security policy`.
drop policy if exists "forms creatable by department admin" on vizserve_pms_forms;
create policy "forms creatable by department admin"
  on vizserve_pms_forms for insert to authenticated
  with check (
    purpose <> 'INTERNAL'
    and vizserve_pms_is_dept_admin(department_id)
  );

drop policy if exists "forms editable by department admin" on vizserve_pms_forms;
create policy "forms editable by department admin"
  on vizserve_pms_forms for update to authenticated
  using (
    purpose <> 'INTERNAL'
    and vizserve_pms_is_dept_admin(department_id)
  )
  with check (
    purpose <> 'INTERNAL'
    and vizserve_pms_is_dept_admin(department_id)
  );

-- ⚠️ WITHOUT THIS, THE THREE POLICIES ABOVE ARE DECORATIVE — the same warning
-- 20260902140000 wrote over its own A.3. `vizserve_pms_save_form_schema` is
-- SECURITY INVOKER and writes `vizserve_pms_form_fields` DIRECTLY, so a
-- department admin who can open the form row would still be refused on every
-- question in the builder, and the form row itself would never be touched.
--
-- `for all`, not insert/update, and here the DELETE is required rather than
-- withheld: `vizserve_pms_save_form_schema` deletes field rows it can prove
-- carry no answers (p7_66_form_schema:540). The no-hard-delete rule for fields
-- that HAVE submissions is a trigger and a constraint (R5, `field_key`
-- immutability), not this policy, so granting delete here takes nothing away
-- from that guarantee.
--
-- The `purpose <> 'INTERNAL'` test rides on the PARENT FORM, which is where
-- purpose lives — a field has no purpose of its own.
drop policy if exists "form fields editable by department admin" on vizserve_pms_form_fields;
create policy "form fields editable by department admin"
  on vizserve_pms_form_fields for all to authenticated
  using (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and f.purpose <> 'INTERNAL'
         and vizserve_pms_is_dept_admin(f.department_id)
    )
  )
  with check (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and f.purpose <> 'INTERNAL'
         and vizserve_pms_is_dept_admin(f.department_id)
    )
  );

-- ⚠️ `forms deletable by admin` IS NOT WIDENED, and that is not an oversight.
-- Deleting a form cascades to its inbox list (`lists.form_id` is
-- `on delete cascade`, p7_18) and orphans every request that came through it.
-- Amier asked for "archive", which is `is_active = false` and is an UPDATE the
-- policy above already grants. Hard delete stays with the owner.


-- ---------------------------------------------------------------------------
-- 4. DELETING AN INTERNAL TASK — vizserve_pms_can_delete_task.
--
-- ⚠️ NOT A POLICY. There is NO delete policy on `vizserve_pms_tasks` at all and
-- there must not be one: P7-19's closing note says adding one "would create a
-- second route that skips the audit log and the request_id guard".
-- `vizserve_pms_delete_task` is the only door, and this is the guard inside it.
--
-- Recreated whole with ONE branch added. Everything else is byte-identical to
-- 20260819140000_p7_19_delete_internal_task.sql:57-72, and the three existing
-- ways in are preserved verbatim:
--
--   * a lead of the task's department  — they own the shape of their board
--   * whoever created it               — a member must be able to undo P7-14
--   * the owner of a personal task     — it is their own private list
--
-- ⚠️ `t.request_id is null` STAYS, AND IS THE MOST LOAD-BEARING LINE HERE.
-- P7-19 restricted this function to internal work "precisely so the client-side
-- cascades can never fire": `vizserve_pms_client_decisions`,
-- `vizserve_pms_approval_tokens` and `vizserve_pms_feedback` all cascade from
-- the task and all three exist only on request-backed work. A department admin
-- gets exactly the same restriction as everybody else — the tick widens WHO,
-- never WHAT.
--
-- ⚠️ THE AUDIT ROW IS UNAFFECTED AND STILL WRITTEN.
-- `vizserve_pms_delete_task` calls `vizserve_pms_write_audit_log` before the
-- row goes, with the impact counts, and this file does not touch that function.
-- The error sentences in `vizserve_pms_delete_task` and
-- `vizserve_pms_task_delete_impact` still say "Only a team leader of this
-- department, or whoever created the task" — slightly stale now, and left
-- alone on purpose: recreating two more functions to reword a refusal that a
-- department admin will never see is blast radius bought for nothing.
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
         -- P8-01c. The department-admin tick. Beside the lead test rather than
         -- inside it: `vizserve_pms_manages_department` grants APPROVAL
         -- authority and is deliberately never widened (p8_01b §7).
         or vizserve_pms_is_dept_admin(t.department_id)
         or t.created_by = auth.uid()
         or (t.is_personal and t.assignee_id = auth.uid())
       )
  );
$$;

comment on function vizserve_pms_can_delete_task(uuid) is
  'P7-19, widened by P8-01c. Whether the caller may delete this task. Internal '
  'work only — a request-backed task is never deletable, by anybody. True for a '
  'lead of the department, a DEPARTMENT ADMIN of it, whoever created it, or the '
  'owner of a personal task.';


-- ---------------------------------------------------------------------------
-- 5. FORCING A STUCK TASK'S STATUS — vizserve_pms_force_task_status.
--
-- ⚠️ ALSO NOT A POLICY. SECURITY DEFINER with its own guard, and the guard is
-- the only thing that changes. Recreated whole from
-- 20260803130000_p3_tasks_qa.sql:337-388 with `for update`, the mandatory
-- reason, the same-status refusal, the `is_override` history row and the audit
-- write ALL preserved exactly.
--
-- Q5's own reasoning is why this belongs to the tick at all: "real systems need
-- someone able to unstick a ticket: a PIC leaves, a task sits in
-- QA_IN_PROGRESS for a fortnight". That is data hygiene on the department's own
-- board, which is what the tick is for.
--
-- ⚠️ NO `request_id is null` RESTRICTION HERE, and the asymmetry with section 4
-- is deliberate rather than an inconsistency. Deleting destroys; forcing moves.
-- A client-backed task that is stuck is the case people actually hit, and this
-- function only writes a status, a history row and an audit row — it fires none
-- of the client-facing side effects (`vizserve_pms_transition_task` is what
-- notifies and emails, and it is untouched). Narrowing the tick to internal
-- work here would leave the department admin unable to unstick the queue the
-- department is judged on.
--
-- ⚠️ THE REASON STAYS MANDATORY. "An unexplained override is the thing that
-- makes the whole history untrustworthy rather than just this one row" — and it
-- matters MORE for a new class of caller, not less: `is_override` plus the
-- reason is the only record that the tick was used.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_force_task_status(
  p_task_id   uuid,
  p_to_status vizserve_pms_task_status,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task   vizserve_pms_tasks;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- P8-01c — THE ONE CHANGED LINE. `or` rather than a rewrite of
  -- `vizserve_pms_manages_department`: that function grants approval authority
  -- and stays untouched (p8_01b §7). A department admin unsticks their own
  -- department's board and approves nothing.
  if not (
    vizserve_pms_manages_department(v_task.department_id)
    or vizserve_pms_is_dept_admin(v_task.department_id)
  ) then
    raise exception 'Only a team leader or department admin for this department can override a status.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Not optional, and not defaulted. An unexplained override is the thing that
  -- makes the whole history untrustworthy rather than just this one row.
  if v_reason is null then
    raise exception 'An override needs a reason.' using errcode = 'check_violation';
  end if;

  if v_task.status = p_to_status then
    raise exception 'That task is already %.', p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  update vizserve_pms_tasks set status = p_to_status where id = p_task_id;

  insert into vizserve_pms_task_status_history
    (task_id, from_status, to_status, actor_id, comment, is_override)
  values
    (p_task_id, v_task.status, p_to_status, auth.uid(), v_reason, true);

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'status_overridden', auth.uid(),
    jsonb_build_object('status', v_task.status),
    jsonb_build_object('status', p_to_status, 'reason', v_reason)
  );

  return jsonb_build_object('ok', true, 'status', p_to_status);
end;
$$;

comment on function vizserve_pms_force_task_status(uuid, vizserve_pms_task_status, text) is
  'Q5, widened by P8-01c. Forces a status past the machine, always with a reason, '
  'always recorded as is_override and always audited. Team leader of the '
  'department, or its DEPARTMENT ADMIN. Confers no approval rights: '
  'vizserve_pms_manages_department is untouched.';

-- The grant from p3 still stands (`to authenticated`) and `create or replace`
-- preserves it. Restating it would be harmless and would also suggest it had
-- been lost, which is a different bug from anything in this file.


-- ---------------------------------------------------------------------------
-- 6. ⚠️ THE AUDIT TRAIL — DELIBERATELY NOT IMPLEMENTED. READ THIS BEFORE
--    "FIXING" IT.
--
-- Amier's third power was "read audit rows for their own department's records".
-- IT IS NOT GRANTED HERE, and this section is the reason, written down so the
-- next person does not spend the same afternoon arriving at the same answer.
--
-- ⚠️ `vizserve_pms_audit_logs` HAS NO DEPARTMENT COLUMN. The table is
-- (entity_type, entity_id, action, actor_id, before, after, created_at) —
-- p0_09:7-18. `entity_type` is FREE TEXT and today carries nine values:
-- user, request, internal_request, task, dtr_entry, timesheet_week, holiday,
-- event, app_settings (lib/audit.ts). There is no column to compare against
-- `primary_department_id`, so "their department's audit rows" cannot be
-- expressed as a policy at all without joining `entity_id` to a DIFFERENT table
-- per `entity_type`.
--
-- THE THREE WAYS TO DO IT ANYWAY, AND WHY EACH IS WORSE THAN NOTHING:
--
--   (a) A `case entity_type` policy joining nine tables. Four of the nine have
--       no department even indirectly — `holiday`, `event`, `app_settings` are
--       company-wide, and `user` is a staff record the tick is explicitly
--       barred from. Two more reach a department only through the acting
--       person (`dtr_entry`, `timesheet_week`), which makes "my department's
--       audit rows" mean "my colleagues' attendance history" — a reading
--       nobody asked for and one that hands a member their team's punch record.
--       The join also runs per row on an append-only table that is never
--       pruned.
--
--   (b) Scope to `entity_type = 'task'` alone, joining
--       `vizserve_pms_tasks.department_id`. Tempting, narrow, and it BREAKS ON
--       THE EXACT ROWS THIS PHASE CREATES: `vizserve_pms_delete_task` writes
--       its audit row and then deletes the task, so the join finds nothing and
--       the deletion is INVISIBLE. The one power that most needs a trail —
--       a department admin hard-deleting internal work — is the one the trail
--       would hide. A record of every deletion except the deletions.
--
--   (c) Add `department_id` to the table and populate it going forward. The
--       write helper has ~54 call sites across 19 migration files, none of
--       which passes a department; every historical row would be null, so the
--       screen would open on an empty trail that looks like a bug and reads as
--       "nothing has ever happened here". A backfill would be guesswork for
--       (b)'s reason — the rows whose subject no longer exists are exactly the
--       ones that cannot be backfilled.
--
-- SO: NOTHING. `audit logs readable by admin` (p0_06:78-80) stands unchanged at
-- `vizserve_pms_is_admin()`, and `/admin/audit` stays `requireRole("owner")`.
--
-- ⚠️ A WRONG AUDIT SCOPE IS WORSE THAN NONE. It fails in one of two directions
-- and both are silent: it leaks another department's history, or it hides rows
-- and the trail looks empty — and a trail that looks empty is one people stop
-- opening, which costs more than never having offered it.
--
-- WHAT THE DEPARTMENT ADMIN STILL SEES, so this is not a hole where a feature
-- was promised: `vizserve_pms_task_status_history` carries every move including
-- the forced ones, with the actor and the reason, and it is already readable to
-- the department on `/tasks/[id]`. That is the history of the two powers this
-- migration grants, in the place people actually look for it.
--
-- IF THIS IS EVER WANTED PROPERLY, it is (c) done deliberately: a
-- `department_id` argument threaded through `vizserve_pms_write_audit_log` at
-- every call site, a decision recorded about historical rows, and its own
-- migration. It is not a policy this file can honestly write.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 7. ⚠️ WHAT DELIBERATELY DOES NOT CHANGE. Verified after writing the above.
--
-- `vizserve_pms_manages_department`   — UNTOUCHED. Not named once outside the
--     two `or` branches in sections 4 and 5, which SIT BESIDE it and do not
--     modify it. This is the function /approvals, the leave policies and the
--     timesheet-week queues consult, so leaving it alone is what guarantees the
--     tick puts nobody into an approval queue. p8_01b §7 asked for this
--     explicitly and it holds.
--
-- `vizserve_pms_users`                — UNTOUCHED. No policy in this file names
--     it. A department admin cannot create, edit, deactivate or reset anybody,
--     and cannot grant Admin, HR or Owner. That is the line that stops the tick
--     escalating itself, and it is why /admin/users stays `requireRole("owner")`.
--
-- `vizserve_pms_is_admin` / `_is_hr`  — UNTOUCHED. Company-wide capabilities.
--
-- `vizserve_pms_app_settings`, `vizserve_pms_leave_types`,
-- `vizserve_pms_holidays`, `vizserve_pms_events` — UNTOUCHED. Company-wide by
--     definition: no department column to scope against, which is the tell.
--
-- `vizserve_pms_transition_task`      — UNTOUCHED. The ORDINARY status path,
--     which already asks who is on the task rather than who leads it. Section 5
--     widens the OVERRIDE only.
--
-- `vizserve_pms_approve_request`, `vizserve_pms_form_responses`,
-- `vizserve_pms_delete_task` itself   — UNTOUCHED. Gate 1 approval, internal
--     form answers, and the delete transaction (only its guard predicate moved).
--
-- No GRANTs are needed. Every table here already grants `authenticated` through
-- `alter default privileges` (p0_06_grants), and both functions keep the grants
-- `create or replace` preserves. If a `permission denied for table` appears
-- after this paste it is the default privileges, not this file.
-- ---------------------------------------------------------------------------
