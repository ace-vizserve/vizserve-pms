-- ---------------------------------------------------------------------------
-- P8-13 — re-assert that ANY assignee may log time, not just the PIC.
--
-- THE BUG, as reported: somebody who is an assignee on a task — internal or
-- client — cannot log hours against it. The timesheet behaves as though only
-- the PIC and the QA reviewer may, which is the rule P7-13 replaced on
-- 18 August.
--
-- ⚠️ THIS FILE ADDS NOTHING. It restates `vizserve_pms_may_log_time` exactly as
-- 20260818160000_p7_13_task_assignees.sql already defines it. If that file's
-- version is what is live, this is a no-op and costs one statement.
--
-- It exists because of how migrations reach the database here: BY HAND, in the
-- SQL editor, and a half-applied paste gets re-pasted (see the note in
-- 20260824130000_p7_37_app_settings.sql). `vizserve_pms_may_log_time` is
-- defined by `create or replace` in TWO files —
--
--   20260817090000_p6_01_timesheet.sql   PIC or QA          (the original)
--   20260818160000_p7_13_task_assignees  is_on_task         (the current rule)
--
-- — so re-pasting the older file after the newer one silently reinstates the
-- narrower rule. Nothing raises. The policies are unchanged, because they call
-- the function by name and never restate its body; the only symptom is that a
-- second assignee's INSERT is refused with 42501, which
-- `app/(app)/timesheet/actions.ts` renders as a sentence about three unrelated
-- rules. That is a very quiet way to lose a fix, and it is the shape of failure
-- this repo has hit before.
--
-- Dated after P8-11 so the ordering matches when it was written; it depends only
-- on P7-13's `vizserve_pms_is_on_task` and can be pasted at any time after that.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor. Safe to re-run.
-- ---------------------------------------------------------------------------

-- Fails loudly rather than creating a `may_log_time` that calls a function that
-- is not there. If this raises, P7-13 was never applied and THAT is the fix —
-- pasting this file alone would leave the join table and the tasks policies
-- still missing.
do $$
begin
  if to_regprocedure('public.vizserve_pms_is_on_task(uuid, uuid)') is null then
    raise exception
      'P8-13 needs vizserve_pms_is_on_task. Apply 20260818160000_p7_13_task_assignees.sql first.'
      using errcode = 'undefined_function';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The rule, in one line, delegating rather than restating.
--
-- ⚠️ THE BODY MUST STAY A DELEGATION. Spelling the membership test out here —
-- `assignee_id = p_user_id or qa_assignee_id = p_user_id or exists (…)` — would
-- work today and would be the fifth copy of a rule that already has four sites
-- (the tasks SELECT policy, the tasks UPDATE policy, this, and the transition
-- guard). P7-13's whole point was that they go through ONE helper, because the
-- copy that drifts is never the one you are looking at.
--
-- `security definer` and `stable` are both load-bearing and both carried
-- forward from P6-01: definer so it can be called from inside the policies on
-- the very tables it reads without re-entering RLS, stable rather than
-- immutable so the planner cannot cache a result across the statement that
-- changes it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_may_log_time(p_task_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select vizserve_pms_is_on_task(p_task_id, p_user_id);
$$;

comment on function vizserve_pms_may_log_time(uuid, uuid) is
  'P7-13, re-asserted by P8-13. ANY assignee may log time — the join table '
  'confers exactly what being the PIC does. Delegates to vizserve_pms_is_on_task; '
  'never restate the membership test here. ⚠️ p6_01 defines an older, narrower '
  'body: re-pasting that file silently reinstates PIC-or-QA.';

grant execute on function vizserve_pms_may_log_time(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- ⚠️ A NOTE ON WHAT IS *NOT* HERE.
--
-- The INSERT and UPDATE policies on `vizserve_pms_timesheet_entries` are NOT
-- touched. They live in 20260818110000_p7_05_timesheet_weeks.sql and call
-- `vizserve_pms_may_log_time(task_id, auth.uid())` by name — that indirection is
-- exactly why replacing the function is the whole fix, and why dropping and
-- recreating three policies here would be risk taken for nothing.
--
-- `vizserve_pms_tasks.assignee_id` is also untouched and keeps its meaning: the
-- ACCOUNTABLE name, what "assigned to you" addresses and what the board sorts
-- by. On an internal task import_07 records that it is not a rank at all, just
-- the assignee who happens to be in the column. Neither reading affects who may
-- log time, which is the point of this file.
-- ---------------------------------------------------------------------------
