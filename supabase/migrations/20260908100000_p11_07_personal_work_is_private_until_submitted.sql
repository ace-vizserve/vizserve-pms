-- ===========================================================================
-- ⚠️⚠️  SUPERSEDED BY P11-08 (20260908110000_p11_08_privacy_belongs_to_the_list).
--       DO NOT PASTE THIS FILE. Pasting it reintroduces a live incident.
--
-- It hung privacy on `vizserve_pms_tasks.is_personal`, which does NOT mean
-- private — it means "I created this for myself", which is how most of this team
-- records ordinary work. Applied to the live project it hid 13 of 57 timesheet
-- entries in one week from the leads who approve them, across five people, and
-- only ONE of the thirteen was in a personal list.
--
-- The file is kept, unedited below this banner, because it is what was applied
-- on 8 Sep and P11-08 is written as a correction to it — a reader tracing why
-- two functions were dropped needs to find the file that created them. The
-- reasoning below is preserved as written, mistake and all; the mistake is
-- named at the top of P11-08.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- P11-07 — personal work is private until the week is handed in.
--
-- THE ASK, 8 Sep 2026, on top of P11-06: "i can add my personal task in the
-- timesheet and also this personal task cant be seen by other users only the TL
-- upon of submitting the timesheet".
--
-- ⚠️ THIS REVERSES A DECISION THAT IS WRITTEN DOWN, and reversing it quietly
-- would be worse than not doing it. P7-01 ends:
--
--     "A personal task is assigned to its creator and filed in their
--      department, so the member sees it by the first clause and their team
--      leader by the third. That is exactly the visibility the decision asked
--      for: personal work is not secret work, it is just not client work."
--
-- That was the right call for what P7-01 was: a way to record internal effort so
-- the hours had somewhere to live. P11-06 changed what a personal task IS — it
-- now sits in a list somebody made for themselves, which is a to-do list, and a
-- to-do list nobody asked to share is not the department's business until its
-- owner makes it so. Handing in the timesheet is that moment, and it is a moment
-- that already exists in the product rather than a new switch to explain.
--
-- SO THE RULE, in full:
--
--   the owner            always. Nothing here narrows what you see of your own.
--   a peer               never, in any state. (Already true — P7-17's
--                        department-wide clause carries `not is_personal`.)
--   the lead / an admin  only once the week the hours were logged in has been
--                        SUBMITTED or APPROVED.
--
-- ⚠️ NOTHING HERE IS NEEDED TO LOG PERSONAL TIME — that already worked, and it
-- is worth saying so because it is the half of the ask that needs no migration.
-- `vizserve_pms_may_log_time` delegates to `vizserve_pms_is_on_task` (P8-13), a
-- personal task's assignee is its own creator, and the picker in
-- `lib/timesheet-tasks-server.ts` scopes on exactly that. A personal task has
-- been loggable since P7-01.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. It depends on 20260908090000_p11_06_personal_lists.sql only
-- for its reason to exist, not for any object — so it will apply either way, and
-- either way it is P11-06 that makes it matter.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. THE TWO HELPERS, and why both are SECURITY DEFINER.
--
-- Each is called from inside a POLICY, and a policy's expression runs as the
-- querying role. A plain function here would evaluate the RLS of the tables it
-- reads while deciding RLS — which is slow, hard to reason about, and in one of
-- these two cases produces the exact opposite of the intended answer. See the
-- warning on the second one; it is the trap that makes this file worth reading.
-- ---------------------------------------------------------------------------

/*
 * Has any of this task's time been handed in?
 *
 * The condition is deliberately the SAME ONE `vizserve_pms_timesheet_week_locked`
 * uses — status in ('SUBMITTED','APPROVED'), with RETURNED absent — because
 * "handed in" already has a definition in this product and inventing a second
 * one is how two screens come to disagree about whether a week is in.
 *
 * ⚠️ RETURNED TAKES THE VISIBILITY BACK, and that is intended rather than
 * overlooked. A returned week is unlocked for editing (that is the whole
 * mechanism), so it is a draft again — and a draft's personal rows are the
 * owner's business again until they resubmit. The lead has already seen it and
 * has their reason recorded on the week; what they lose is the live view, not
 * the audit trail.
 *
 * ⚠️ ANY ENTRY, NOT EVERY ENTRY. A task logged across two weeks becomes visible
 * when the FIRST of them is submitted. The alternative — hidden until every week
 * touching it is in — would mean a lead reviewing Monday's submitted week could
 * not read a task title in it because the same task also has an hour in this
 * week's draft. The thing being reviewed has to be readable.
 *
 * The join is written out rather than calling `vizserve_pms_timesheet_week_locked`
 * per row: that function is per (user, date) and this would call it once for
 * every entry on the task, inside a policy, for every task in a list query.
 * `date_trunc('week', …)` on a `date` is ISO — Monday-based — and immutable,
 * which is what makes it usable in the join at all.
 */
