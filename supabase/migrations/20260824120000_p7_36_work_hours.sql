-- ---------------------------------------------------------------------------
-- P7-36 — the scheduled working day, on the staff record.
--
-- The DTR has recorded punches since P5-01 and has never known what any of them
-- SHOULD have been. A 09:06 time-in against a 09:00 shift and a 09:06 time-in
-- against a 10:00 shift are the same row. Every "is this person late" question
-- has therefore been answered by a human reading the table and remembering the
-- schedule, which is exactly the manual step this app exists to delete.
--
-- Two columns, and the pair is the whole feature: everything downstream — the
-- off-schedule dialog after a punch, the correction request it offers, the
-- deviation note on the row — is a read of these two values against a punch.
--
-- OPTIONAL, and NULL IS A SUPPORTED STATE, not missing data. Not everybody here
-- works fixed hours, and for anybody who does not, the DTR must behave exactly
-- as it did before this migration: no deviation, no dialog, no nagging. That is
-- why there is no default and no backfill. "No schedule recorded" and "a
-- schedule of 09:00-18:00 that nobody has corrected" must never look alike.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`. This one goes AFTER P7-32, P7-33 and
-- P7-34, which were written before it and may still be unapplied.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- `time`, NOT `timetz`, and the choice is already settled twice in this schema.
--
-- `vizserve_pms_timesheet_entries.started_at/ended_at` are `time` (p7_21:27) and
-- `p_correction_time` in vizserve_pms_submit_internal_request is `time`. Both
-- are read as Manila wall-clock and composed with `at time zone 'Asia/Manila'`
-- at the point of use, which is the only place a date exists to compose with.
--
-- `timetz` stores a fixed UTC offset with no date, so it cannot represent a DST
-- change. Manila is UTC+8 all year, so it would appear to work indefinitely and
-- then be wrong the first day this app serves a second timezone — the failure
-- mode being a schedule that is silently an hour out rather than an error.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_users
  add column work_start time,
  add column work_end   time;

-- ---------------------------------------------------------------------------
-- BOTH OR NEITHER, written as an explicit OR of the two whole cases.
--
-- The short form is tempting and wrong to read:
--
--   check ((work_start is null) = (work_end is null) and work_end > work_start)
--
-- That admits the both-null case only by accident — the second conjunct is NULL
-- when the columns are, the whole expression is NULL, and a CHECK admits NULL.
-- It works, and the next person to touch it cannot tell whether it was meant to.
--
-- NOT `not valid`, and this is the one recent constraint on this table that
-- should not be. P7-12, P7-16 and P7-32 all needed `not valid` because history
-- could not satisfy a new rule. Here every existing row is (null, null), which
-- the first branch admits, so Postgres can validate it now and the constraint
-- is honest about the whole table rather than only about future writes.
--
-- `work_end > work_start` BANS AN OVERNIGHT SCHEDULE, not an overnight punch.
-- The punch path supports a shift that crosses midnight deliberately (p5_01:22)
-- — in at 22:00, out at 01:00, recorded against the first day, and
-- vizserve_pms_dtr_entries_out_after_in compares instants precisely so it
-- passes. That is untouched. What cannot be RECORDED here is a scheduled
-- 22:00-06:00, which is Q8 in p5_01's header and still open. If it is ever
-- answered, this constraint is what has to change, not the DTR.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_users
  add constraint vizserve_pms_users_work_hours_shape check (
    (work_start is null and work_end is null)
    or (
      work_start is not null
      and work_end is not null
      and work_end > work_start
    )
  );

comment on column vizserve_pms_users.work_start is
  'P7-36. Manila wall-clock start of the scheduled day. Both-or-neither with '
  'work_end. NULL means no schedule is recorded, so nothing computes lateness '
  'for this person — a supported state, not missing data.';

comment on column vizserve_pms_users.work_end is
  'P7-36. Manila wall-clock end of the scheduled day. NOTE this span includes '
  'the unpaid break: 08:00-17:00 describes an eight-hour day. Nothing computes '
  'scheduled DURATION from these two columns today, and anything that starts to '
  '— "hours short of schedule", say — needs a break column first, because '
  '(work_end - work_start) is not the number it is looking for.';

-- No RLS work and no grant. vizserve_pms_users already carries read-own,
-- read-managed-departments and write-admin policies (p0_06_rls_policies:45-58),
-- and a table-level `grant select` reaches a column added later. A member reads
-- their own hours, a lead reads their department's, only an admin writes them —
-- which is the intended rule, arrived at without a line of new policy.
--
-- vizserve_pms_handle_new_auth_user inserts (id, email, full_name) the instant
-- an Entra identity first signs in and supplies neither column. Both are
-- nullable and the both-null branch admits the row, so SSO is unaffected. This
-- is the same trigger P7-32's header warns a NOT NULL would break; the warning
-- applies verbatim to anybody who later wants to make a schedule mandatory.
