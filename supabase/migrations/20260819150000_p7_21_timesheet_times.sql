-- ---------------------------------------------------------------------------
-- P7-21 — a timesheet entry can say WHEN in the day the work happened.
--
-- P6-01 chose durations over intervals on purpose, and that reasoning still
-- holds where it was aimed:
--
--   "the DTR already owns when somebody was at work, and two tables both
--    claiming to know that is two tables that will disagree"
--
-- That argument is about ATTENDANCE — the span from arrival to leaving, which
-- is the DTR's and only the DTR's. It is not an argument about the shape of the
-- day inside that span. "Two and a half hours on the blog post" does not say
-- whether that was before or after the client call, and a lead reconciling a
-- disputed day, or a member reconstructing one, has nothing to go on.
--
-- So: OPTIONAL times on the entry, and the DTR keeps its monopoly on the
-- working day. Nothing here is compared with `dtr_entries`, nothing is
-- derived from it, and an entry outside the day's punched hours is not refused
-- — a person who forgot to punch would otherwise be unable to record work they
-- actually did, and the DTR has its own correction path for that (P5-09).
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it
-- stands at that moment. Every P7 migration landed that way and none is
-- recorded in `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

-- `time`, NOT `timestamptz`, and this is the load-bearing choice.
--
-- The row already carries `work_date`. A timestamptz would carry a second,
-- independent claim about which day the work belongs to, and the first time the
-- two disagreed — a timezone conversion, a DST edge, a client sending UTC —
-- there would be no way to say which one was right. A wall-clock time cannot
-- disagree with the date beside it because it does not contain one.
--
-- Read as Manila wall-clock, like every other time this app shows.
alter table vizserve_pms_timesheet_entries
  add column started_at time,
  add column ended_at   time;

comment on column vizserve_pms_timesheet_entries.started_at is
  'P7-21. Optional wall-clock start on work_date, Manila. Both times or neither.';
comment on column vizserve_pms_timesheet_entries.ended_at is
  'P7-21. Optional wall-clock end on work_date, Manila. Both times or neither.';

-- ---------------------------------------------------------------------------
-- BOTH OR NEITHER.
--
-- A start with no end is an open interval, and this table has no concept of
-- one — there is no running timer here, and a half-filled pair would be a row
-- claiming a fact it cannot complete. Somebody who only knows they started at
-- nine and cannot say when they stopped has the duration for that, which is the
-- field that was always the point.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_timesheet_entries
  add constraint vizserve_pms_timesheet_entries_times_paired
  check ((started_at is null) = (ended_at is null));

-- ---------------------------------------------------------------------------
-- THE TIMES AND THE DURATION CANNOT DISAGREE.
--
-- The tempting version of this feature leaves `minutes` alone and treats the
-- times as decoration. That produces rows saying "09:00 to 11:30, 45 minutes",
-- and the moment one exists nobody can trust either number on any row.
--
-- The rule instead REMOVES the disagreement rather than tolerating it: when
-- both times are present the duration is the span between them, and the server
-- action computes it rather than asking anyone to keep two fields in step.
-- Same reasoning as deriving a task's department from its assignee instead of
-- validating a department somebody sent alongside one.
--
-- `minutes` stays authoritative when the times are absent, which is still the
-- ordinary case: the grid is a duration typed into a cell and that is not
-- changing.
--
-- STRICTLY AFTER, not merely different. A zero-length entry is refused by the
-- existing `minutes > 0` check anyway, and stating it here makes the error a
-- sentence about times rather than a constraint name about minutes.
--
-- ⚠️ WHAT THIS CANNOT EXPRESS: work crossing midnight. 22:00 to 01:00 would
-- need `ended_at < started_at` and a rule saying that means the next day —
-- which is exactly the ambiguity Q8 (docs/10) is still open on for the DTR. One
-- unanswered question about overnight work is enough; this refuses it, and the
-- duration alone still records the hours. Revisit here when Q8 is answered.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_timesheet_entries
  add constraint vizserve_pms_timesheet_entries_times_ordered
  check (
    started_at is null
    or ended_at is null
    or ended_at > started_at
  );

alter table vizserve_pms_timesheet_entries
  add constraint vizserve_pms_timesheet_entries_times_match_minutes
  check (
    started_at is null
    or ended_at is null
    -- Both are `time`, so the subtraction is an interval on one day and
    -- `epoch` is exact. No rounding: the UI offers whole minutes.
    or minutes = (extract(epoch from (ended_at - started_at)) / 60)::integer
  );

-- ---------------------------------------------------------------------------
-- NO GRANT STATEMENT, and that is correct here rather than an omission.
--
-- `vizserve_pms_timesheet_entries` holds a TABLE-WIDE
-- `grant select, insert, update, delete ... to authenticated`
-- (20260817090000:198), not the column-level list that `vizserve_pms_tasks`
-- uses to keep `status` unwritable. A new column on this table is covered the
-- moment it exists. Adding a column grant here would be harmless but would
-- imply a column-level regime that does not exist on this table, and the next
-- person would go looking for the list it belongs to.
--
-- NO OVERLAP CHECK EITHER, deliberately. Two entries at the same clock time is
-- somebody who genuinely worked on two things in one meeting, or somebody
-- reconstructing a day approximately, and refusing it would make the ordinary
-- case of "I do not remember exactly" impossible to record. The rule that
-- actually protects the numbers is the per-day 1440 total, and it is unchanged.
-- ---------------------------------------------------------------------------