create or replace function vizserve_pms_personal_task_handed_in(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_timesheet_entries e
      join vizserve_pms_timesheet_weeks w
        on w.user_id = e.user_id
       and w.week_start = date_trunc('week', e.work_date)::date
     where e.task_id = p_task_id
       and w.status in ('SUBMITTED', 'APPROVED')
  );
$$;

comment on function vizserve_pms_personal_task_handed_in(uuid) is
  'P11-07. True once ANY week carrying time against this task has been submitted '
  'or approved. Called from the SELECT policy on vizserve_pms_tasks, so it must '
  'stay SECURITY DEFINER. RETURNED is deliberately absent — a returned week is a '
  'draft again.';

/*
 * Is this task somebody's own personal work?
 *
 * ⚠️ SECURITY DEFINER HERE IS NOT AN OPTIMISATION, IT IS THE CORRECTNESS. This
 * is called from the entries policy to decide whether a lead may see a row. A
 * plain `stable` function would read `vizserve_pms_tasks` under the CALLER'S
 * RLS — and the caller is precisely the person this file is hiding that task
 * from. The subquery would find nothing, the function would return FALSE, the
 * policy would read that as "not personal", and the row would be shown.
 *
 * A privacy check that fails OPEN whenever it works correctly. Definer is what
 * makes it read the row as it actually is.
 */
create or replace function vizserve_pms_task_is_personal(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    (select t.is_personal from vizserve_pms_tasks t where t.id = p_task_id),
    false
  );
$$;

comment on function vizserve_pms_task_is_personal(uuid) is
  'P11-07. Reads is_personal past RLS. ⚠️ SECURITY DEFINER is load-bearing: as a '
  'plain function it would return false for exactly the caller who must not see '
  'the task, and the entries policy would fail open.';

-- Policy expressions run as the querying role, so without these grants every
-- query against either table reads `permission denied for function` — which is a
-- GRANT diagnosis and never a policy one. Same note as
-- `vizserve_pms_my_department` in p7_17, and the same mistake it records.
grant execute on function vizserve_pms_personal_task_handed_in(uuid) to authenticated;
grant execute on function vizserve_pms_task_is_personal(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE TASK ITSELF.
--
-- ⚠️ THE NAME MUST MATCH EXACTLY, and p7_17 records why in both directions: a
-- typo that matches nothing leaves the OLD policy alive beside the new one, and
-- two permissive policies are OR-ed — so the result is wider than either was
-- meant to be, silently. The name below is the one p7_17 created.
--
-- Every clause of p7_17's version is kept verbatim. ONE is qualified: the lead's.
-- ---------------------------------------------------------------------------
drop policy if exists "tasks readable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    -- The owner of a personal task reaches it HERE, and this clause is why
    -- nothing below can lock somebody out of their own list.
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    -- P7-13. A second assignee cannot see the task at all without this, and
    -- every other right depending on it is unreachable for them. A personal
    -- task has no second assignee — `vizserve_pms_create_personal_task` writes
    -- none and nobody who cannot see the task can add one.
    or vizserve_pms_is_on_task(id, auth.uid())
    /*
     * ⚠️ P11-07 — THE ONE CHANGED CLAUSE. It read, plainly:
     *
     *     or vizserve_pms_manages_department(department_id)
     *
     * which is what let a lead read a member's private to-do list the moment it
     * was typed. Shared work is untouched: `not is_personal` is true for every
     * client task and every task a lead created by hand, so for all of that this
     * is exactly the clause it was.
     *
     * ⚠️ THE ORDER OF THE `or` IS THE COST CONTROL. `not is_personal` is a
     * column test on the row already in hand, and Postgres short-circuits — so
     * `vizserve_pms_personal_task_handed_in` is not called at all for the
     * overwhelming majority of rows. It runs only for personal tasks, and only
     * for a caller who leads that department. Putting the function first would
     * be a subquery against the entries table for every task on every board in
     * the company.
     */
    or (
      vizserve_pms_manages_department(department_id)
      and (not is_personal or vizserve_pms_personal_task_handed_in(id))
    )
    -- P7-17. Anyone in the department, for work that is not somebody's own.
    -- Already carried `not is_personal`, so a PEER never saw a personal task and
    -- still does not — at any stage, submitted or otherwise. The rule this file
    -- adds is about the lead alone.
    or (not is_personal and department_id = vizserve_pms_my_department())
  );


