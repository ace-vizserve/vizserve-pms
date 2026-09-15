-- ---------------------------------------------------------------------------
-- P12-16 — the peer clause asks about the LIST, like every other clause does.
--
-- ⚠️ UNLIKE P12-04 AND P12-14, THIS ONE CHANGES WHO CAN SEE WHAT. It is a
-- WIDENING of the task SELECT policy and it is meant to be. Those two migrations
-- open by insisting they change only evaluation; this one is the opposite kind
-- of change and says so in its first line, so nobody reviews it against the
-- wrong claim.
--
-- THE EVIDENCE. Counted against the live project on 15 Sep 2026, in the list
-- "User Support" under VizBytes — an ordinary shared department list, not
-- anybody's personal one:
--
--     4  ONGOING tasks
--     4  carrying is_personal = true
--     0  visible to a VizBytes member who is not the assignee
--
-- The titles are "File Access - mandarin teachers", "Printer Issue - Ms. Wynne",
-- "Account Login Error - Ms. Kristel", "Restrict Teacher Access to SharePoint
-- Files to Prevent Editing". Those are other people's problems, filed in the
-- team's own support queue. The support team could not see its own queue.
--
-- WHY THE FLAG WAS SET. `quickAddTask` routes to
-- `vizserve_pms_create_personal_task` whenever the assignee is the caller
-- (`app/(app)/tasks/actions.ts`), so `is_personal` records WHO TYPED IT AND FOR
-- WHOM — P7-01's third kind of work, a member recording their own rather than a
-- lead assigning it. It has never meant "private". On a team that records its
-- own tickets, it is set on essentially everything.
--
-- ⚠️ THIS IS THE DECISION P11-08 DEFERRED, NOT A CORRECTION TO IT.
-- `20260908110000_p11_08_privacy_belongs_to_the_list.sql` established the rule —
-- "A task is private because of WHERE IT IS FILED, never because of who typed
-- it" — measured the damage on the timesheet (13 entries hidden from leads
-- across five people; exactly 1 genuinely private), and fixed the LEAD's clause.
-- It left P7-17's peer clause alone on purpose, with its reason written down:
--
--     "It carries `not is_personal`, and that is a different decision made on
--      19 Aug, not the same mistake ... If that rule should change it is its own
--      decision, on its own evidence."
--
-- The four rows above are that evidence, and this is that decision. P7-17's
-- concern was real and is preserved below: it did not want a private to-do list
-- published to the department. What it lacked was a column that identifies one.
-- P11-06 built that column — `vizserve_pms_lists.owner_id` — five weeks later.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES, EXACTLY ONE THING: a task filed in a NON-PERSONAL list in your
-- own department is now readable by that department whatever `is_personal` says.
--
-- WHAT DOES NOT CHANGE, and this is deliberately NOT a full mirror of the
-- lead's clause:
--
--   * A task in somebody's PERSONAL list stays invisible to peers. Unchanged
--     since P11-06, and the lead's timesheet escape hatch
--     (`vizserve_pms_task_on_a_timesheet`) is NOT copied here — a peer has no
--     week to review, so the reason that exception exists does not apply.
--
--   * A LIST-LESS personal task stays invisible to peers, and that asymmetry is
--     the point rather than an oversight. Filing work into a shared list is an
--     act: it is how somebody says "this belongs to the team". A task with no
--     list at all has not been filed anywhere, so the old test still answers it
--     — and that is precisely P7-17's private to-do.
--     `tests/db/department-visibility.test.ts` builds its fixture with
--     `p_list_id: null` for exactly that reason, and still passes unchanged.
--     The lead's clause admits these because a lead's hours have to add up on
--     the timesheet; a peer's do not.
--
-- So: the minimum widening that fixes the support queue, and nothing past it.
--
-- ---------------------------------------------------------------------------
-- ⚠️ READING IS NOT THE ONLY THING THIS OPENS. STATED HERE RATHER THAN
-- DISCOVERED LATER.
--
-- Two rules downstream are ALREADY department-wide and carry NO `is_personal`
-- test. They were simply unreachable for these rows, because SELECT hid them:
--
--   * `tasks updatable by the department` (P11-03) admits any active member of
--     the task's department, so every column in the grant becomes editable.
--   * `vizserve_pms_transition_task` (P11-05) admits `v_in_dept`, so a member
--     may MOVE a newly visible task through the internal transitions.
--
-- That follows from P11-03's ruling — a task belongs to its department, not to
-- its PIC — and is the intended consequence for work that is genuinely the
-- team's. It is nonetheless the real blast radius of this file: four tickets
-- stop being one person's and become VizBytes's. The QA seat is untouched (a
-- member still cannot pass their own department's work through Gate 2), and
-- `status` stays outside the column grant, so every move still goes through the
-- state machine and still writes history. `vizserve_pms_audit_row_update` covers
-- the rest.
--
-- COST: none measurable. The department test is the same hoisted scalar
-- subquery it already was, and the personal-list test is P12-14's uncorrelated
-- set — one hashed SubPlan per statement, shared with the lead's clause. No new
-- per-row call is introduced.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, as `postgres`, pasting this file
-- as it stands at that moment. The definer helpers it leans on rest on the
-- owner's RLS exemption — see the warning at the top of
-- `20260915100000_p12_14_personal_list_test_runs_once.sql`.
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
     * THE LEAD'S CLAUSE — P11-08's rule, P12-04's hoisting, P12-14's set.
     * UNCHANGED BY THIS MIGRATION, byte for byte.
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
     * ⚠️ THE PEER CLAUSE. THE ONLY THING THIS MIGRATION CHANGES.
     *
     * It read, from P7-17 through P12-14:
     *
     *     or (not is_personal and department_id = (select vizserve_pms_my_department()))
     *
     * `not is_personal` was standing in for "not somebody's private to-do",
     * because on 19 Aug no other column could say it. One can now, and it is the
     * same one the lead's clause above asks — so the two clauses stop disagreeing
     * about what "private" means.
     *
     * ⚠️ THE DEPARTMENT TEST COMES FIRST, AND THAT IS THE COST CONTROL. It is a
     * hoisted scalar subquery compared against a column, so it is free, and it is
     * false for most rows in the table — the set membership behind it is reached
     * only for a row in the caller's own department.
     *
     * ⚠️ `list_id is not null` GUARDS THE `not in`, twice over. It is what keeps
     * a list-less personal task on the old rule (see the header), and it is also
     * what guarantees a NULL is never compared against the set: `null not in
     * (...)` is NULL rather than true, which would quietly stop admitting
     * list-less work altogether. `vizserve_pms_personal_list_ids()` selects a
     * primary key, so the set itself holds no nulls — that argument is P12-14's
     * and it is still load-bearing here.
     */
    or (
      department_id = (select vizserve_pms_my_department())
      and (
        (list_id is not null and list_id not in (select vizserve_pms_personal_list_ids()))
        or (list_id is null and not is_personal)
      )
    )

    /*
     * P9-01's reliever branch. Definer, so no RLS cycle; last, so it only runs
     * for a row nothing above admitted.
     */
    or vizserve_pms_is_covering_task(id, (select auth.uid()))
  );

comment on policy "tasks readable by participants and department leads" on vizserve_pms_tasks is
  'P12-16. A WIDENING, unlike P12-04 and P12-14. The peer clause now tests the '
  'LIST a task is filed in rather than its is_personal flag, so a department '
  'sees work a colleague recorded for themselves in a SHARED list -- the support '
  'queue this was found in. A personal list stays invisible to peers, and so does '
  'a list-less personal task, which is P7-17''s private to-do. See the migration '
  'header for the evidence and for what it opens downstream.';
