-- ---------------------------------------------------------------------------
-- P11-08 — privacy belongs to the LIST, not to `is_personal`.
--
-- ⚠️ THIS CORRECTS P11-07 (20260908100000), WHICH IS ALREADY APPLIED AND IS
-- HIDING REAL WORK FROM THE PEOPLE WHO HAVE TO APPROVE IT. Read this section
-- before touching anything else in the file.
--
-- P11-07 hung a privacy rule on `vizserve_pms_tasks.is_personal`, on the reading
-- that a personal task is somebody's private to-do item. That reading is wrong,
-- and the database says so. Counted against the live project for the week of
-- 7 Sept 2026:
--
--     57  timesheet entries that week
--     13  hidden from department leads by P11-07, across FIVE people
--      1  actually in a personal list
--
-- The other twelve are ordinary work: "HAPI HAUS - Casual Content 39",
-- "Aug 2026 HFSE IS Marketing Report", "Canva Templates for Secondary 4
-- Retreat", "Presenting and Preperation for the demo". None of it is private.
-- All of it vanished from the team timesheet.
--
-- WHY. `is_personal` does not mean "private". It means "I created this for
-- myself" — P7-01's three-way split, where the third kind is work a member
-- recorded rather than a lead assigning it. `quickAddTask` sets it on every task
-- typed into the composer with no assignee or with yourself, which on this team
-- is simply HOW WORK GETS RECORDED. Roughly a quarter of the week's entries.
--
-- THE COLUMN THAT ACTUALLY MEANS PRIVATE is `vizserve_pms_lists.owner_id`
-- (P11-06). It exists precisely because there was no way to say "this is mine
-- alone" before, and it is the thing a person opts into by making a list. A task
-- is private because of WHERE IT IS FILED, never because of who typed it.
--
-- AND THE TIMESHEET IS NOT WHERE PRIVACY IS ENFORCED. Amier, 8 Sep, looking at
-- the team week: "i cant see the personal space that i input, it should be seen
-- in here since this is the one was gonna be submit for approval". A lead
-- reviewing a week has to see the whole week — a review against a partial figure
-- is worse than no review, and P11-07's own note conceded the DTR comparison
-- would read wrong for any draft week carrying personal hours.
--
-- SO THE RULE, restated in full and replacing P11-07's:
--
--   a personal LIST and its tasks   invisible to everyone else in every board,
--                                   tree and picker. Unchanged from P11-06.
--   `is_personal` on its own        confers NOTHING. Exactly the visibility it
--                                   had before P11-07 — which is P7-01's and
--                                   P7-17's, and is what this file restores.
--   time logged against a private   visible to the department lead AS SOON AS
--   task                            IT IS LOGGED, submitted or not, because the
--                                   timesheet is what they review.
--   a peer                          never, either way. Untouched throughout.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Apply it as soon as possible: until it is applied, five
-- people's hours are missing from their leads' review screens.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. THE TWO HELPERS THIS RULE NEEDS.
--
-- Both are SECURITY DEFINER, and on the first one that is the CORRECTNESS rather
-- than an optimisation — the same trap P11-07 documented and the reason it is
-- restated here. Each is called from a policy to decide whether a lead may read
-- a row. A plain `stable` function would read its tables under the CALLER'S RLS,
-- and the caller is exactly the person being kept out: the subquery would find
-- nothing, the function would answer "not private", and the policy would show
-- the row. A privacy check that fails OPEN whenever it is working.
-- ---------------------------------------------------------------------------

/*
 * Is this list somebody's own?
 *
 * Takes the LIST id rather than the task id, because the tasks policy already
 * has `list_id` in hand on the row it is judging — so this is one primary-key
 * lookup on a small table and never a second read of the task.
 *
 * Null in, false out. A task with no list is in no personal list, and that is
 * the ordinary case for a lot of this product's history.
 */
create or replace function vizserve_pms_list_is_personal(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    (select l.owner_id is not null from vizserve_pms_lists l where l.id = p_list_id),
    false
  );
$$;

comment on function vizserve_pms_list_is_personal(uuid) is
  'P11-08. True for a P11-06 personal list. ⚠️ SECURITY DEFINER is load-bearing: '
  'as a plain function it returns false for exactly the caller who must not see '
  'the list, and the policy calling it fails open.';

/*
 * Has any time been logged against this task?
 *
 * ⚠️ NO STATUS TEST, AND THAT IS THE WHOLE CORRECTION TO P11-07. Its equivalent
 * required the week to be SUBMITTED or APPROVED, which is what emptied the team
 * screen for draft weeks — the screen a lead reads precisely to see what is
 * about to be submitted.
 *
 * Logging an hour against a private task is the act that makes it the lead's
 * business. That is a decision the person makes, deliberately, and it is
 * narrower than it sounds: a private task nobody has logged time against stays
 * completely invisible.
 */
create or replace function vizserve_pms_task_on_a_timesheet(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from vizserve_pms_timesheet_entries e where e.task_id = p_task_id
  );
$$;

comment on function vizserve_pms_task_on_a_timesheet(uuid) is
  'P11-08. True once ANY time is logged against the task, in any week, submitted '
  'or not. Called from the SELECT policy on vizserve_pms_tasks.';

