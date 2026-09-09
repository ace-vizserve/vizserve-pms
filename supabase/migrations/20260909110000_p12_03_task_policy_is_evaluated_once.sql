-- ---------------------------------------------------------------------------
-- P12-03 — the task SELECT policy stops running once per row.
--
-- ⚠️ THIS CHANGES HOW THE POLICY IS EVALUATED. IT DOES NOT CHANGE WHO CAN SEE
-- WHAT. Every clause below is the same clause, in the same order, admitting the
-- same rows. If you are reviewing this and cannot convince yourself of that for
-- a given line, STOP — a silent widening here hands one department's work to
-- another, and the failure mode is that everything looks fine.
--
-- THE BUG. Amier's sidebar reported "Couldn't load your lists" and the browser
-- console said `canceling statement due to statement timeout` (57014). The
-- function it calls, `vizserve_pms_sidebar_snapshot()`, runs in 171ms with RLS
-- bypassed and does not finish inside 8s with RLS applied, over 3,926 tasks.
--
-- The policy is why. Every helper it calls is `stable` AND `security definer`,
-- and A SECURITY DEFINER FUNCTION CANNOT BE INLINED BY THE PLANNER — Postgres
-- calls it as a black box, once per row. So one sequential scan of
-- `vizserve_pms_tasks` was:
--
--   auth.uid()                        x3 per row
--   vizserve_pms_is_on_task(...)      1 per row, and it re-queries tasks
--   vizserve_pms_manages_department() 1 per row, which itself fans out to
--       vizserve_pms_is_admin()               -- a users lookup
--       vizserve_pms_has_role('team_leader')  -- another users lookup
--       vizserve_pms_managed_department_ids() -- another query
--   vizserve_pms_my_department()      1 per row, another users lookup
--
-- Roughly twenty thousand function invocations to answer "how many open tasks
-- are in each list". None of the session-dependent ones can change between rows.
--
-- ⚠️ AND THIS IS NOT A NEW FAULT. The nine queries the snapshot replaced ran
-- against this same policy and timed out the same way — `sidebar-panel.tsx`
-- ended every read in `?? []`, so a 57014 rendered as "zero open tasks" and a
-- refresh appeared to fix it. That is the bug Amier originally reported, and it
-- has been mis-attributed to a request burst since. P12-01 did not cause it; it
-- stopped hiding it.
--
-- THE FIX, and the whole of it: wrap every SESSION-CONSTANT subexpression in a
-- scalar subquery. `(select f())` is evaluated once as an InitPlan and the
-- result reused for every row; `f()` is evaluated per row. This is the standard
-- Supabase RLS remedy and it changes nothing about the value computed.
-- ---------------------------------------------------------------------------

