-- P7-76 — the rest of THIS week can be encoded before it has happened.
--
-- ⚠️ THIS RELAXES P6-01's RULE, deliberately. `20260817090000_p6_01_timesheet.sql`
-- wrote `work_date <= (now() at time zone 'Asia/Manila')::date` into both write
-- policies, and `20260818110000_p7_05_timesheet_weeks.sql:160-190` carried it
-- forward when it added the submitted-week lock. The claim was that hours are a
-- record of work done, and tomorrow's work is not done.
--
-- Amier, 18 Sep 2026: the grid shows a week, and the end of that week was
-- unusable. Somebody who knows on Thursday that Saturday is a half day on a
-- client's shoot has nowhere to put it until Saturday — so it is written on a
-- phone or not at all, and Monday goes on reconstructing it. Filling a cell
-- early is not a claim that the hour has been worked; that claim is made when
-- the WEEK is handed in, and that gate is untouched (see below).
--
-- THE NEW BOUND IS THE END OF THE CURRENT WEEK, not "no bound". Sunday of this
-- week, in Manila. Two reasons it is that and not a rolling window of days:
--
--   * The week you may encode is then always a week you may SUBMIT. A day you
--     could fill but never hand in is a trap, and a fixed number of days ahead
--     produces one every Thursday.
--   * It is the week on the screen. The grid draws Monday to Sunday, so the
--     rule a person has to hold in their head is "this grid", not a number.
--
-- WHAT DOES NOT CHANGE, and must not:
--
--   * `vizserve_pms_submit_timesheet_week` still refuses a week later than the
--     current one — "That week has not happened yet."
--     (`20260818110000_p7_05_timesheet_weeks.sql:235-238`). You may encode ahead
--     inside this week; you still hand the week in when it is the week. So an
--     approval never means a lead signed off on some future week's hours.
--   * The submitted-week lock, in BOTH halves of the UPDATE policy. The note
--     under it is about moving a row OUT of a locked week and is load-bearing;
--     it is restated verbatim below rather than assumed.
--   * `vizserve_pms_may_log_time`. A task you are not on is still refused, on
--     any date.
--   * The DELETE policy, which never carried a date test. Removing a row you
--     put on Saturday by mistake was never the problem.
--
-- WHAT IS BEING ACCEPTED: a week's figures can now describe hours that have not
-- happened yet, and a Team Leader reading /timesheet/team mid-week sees them
-- without a marker saying which is which. That is judged tolerable because the
-- week is still a DRAFT until its owner submits it — nothing downstream reads
-- an unsubmitted week as fact — and because the alternative was a grid whose
-- last days could not be typed into at all.
--
-- APPLY BY HAND, in the Supabase SQL editor, pasting this file as it stands at
-- that moment — the same as every other P7 migration, none of which is recorded
-- in `supabase_migrations.schema_migrations`.

-- ---------------------------------------------------------------------------
-- The bound, as a function rather than as an expression repeated twice.
--
-- It was written out inline in both policies before, which is how the INSERT
-- and UPDATE halves of one rule drift apart. One definition, two callers — and
-- the TypeScript that greys out a cell (`lastEncodableDay` in
-- `lib/schemas/timesheet.ts`) is written against this same sentence.
--
-- MANILA FIRST, THEN TRUNCATE. `date_trunc('week', now())` operates on a
-- timestamptz in the session zone — UTC on Supabase — which moves the week
-- boundary for eight hours every Sunday evening. Getting these two operations
-- the wrong way round is a bug that only appears on Sunday nights, and the same
-- note sits over `v_this_week` in p7_05.
--
-- `date_trunc('week', …)` is ISO: Monday starts the week, which is the week the
-- grid draws. + 6 is that week's Sunday.
--
-- Not SECURITY DEFINER. It reads no table, so it needs nobody's privileges but
-- its own; `stable` because `now()` does not move inside a statement.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_timesheet_encodable_through()
returns date
language sql
stable
set search_path = public, extensions
as $$
  select date_trunc('week', (now() at time zone 'Asia/Manila')::date)::date + 6;
$$;

comment on function vizserve_pms_timesheet_encodable_through() is
  'P7-76. The last work_date a timesheet entry may carry: Sunday of the current '
  'week, in Manila. Called from the INSERT and UPDATE policies on '
  'vizserve_pms_timesheet_entries. NOT the same bound as submitting — '
  'vizserve_pms_submit_timesheet_week still refuses a week later than this one.';

-- A policy is evaluated as the CALLER, so the caller needs EXECUTE. `anon` has
-- no business here: it holds no privilege on the entries table either.
revoke all on function vizserve_pms_timesheet_encodable_through() from public, anon;
grant execute on function vizserve_pms_timesheet_encodable_through() to authenticated;

-- ---------------------------------------------------------------------------
-- The two write policies that carried the date test, replaced.
--
-- Postgres has no "alter policy, add a clause" — a policy is dropped and
-- recreated. The names match 20260817090000 and 20260818110000 exactly, so the
-- three read as one rule with two amendments rather than three competing ones.
--
-- ⚠️ A DROP THAT MATCHES NOTHING IS THE DANGEROUS FAILURE HERE, not a loud one:
-- the old policy survives beside the new one, and PERMISSIVE policies are OR-ed
-- — so a typo in a name leaves both alive and the date test passes if EITHER
-- allows it. The names below are copied from p7_05, not retyped.
-- ---------------------------------------------------------------------------
drop policy if exists "timesheet insertable by owner" on vizserve_pms_timesheet_entries;
drop policy if exists "timesheet updatable by owner" on vizserve_pms_timesheet_entries;

create policy "timesheet insertable by owner"
  on vizserve_pms_timesheet_entries for insert to authenticated
  with check (
    user_id = auth.uid()
    and vizserve_pms_may_log_time(task_id, auth.uid())
    -- P7-76. Was `<= (now() at time zone 'Asia/Manila')::date`.
    and work_date <= vizserve_pms_timesheet_encodable_through()
    and not vizserve_pms_timesheet_week_locked(auth.uid(), work_date)
  );

-- The lock test appears in BOTH halves, and the USING half is the load-bearing
-- one. WITH CHECK evaluates the NEW row: with the test only there,
--
--   update ... set work_date = <some unlocked day> where id = <row in a
--   submitted week>
--
-- passes, because the new row's date is not locked. That silently removes hours
-- from a week somebody has already approved. USING evaluates the row as it
-- stands, which is what refuses to let it be moved out in the first place.
create policy "timesheet updatable by owner"
  on vizserve_pms_timesheet_entries for update to authenticated
  using (
    user_id = auth.uid()
    and not vizserve_pms_timesheet_week_locked(auth.uid(), work_date)
  )
  with check (
    user_id = auth.uid()
    and vizserve_pms_may_log_time(task_id, auth.uid())
    -- P7-76, and this half matters as much as the INSERT: "Change date" on the
    -- entry menu is an UPDATE, and it is how an hour typed on Friday gets moved
    -- to Saturday.
    and work_date <= vizserve_pms_timesheet_encodable_through()
    and not vizserve_pms_timesheet_week_locked(auth.uid(), work_date)
  );

-- The DELETE and SELECT policies are untouched, and the table's GRANTs are
-- unchanged — dropping a POLICY does not touch a privilege. (Dropping a
-- FUNCTION does take its grants with it, which is why the two lines above the
-- policies exist. The two have been confused here before.)
