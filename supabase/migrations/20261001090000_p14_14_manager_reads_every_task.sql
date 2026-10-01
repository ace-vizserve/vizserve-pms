-- P14-14 — THE MANAGER READS EVERY DEPARTMENT'S TASKS (1 Oct 2026).
--
-- P14-04 made the Manager department-unscoped: `vizserve_pms_manages_department`
-- answers true for `current_role() = 'manager'` on every department, so the
-- Manager may update, transition, delete and log time on any department's
-- tasks. But this policy never called that function — it inlines its own lead
-- test (`is_admin() or team_leader + managed`) — so the Manager could only SEE
-- their own department's tasks. Every action the database allowed elsewhere was
-- on a row they could not read.
--
-- The one change: `or current_role() = 'manager'` beside `is_admin()` in the
-- lead clause, so the personal-list exclusion still applies to the Manager
-- exactly as it does to every other lead. Everything else is P13-01's,
-- byte for byte.
--
-- ⚠️ APPLY BY HAND in the SQL editor, as `postgres`. Never `db:push`.

drop policy if exists "tasks readable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    assignee_id = (select auth.uid())
    or qa_assignee_id = (select auth.uid())
    or id in (select vizserve_pms_my_task_ids())
    or (
      (
        (select vizserve_pms_is_admin())
        -- P14-14. The Manager oversees every department (P14-04).
        or (select vizserve_pms_current_role()) = 'manager'
        or (
          (select vizserve_pms_has_role('team_leader'))
          and department_id in (select vizserve_pms_managed_department_ids())
        )
      )
      and (
        list_id is null
        or list_id not in (select vizserve_pms_personal_list_ids())
        or vizserve_pms_task_on_a_timesheet(id)
      )
    )
    or (
      department_id = (select vizserve_pms_my_department())
      and (
        (list_id is not null and list_id not in (select vizserve_pms_personal_list_ids()))
        or (list_id is null and not is_personal)
      )
    )
    or vizserve_pms_is_covering_task(id, (select auth.uid()))

    -- P13-01. The collaboration space, readable by everyone active. Hashed once
    -- per statement and false for every row outside it.
    or department_id in (select vizserve_pms_shared_department_ids())
  );

comment on policy "tasks readable by participants and department leads" on vizserve_pms_tasks is
  'P14-14, on P13-01. The Manager joins the lead clause (P14-04 made them '
  'department-unscoped). Every other clause is P13-01''s, unchanged. See '
  '20261001090000_p14_14_manager_reads_every_task.sql.';
