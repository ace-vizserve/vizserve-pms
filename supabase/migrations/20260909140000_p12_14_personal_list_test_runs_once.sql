-- ---------------------------------------------------------------------------
-- P12-14 — the last per-row function call comes out of the task SELECT policy.
--
-- ⚠️ SAME CLAIM AS P12-03: THIS CHANGES HOW THE POLICY IS EVALUATED, NOT WHO CAN
-- SEE WHAT. If you are reviewing it and cannot convince yourself of that for a
-- given line, STOP. P12-03 was written with the same claim and shipped a 42P17
-- recursion that broke every task read in production; P12-04 repaired it. That
-- history is the reason this one is small.
--
-- THE MEASUREMENT. `vizserve_pms_sidebar_snapshot()` returns in ~171ms as
-- `service_role` (RLS bypassed) and takes 1.2-1.5s as `authenticated`, on every
-- page load and after every task write. P12-03 took it from a `57014` statement
-- timeout to working; it did not make it fast.
--
-- WHAT IS LEFT, AND WHY P12-03 LEFT IT. The lead's clause is:
--
--     ( is_admin() OR (has_role('team_leader') AND department_id in (…)) )
--     and ( list_id is null
--           or not vizserve_pms_list_is_personal(list_id)
--           or vizserve_pms_task_on_a_timesheet(id) )
--
-- P12-03 hoisted the first half — those are session-constant — and deliberately
-- left the second, on the reasoning that it is "guarded by short-circuit and
-- almost never runs".
--
-- ⚠️ THAT REASONING FAILS FOR THE OWNER, AND PARTLY FOR EVERY TEAM LEADER.
-- `vizserve_pms_is_admin()` was re-pointed at `has_role('owner')` by P8-01b, so
-- "admin" here means THE OWNER: for them the first half is true for EVERY ROW,
-- the guard never short-circuits, and `vizserve_pms_list_is_personal(list_id)`
-- runs as a `SECURITY DEFINER` call once per task — about 3,900 per rail read.
-- A `role = 'admin'` user who leads no departments DOES short-circuit, so the
-- win is not universal. It still lands on the owner across the whole company and
-- on every team leader across their managed departments, which is the bulk of a
-- lead's board and rail.
-- A definer function cannot be inlined by the planner, so each one is a real
-- call doing a real primary-key lookup.
--
-- THE FIX, and the whole of it: the set of personal list ids is the same for
-- every row in the statement, so ask for it once. `x in (select f())` with an
-- uncorrelated set-returning function becomes ONE hashed SubPlan — the same
-- treatment `vizserve_pms_my_task_ids()` got in P12-04, for the same reason.
--
-- ⚠️ `vizserve_pms_task_on_a_timesheet(id)` IS LEFT AS A PER-ROW CALL, and that
-- is correct: it takes the ROW'S OWN id, so there is nothing constant to hoist,
-- and it is now genuinely guarded — it runs only for a task that really is in
-- somebody's personal list, which is a handful of rows rather than all of them.
-- ---------------------------------------------------------------------------

-- ⚠️ APPLY AS `postgres`. The definer privilege is what makes this correct, and
-- it only works because the function's OWNER is exempt from the RLS on
-- `vizserve_pms_lists` — owner exemption plus `BYPASSRLS`, not some property of
-- `SECURITY DEFINER` itself. Applied by a role without them, the clause fails
-- OPEN and hands every personal list to every lead. Every definer helper in this
-- schema already rests on this; it is written down here because P12-03 was an
-- unexamined assumption of exactly this kind.
--
-- ---------------------------------------------------------------------------
-- Every personal list, as a set.
--
-- ⚠️ `SECURITY DEFINER`, FOR THE SAME REASON `vizserve_pms_list_is_personal` IS.
-- Its comment says so in capitals: as an invoker-rights function it would return
-- false for exactly the caller who must not see the row, because RLS on
-- `vizserve_pms_lists` hides other people's personal lists from them — and
-- "false" here means "not personal", which is the answer that GRANTS access.
-- Failing open is the failure mode, so the privilege is load-bearing.
--
-- ⚠️ IT IS ENUMERABLE BY ANY AUTHENTICATED USER, AND AN EARLIER VERSION OF THIS
-- COMMENT WAVED THAT AWAY WITH A FALSE ARGUMENT. It said the policy "already
-- tells them by refusing the tasks in them" — it does not: a refusal only
-- answers about ids you ALREADY HOLD, while this RPC hands over ids you could
-- not otherwise obtain, plus the cardinality, plus a signal each time a new
-- personal list appears.
--
-- Shipped anyway, with the cost stated rather than denied. It returns opaque
-- uuids and nothing else — no name, no owner, no department, no contents — and
-- they do not pivot: reading the list is refused by `personal lists belong to
-- their owner`, and the tasks policy is unchanged. It is also STRICTLY TIGHTER
-- than what it displaces: `vizserve_pms_list_is_personal(uuid)` was granted in
-- P11-08 with no `revoke … from public`, so PUBLIC's implicit EXECUTE stands and
-- `anon` can probe it today. P12-15 closes that.
--
-- ⚠️ AND IT DIVERGES FROM `vizserve_pms_my_task_ids()`, WHICH IT OTHERWISE
-- COPIES. That one is self-scoped to `auth.uid()` and leaks nothing. This one
-- cannot be — the policy needs every personal list id, not the caller's.
--
-- ⚠️ NO NULLS IN THE SET, WHICH IS WHAT MAKES `not in` SAFE BELOW. `id` is the
-- primary key of `vizserve_pms_lists`, so it is `not null` by construction. If
-- this ever selected a nullable column, `x not in (set containing null)` is NULL
-- rather than true and the clause would silently stop admitting anything.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_personal_list_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select l.id from vizserve_pms_lists l where l.owner_id is not null;
$$;

