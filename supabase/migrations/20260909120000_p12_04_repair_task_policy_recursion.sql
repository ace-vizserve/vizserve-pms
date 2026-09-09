-- ---------------------------------------------------------------------------
-- P12-04 — REPAIR. Apply this immediately; P12-03 broke every task read.
--
-- ⚠️ WHAT P12-03 DID WRONG, so nobody repeats it.
--
-- It replaced `vizserve_pms_is_on_task(id, auth.uid())` in the tasks SELECT
-- policy with a bare subquery:
--
--     id in (select a.task_id from vizserve_pms_task_assignees a
--             where a.user_id = (select auth.uid()))
--
-- A policy expression is evaluated AS THE QUERYING ROLE, so that subquery is
-- itself subject to RLS on `vizserve_pms_task_assignees`. That table's SELECT
-- policy (p7_13) reads `vizserve_pms_tasks` back:
--
--     tasks policy -> task_assignees policy -> tasks policy -> ...
--
-- Postgres detects the cycle and raises `42P17: infinite recursion detected in
-- policy for relation "vizserve_pms_tasks"`. It is a rewrite-time error, so it
-- fires for EVERY caller on EVERY row regardless of data: the board, the list,
-- the task detail page, and `vizserve_pms_sidebar_snapshot()`.
--
-- ⚠️ `vizserve_pms_is_on_task` BEING `SECURITY DEFINER` IS WHAT BREAKS THAT
-- LOOP. It was not incidental and it is not a style choice. A definer function
-- does not re-enter RLS, so the join table's policy never runs.
-- `20260905095000_p9_06_is_mine_cost.sql` records the same trap one step away:
-- "vizserve_pms_task_assignees has its own policy, and that policy calls
-- vizserve_pms_is_on_task — so an invoker-rights function reading that table
-- would evaluate the join table's RLS once per row." P12-03 did it from inside
-- the policy itself.
--
-- ⚠️ AND IT DROPPED A BRANCH. P12-03's header quoted a two-clause
-- `vizserve_pms_is_on_task`, which has been stale since
-- `20260905090000_p9_01_relievers.sql` did a `create or replace` adding a third:
--
--     or vizserve_pms_is_covering_task(p_task_id, p_user_id)
--
-- A reliever covering somebody's tasks reached them through that clause. It is
-- restored below as its own disjunct. (P11-11 also created a SECOND, separately
-- named policy, "tasks readable by a reliever covering them", which is WIDER
-- than this branch and would have masked the loss — so the hole would not have
-- shown up in testing, and would have opened the day anybody tightened that
-- policy to match its own stated intent. Do not rely on that overlap.)
--
-- WHAT SURVIVES FROM P12-03: the whole point of it. Every session-constant
-- subexpression is still hoisted into a scalar subquery so it is evaluated once
-- per statement instead of once per row -- that is the fix for the 57014
-- statement timeout on 3,926 tasks. Only the mechanism for the assignee test
-- changes: a SECURITY DEFINER set-returning helper, which is uncorrelated (one
-- hashed SubPlan per statement, the same win) and does not re-enter RLS.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The caller's own task ids, as a set.
--
-- ⚠️ `SECURITY DEFINER` IS LOAD-BEARING — see the header. Invoker rights here
-- puts the join table's policy back in the loop and the recursion returns.
--
-- Safe by the same argument `p9_06` makes for `vizserve_pms_is_mine`: it is
-- parameterless and filters on `auth.uid()` itself, so it can only ever return
-- rows ABOUT THE CALLER. It cannot be pointed at somebody else.
--
-- `setof uuid` rather than an array so `id in (select ...)` stays the same
-- construct the policy used before, uncorrelated and hashable.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_my_task_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select a.task_id
    from vizserve_pms_task_assignees a
   where a.user_id = auth.uid();
$$;

revoke all on function vizserve_pms_my_task_ids() from public, anon;
grant execute on function vizserve_pms_my_task_ids() to authenticated;

comment on function vizserve_pms_my_task_ids() is
  'P12-04. The caller''s own second-assignee task ids. SECURITY DEFINER so a '
  'policy on vizserve_pms_tasks can test membership without re-entering RLS on '
  'vizserve_pms_task_assignees, whose own policy reads tasks back -- the 42P17 '
  'recursion P12-03 introduced. Parameterless and filtered on auth.uid(), so it '
  'can only ever return rows about the caller.';

-- ---------------------------------------------------------------------------
-- The policy, correct this time.
--
-- Same rows as the P11-08 version. Same clauses, same order, plus the reliever
-- branch P12-03 dropped, restored explicitly.
-- ---------------------------------------------------------------------------
drop policy if exists "tasks readable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    -- The owner of a personal task reaches it HERE, which is why nothing below
    -- can lock somebody out of their own list.
    assignee_id = (select auth.uid())
    or qa_assignee_id = (select auth.uid())

    -- P7-13. A second assignee cannot see the task at all without this.
    -- Uncorrelated, so it is one hashed SubPlan per statement rather than a
    -- definer call per row -- and definer inside, so no RLS cycle.
    or id in (select vizserve_pms_my_task_ids())

    /*
     * ⚠️ THE LEAD'S CLAUSE. The P11-07 / P11-08 history is in
     * `20260908110000_p11_08_privacy_belongs_to_the_list.sql` and none of it is
     * revisited here: the test is still the list the task is filed in, never
     * the `is_personal` flag.
     *
     * `vizserve_pms_manages_department(department_id)` is expanded to its own
     * body, verbatim from `p0_05_authorization_functions.sql`, so that its two
     * session-constant halves can hoist. `is_admin()` and `has_role()` are
     * CALLED, not themselves expanded -- P8-01b re-pointed `is_admin()` at
     * `has_role('owner')` and expanding it would freeze that decision here.
     *
     * ⚠️ THE ORDER OF EACH `or` IS STILL THE COST CONTROL, and Postgres still
     * short-circuits left to right. `list_id is null` is free;
     * `vizserve_pms_list_is_personal` is one primary-key lookup on a small table
     * and answers false for every ordinary list, so
     * `vizserve_pms_task_on_a_timesheet` -- the only one touching the entries
     * table -- runs solely for a task genuinely in somebody's private list.
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
     * If that rule should change it is its own decision, on its own evidence.
     */
    or (not is_personal and department_id = (select vizserve_pms_my_department()))

    /*
     * P9-01's reliever branch, RESTORED. It lived inside
     * `vizserve_pms_is_on_task`, which P12-03 stopped calling while quoting a
     * body that predated it.
     *
     * Left as a per-row definer call rather than turned into another id set:
     * it is the LAST disjunct, so it only runs for a row nothing above admitted,
     * and inventing a second helper under time pressure is how the next repair
     * gets written. Definer, so no RLS cycle. If it ever shows up in a plan,
     * `vizserve_pms_my_covered_task_ids()` is the same treatment as above.
     */
    or vizserve_pms_is_covering_task(id, (select auth.uid()))
  );

comment on policy "tasks readable by participants and department leads" on vizserve_pms_tasks is
  'P12-04. Identical in effect to the P11-08 policy plus P9-01''s reliever '
  'branch. Session-constant subexpressions are wrapped in scalar subqueries so '
  'they are evaluated once per statement, not once per row -- the 57014 timeout '
  'fix. The assignee test goes through vizserve_pms_my_task_ids() because a bare '
  'read of the join table from here recurses (42P17). See the migration header.';