-- Policy expressions run as the querying role, so without these grants every
-- query against the table reads `permission denied for function` — a GRANT
-- diagnosis, never a policy one. Same note as `vizserve_pms_my_department`.
grant execute on function vizserve_pms_list_is_personal(uuid) to authenticated;
grant execute on function vizserve_pms_task_on_a_timesheet(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE TASK POLICY, corrected.
--
-- ⚠️ THE NAME MUST MATCH EXACTLY. p7_17 records the danger in both directions,
-- and the worse one is a DROP that silently matches nothing: the old policy
-- stays alive beside the new one, they are OR-ed, and the result is WIDER than
-- either was meant to be — which here would mean the privacy rule quietly not
-- applying at all.
-- ---------------------------------------------------------------------------
drop policy if exists "tasks readable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    -- The owner of a personal task reaches it HERE, which is why nothing below
    -- can lock somebody out of their own list.
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    -- P7-13. A second assignee cannot see the task at all without this.
    or vizserve_pms_is_on_task(id, auth.uid())
    /*
     * ⚠️ THE LEAD'S CLAUSE — THE ONLY ONE P11-07 AND THIS FILE HAVE TOUCHED.
     *
     *   before P11-07   vizserve_pms_manages_department(department_id)
     *   P11-07          … and (not is_personal or <handed in>)      ← WRONG
     *   here            … and (not <in a personal list> or <on a timesheet>)
     *
     * The test moved from a flag that means "I typed this myself" to the list
     * the task is filed in, which is the only thing in this schema that means
     * private. For every task in a department list — which is all twelve of the
     * thirteen P11-07 hid — the first half is true and this is exactly the
     * clause it was before P11-07 existed.
     *
     * ⚠️ THE ORDER OF EACH `or` IS THE COST CONTROL, and Postgres short-circuits
     * left to right. `list_id is null` is free; `vizserve_pms_list_is_personal`
     * is one primary-key lookup on a small table and answers false for every
     * ordinary list, so `vizserve_pms_task_on_a_timesheet` — the only one that
     * touches the entries table — runs solely for a task that really is in
     * somebody's private list. Reversing either pair would put a subquery
     * against the timesheet on every task on every board in the company.
     */
    or (
      vizserve_pms_manages_department(department_id)
      and (
        list_id is null
        or not vizserve_pms_list_is_personal(list_id)
        or vizserve_pms_task_on_a_timesheet(id)
      )
    )
    /*
     * P7-17's peer clause, VERBATIM AND DELIBERATELY NOT "CORRECTED" TO MATCH
     * THE ONE ABOVE.
     *
     * It carries `not is_personal`, and by the argument at the top of this file
     * that looks like the same mistake. It is not the same decision. P7-17 chose
     * that a colleague sees the department's SHARED work and not what somebody
     * recorded for themselves, and it has been the rule since 19 Aug. Rewriting
     * it to `not in a personal list` would hand every member of a department
     * twelve extra tasks a week that they have never been able to see — a
     * widening, from a file whose entire purpose is to undo an accidental
     * narrowing, and one nobody asked for.
     *
     * If that rule should change it is its own decision, made on its own
     * evidence. It is not a side effect of this repair.
     */
    or (not is_personal and department_id = vizserve_pms_my_department())
  );


-- ---------------------------------------------------------------------------
-- 3. THE TIMESHEET ENTRIES POLICY, restored to p6_01's original.
--
-- P11-07 added a condition here so that a lead could not see the HOURS against a
-- personal task until the week was in. That was the half that emptied the team
-- screen, and with the task now readable as soon as it is logged against there
-- is nothing left for it to protect — an entry whose task the lead may read is
-- an entry they may read.
--
-- Restored to the p6_01 text exactly rather than "simplified", so that anybody
-- comparing this table's policy against 20260817090000_p6_01_timesheet.sql:154
-- finds the same rule and not a third variant of it.
-- ---------------------------------------------------------------------------
drop policy if exists "timesheet readable by owner and department leads"
  on vizserve_pms_timesheet_entries;

create policy "timesheet readable by owner and department leads"
  on vizserve_pms_timesheet_entries for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
        from vizserve_pms_users u
       where u.id = vizserve_pms_timesheet_entries.user_id
         and vizserve_pms_manages_department(u.primary_department_id)
    )
  );


-- ---------------------------------------------------------------------------
-- 4. P11-07's HELPERS, REMOVED.
--
-- Dropped AFTER both policies above have stopped referencing them — Postgres
-- will let a function used by a policy be dropped and then fail at query time,
-- so the order in this file is the safety.
--
-- `vizserve_pms_task_is_personal` is the dangerous one to leave lying around: it
-- reads `is_personal` past RLS and its name invites exactly the mistake this
-- file is repairing. `vizserve_pms_personal_task_handed_in` encodes the
-- submitted-first rule that has now been reversed. Neither has another caller.
-- ---------------------------------------------------------------------------
drop function if exists vizserve_pms_task_is_personal(uuid);
drop function if exists vizserve_pms_personal_task_handed_in(uuid);


-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT CHANGE.
--
-- THE PERSONAL LIST ITSELF. `personal lists belong to their owner` (P11-06) is
-- untouched: the list is invisible to everybody else, so a lead reading a task
-- through the timesheet exception above gets a shorter breadcrumb rather than
-- the list's name. That is the existing behaviour for any list out of scope —
-- `whereTaskSat` in the team screen drops what it cannot name — and it is the
-- right amount to give away: what the work was, not where it is filed.
--
-- WHICH TASKS MAY GO IN A PERSONAL LIST. `vizserve_pms_tasks_personal_list_guard`
-- (P11-06) still admits only the owner's own personal tasks. That guard is about
-- writing, not reading, and nothing here loosens it.
--
-- THE PEER RULE. Stated above, at the clause itself.
-- ---------------------------------------------------------------------------