-- ---------------------------------------------------------------------------
-- 3. THE HOURS LOGGED AGAINST IT.
--
-- ⚠️ WITHOUT THIS SECTION THE FEATURE SHIPS AS A BUG REPORT. The entries policy
-- is WIDER than the tasks policy and always has been, and both timesheet screens
-- embed the task as a LEFT join precisely so a row survives losing sight of it
-- (`app/(app)/timesheet/page.tsx`, `.../team/page.tsx`, pinned by
-- tests/db/timesheet.test.ts "entries survive losing sight of their task").
--
-- So narrowing only the task above would leave the lead looking at a draft week
-- of rows reading "Task no longer visible to you" — the fallback those pages
-- render. That sentence is TRUE and completely misleading: it is the wording for
-- a task reassigned out from under an entry, and here it would be describing a
-- deliberate, temporary privacy rule as though something had gone wrong.
--
-- Hiding the entry as well means there is no row at all until the week is in,
-- and then there is a complete one. The lead's draft-week total is smaller by
-- those hours; that is the honest reading of "not submitted yet", and the figure
-- the decision is actually made against — `submitted_minutes` — is snapshotted
-- by `vizserve_pms_submit_timesheet_week` at the moment everything becomes
-- visible anyway.
--
-- `vizserve_pms_timesheet_week_locked` is reused rather than re-expressed: it is
-- already the answer to "is this person's week for this date handed in", it is
-- already SECURITY DEFINER for the same policy reason, and a second copy of that
-- date arithmetic is a second thing to keep in step.
-- ---------------------------------------------------------------------------
drop policy if exists "timesheet readable by owner and department leads"
  on vizserve_pms_timesheet_entries;

create policy "timesheet readable by owner and department leads"
  on vizserve_pms_timesheet_entries for select to authenticated
  using (
    -- Your own hours, always, in every state. Nothing below applies to you.
    user_id = auth.uid()
    or (
      -- p6_01's clause, verbatim: the scope resolves through the PERSON, because
      -- an entry carries no department of its own.
      exists (
        select 1
          from vizserve_pms_users u
         where u.id = vizserve_pms_timesheet_entries.user_id
           and vizserve_pms_manages_department(u.primary_department_id)
      )
      -- P11-07, the added condition. Ordinary work is unaffected — the first
      -- half is true for every entry against every non-personal task, which is
      -- every entry that existed before P11-06.
      and (
        not vizserve_pms_task_is_personal(task_id)
        or vizserve_pms_timesheet_week_locked(user_id, work_date)
      )
    )
  );


-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE.
--
-- THE WEEKS TABLE. `vizserve_pms_timesheet_weeks` stays readable by the lead in
-- every state, and it must: it is how the team screen knows a week exists, who
-- owes one, and whether it is late. It holds a total and a status, never a task
-- title, so there is nothing private in it to hide.
--
-- THE WRITE POLICIES ON ENTRIES. Insert, update and delete are first-person only
-- and go through `vizserve_pms_may_log_time`; none of them consults the reading
-- rule this file changes, and a lead could never write to somebody's timesheet
-- anyway.
--
-- THE AUDIT LOG. `vizserve_pms_write_audit_log` records the creation of every
-- personal task (P7-01) and nothing here touches those rows. Private from the
-- team's screens is not the same as invisible to the record, and it should not
-- be — the permission P11-03 was granted on the condition that everything is
-- audited.
--
-- THE DTR COMPARISON on the team screen will read low for a draft week that
-- carries personal hours — "more on the clock than on the timesheet" — because
-- the hours it compares against are the ones the lead can see. That is a
-- consequence rather than an oversight: the comparison is a review tool, and a
-- draft week is not yet under review. It resolves itself the moment the week is
-- submitted, which is the only moment it is asked to be right.
-- ---------------------------------------------------------------------------
