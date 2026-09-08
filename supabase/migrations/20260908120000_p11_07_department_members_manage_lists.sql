-- P11-07 — the project tree belongs to the department, not to its leads.
--
-- The last of the 7 Sep decision, extended to structure. P11-03 opened renaming
-- a list to any active member and left CREATING with the shapers, on the
-- reasoning that "a new list reshapes the tree for the whole department".
-- Reversed on 8 Sep: a list is a shelf, not a permission boundary, and needing a
-- Team Leader to make one is how people end up keeping their work somewhere
-- else. Folders go with it — a rule that stops one level up is a rule nobody can
-- remember.
--
-- Any active member of a department may now CREATE, RENAME, ARCHIVE and DELETE
-- that department's lists and folders. Leads and the Admin tick keep everything
-- they had.
--
-- ⚠️ TWO GUARDS DO THE REAL WORK HERE, AND NEITHER IS A POLICY.
--
--   * `vizserve_pms_lists_group_guard` runs on every insert and update: a list
--     cannot go into another department's folder, a form's inbox list cannot
--     leave Client Requests, and an ordinary list cannot be dropped into it.
--   * `vizserve_pms_task_groups_system_guard` refuses to rename, archive,
--     delete or reflag the reserved Client Requests folder, and raises
--     `check_violation` with a sentence written for a person.
--
-- Both are trigger-enforced and policy-independent, so widening WHO may press
-- the button cannot produce a tree that was previously impossible.
--
-- ⚠️ DELETING A LIST STILL UNFILES ITS TASKS, SILENTLY. `vizserve_pms_tasks.list_id`
-- is `on delete set null` (P7-19), so the tasks survive and their filing does
-- not. That was the argument for keeping delete with leads; it lost, and it is
-- written down here because nothing on screen says it at the moment somebody
-- presses Delete. If this bites, the fix is a confirmation that counts the
-- tasks, not a narrower policy.
--
-- AUDIT: `vizserve_pms_audit_row_update` already covers list UPDATEs (P11-03,
-- entity_type 'list'). Inserts and deletes are NOT audited on either table —
-- that gap predates this file and applies equally to a lead doing the same
-- thing, so it is not something this change introduces. Worth closing next.


-- ---------------------------------------------------------------------------
-- The member predicate, spelled out per policy rather than extracted.
--
-- A `security definer` helper would be the tidier shape, but it would be the
-- fifth function answering "is this person in that department" — and
-- `may_log_time` is the standing lesson about what happens when the same
-- question has several definitions in several files. The predicate below is the
-- same one P11-03 used for renaming and `vizserve_pms_create_task` uses for
-- filing work: `primary_department_id`, which is what this schema means by "a
-- member of a department" everywhere else.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. LISTS.
--
-- The p3 policy "lists writable by department leads" is `for all` and stays,
-- so a lead keeps insert, update and delete through it. UPDATE already admits
-- the member (P11-03) and is untouched here.
-- ---------------------------------------------------------------------------
drop policy if exists "lists creatable by department admin" on vizserve_pms_lists;
drop policy if exists "lists creatable by the department" on vizserve_pms_lists;

create policy "lists creatable by the department"
  on vizserve_pms_lists for insert to authenticated
  with check (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_lists.department_id
    )
  );

-- No DELETE policy existed on this table at all — deleting was reachable only
-- through the lead's `for all`. This is the first one.
drop policy if exists "lists deletable by the department" on vizserve_pms_lists;

create policy "lists deletable by the department"
  on vizserve_pms_lists for delete to authenticated
  using (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_lists.department_id
    )
  );


-- ---------------------------------------------------------------------------
-- 2. FOLDERS.
--
-- Same three actions, same predicate. `task groups writable by department
-- leads` is `for all` and stays.
--
-- ⚠️ `with check` AS WELL AS `using` ON THE UPDATE, and they are not the same
-- question — P8-01c's note, still true. `using` decides which rows may be
-- opened; `with check` decides what they may become. With only `using`, a
-- member could move a folder INTO another department by rewriting
-- `department_id`: the row they opened would be theirs, and nothing would test
-- the row they wrote.
-- ---------------------------------------------------------------------------
drop policy if exists "task groups creatable by department admin" on vizserve_pms_task_groups;
drop policy if exists "task groups creatable by the department" on vizserve_pms_task_groups;

create policy "task groups creatable by the department"
  on vizserve_pms_task_groups for insert to authenticated
  with check (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_task_groups.department_id
    )
  );

drop policy if exists "task groups editable by department admin" on vizserve_pms_task_groups;
drop policy if exists "task groups editable by the department" on vizserve_pms_task_groups;

create policy "task groups editable by the department"
  on vizserve_pms_task_groups for update to authenticated
  using (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_task_groups.department_id
    )
  )
  with check (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_task_groups.department_id
    )
  );

drop policy if exists "task groups deletable by the department" on vizserve_pms_task_groups;

create policy "task groups deletable by the department"
  on vizserve_pms_task_groups for delete to authenticated
  using (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_task_groups.department_id
    )
  );