revoke all on function vizserve_pms_personal_list_ids() from public, anon;
grant execute on function vizserve_pms_personal_list_ids() to authenticated;

comment on function vizserve_pms_personal_list_ids() is
  'P12-14. The ids of every P11-06 personal list, as a set, so the task SELECT '
  'policy can test membership once per statement instead of calling '
  'vizserve_pms_list_is_personal() once per row. SECURITY DEFINER for the same '
  'reason that function is -- an invoker-rights version answers "not personal" '
  'for exactly the caller who must not see the row, and that answer grants '
  'access. Returns ids only; the policy uses them solely to exclude rows.';

-- ---------------------------------------------------------------------------
-- The policy. Byte-for-byte the P12-04 version except for ONE disjunct.
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
    -- Uncorrelated, so one hashed SubPlan per statement; definer inside, so no
    -- RLS cycle back through the join table (the 42P17 P12-03 introduced).
    or id in (select vizserve_pms_my_task_ids())

    /*
     * ⚠️ THE LEAD'S CLAUSE. The P11-07 / P11-08 history is in
     * `20260908110000_p11_08_privacy_belongs_to_the_list.sql` and none of it is
     * revisited here: the test is still the LIST the task is filed in, never
     * the `is_personal` flag.
     *
     * ⚠️ THE ONLY CHANGE IN THIS MIGRATION IS ON THE SECOND LINE OF THE INNER
     * TEST. It was:
     *
     *     or not vizserve_pms_list_is_personal(list_id)
     *
     * which is a `SECURITY DEFINER` call per row. It is now a membership test
     * against a set built once. The two are the same question — "is this list
     * somebody's personal list?" — asked once instead of 3,900 times.
     *
     * `list_id is null` still comes first and still costs nothing, so the `not
     * in` is only ever evaluated for a task that is IN a list. That also means
     * the set can never be compared against a NULL `list_id`, which is the one
     * way `not in` differs from `not exists`.
     *
     * `vizserve_pms_task_on_a_timesheet(id)` stays a per-row call: it takes the
     * row's own id, so there is nothing constant to hoist, and it is genuinely
     * guarded — it runs only for a task actually in a personal list.
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
        or list_id not in (select vizserve_pms_personal_list_ids())
        or vizserve_pms_task_on_a_timesheet(id)
      )
    )

    /*
     * P7-17's peer clause, VERBATIM AND DELIBERATELY NOT "CORRECTED" TO MATCH
     * THE ONE ABOVE. It carries `not is_personal`, and that is a different
     * decision made on 19 Aug, not the same mistake: a colleague sees the
     * department's SHARED work and not what somebody recorded for themselves.
     */
    or (not is_personal and department_id = (select vizserve_pms_my_department()))

    /*
     * P9-01's reliever branch. Definer, so no RLS cycle; last, so it only runs
     * for a row nothing above admitted.
     */
    or vizserve_pms_is_covering_task(id, (select auth.uid()))
  );

comment on policy "tasks readable by participants and department leads" on vizserve_pms_tasks is
  'P12-14. Identical in effect to P12-04. The personal-list test is now a set '
  'membership evaluated once per statement rather than a SECURITY DEFINER call '
  'per row -- which for an ADMIN ran on every task in the company, because '
  'is_admin() makes the guard in front of it always true. See the migration '
  'header for the measurement.';