drop policy if exists "tasks readable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    -- The owner of a personal task reaches it HERE, which is why nothing below
    -- can lock somebody out of their own list. `(select auth.uid())` rather than
    -- `auth.uid()`: one InitPlan instead of one call per row. Same value.
    assignee_id = (select auth.uid())
    or qa_assignee_id = (select auth.uid())

    /*
     * P7-13. A second assignee cannot see the task at all without this.
     *
     * ⚠️ THIS WAS `vizserve_pms_is_on_task(id, auth.uid())` AND THE REWRITE IS
     * EXACT. That function is:
     *
     *   exists (select 1 from vizserve_pms_tasks t
     *            where t.id = p_task_id
     *              and (t.assignee_id = p_user_id or t.qa_assignee_id = p_user_id))
     *   or exists (select 1 from vizserve_pms_task_assignees a
     *               where a.task_id = p_task_id and a.user_id = p_user_id)
     *
     * Its FIRST half looks up the row being tested, by id, and compares the two
     * columns the two clauses immediately above already compare directly. It is
     * redundant *inside this policy* — same row, same columns, same value — and
     * it was costing a second scan of `vizserve_pms_tasks` per row to learn what
     * the row in hand already said. Only the second half adds anything, and it
     * is written here as a set membership so the planner builds ONE hashed
     * subplan instead of calling a definer function 3,926 times.
     *
     * ⚠️ THE FUNCTION ITSELF IS NOT CHANGED AND MUST NOT BE. It has other
     * callers (`vizserve_pms_task_comments`, the attachment policies) where the
     * first half is NOT redundant because there is no task row in scope. This
     * is a local simplification, justified by its local context.
     */
    or id in (
      select a.task_id
        from vizserve_pms_task_assignees a
       where a.user_id = (select auth.uid())
    )

    /*
     * ⚠️ THE LEAD'S CLAUSE — the P11-07 / P11-08 history is in
     * `20260908110000_p11_08_privacy_belongs_to_the_list.sql` and none of it is
     * revisited here. The test is still the list the task is filed in, not the
     * `is_personal` flag.
     *
     * `vizserve_pms_manages_department(department_id)` is expanded to its own
     * body — verbatim, from `p0_05_authorization_functions.sql`:
     *
     *   vizserve_pms_is_admin()
     *   or (vizserve_pms_has_role('team_leader')
     *       and target_department_id in (select vizserve_pms_managed_department_ids()))
     *
     * The expansion is what lets the two session-constant halves hoist. The
     * only row-dependent part, `department_id in (...)`, stays row-dependent —
     * but the set it tests against is now built once.
     *
     * ⚠️ THE ORDER OF EACH `or` IS STILL THE COST CONTROL, and Postgres still
     * short-circuits left to right. `list_id is null` is free;
     * `vizserve_pms_list_is_personal` is one primary-key lookup on a small table
     * and answers false for every ordinary list, so
     * `vizserve_pms_task_on_a_timesheet` — the only one that touches the entries
     * table — runs solely for a task that really is in somebody's private list.
     * Reversing either pair would put a subquery against the timesheet on every
     * task on every board in the company. Those two stay as function calls
     * because they are genuinely row-dependent and are already guarded to
     * almost never run.
     */
    or (
      (
        (select vizserve_pms_is_admin())
        or (
          (select vizserve_pms_has_role('team_leader'))
          and department_id in (select vizserve_pms_managed_department_ids())
        )
      )
      and (
        list_id is null
        or not vizserve_pms_list_is_personal(list_id)
        or vizserve_pms_task_on_a_timesheet(id)
      )
    )

    /*
     * P7-17's peer clause, VERBATIM AND DELIBERATELY NOT "CORRECTED" TO MATCH
     * THE ONE ABOVE. It carries `not is_personal`, and that is a different
     * decision made on 19 Aug, not the same mistake: a colleague sees the
     * department's SHARED work and not what somebody recorded for themselves.
     * Rewriting it would hand every member of a department twelve extra tasks a
     * week they have never been able to see. If that rule should change it is
     * its own decision, on its own evidence.
     *
     * `vizserve_pms_my_department()` takes no arguments and reads the caller's
     * own row, so it is session-constant and hoists. It was one users lookup per
     * task.
     */
    or (not is_personal and department_id = (select vizserve_pms_my_department()))
  );

comment on policy "tasks readable by participants and department leads" on vizserve_pms_tasks is
  'P12-03. Identical in effect to the P11-08 version; every session-constant '
  'subexpression is wrapped in a scalar subquery so it is evaluated once per '
  'statement rather than once per row. See the migration header for the timeout '
  'this fixes.';

-- ---------------------------------------------------------------------------
-- The index the open-task count actually wants.
--
-- `vizserve_pms_sidebar_snapshot()` counts live work per list:
--   where list_id is not null and status not in ('COMPLETED','COMPLETED_NO_RESPONSE')
--
-- The existing `(list_id)` index has to visit every row to test the status.
-- A partial index stores only the rows that can ever be counted, so the count
-- reads a fraction of the table and the completed backlog stops being paid for
-- on every page load. It shrinks over time relative to the table, which is the
-- right direction for a number that is displayed on every screen.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the transaction
-- the SQL editor wraps this in, and this table is small enough that the brief
-- lock is not worth the ceremony.
-- ---------------------------------------------------------------------------

create index if not exists vizserve_pms_tasks_open_by_list_idx
  on vizserve_pms_tasks (list_id)
  where status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE');

comment on index vizserve_pms_tasks_open_by_list_idx is
  'P12-03. Serves the per-list open-task count in vizserve_pms_sidebar_snapshot(). '
  'Partial, so the completed backlog is not scanned to produce a number about live work.';

analyze vizserve_pms_tasks;
