-- ============================================================================
-- P11-02 — the clock-in and clock-out reminders get their own lead times.
--
-- `reminder_lead_minutes` was ONE integer subtracted from both `work_start` and
-- `work_end` (p8_11). The two switches beside it are already independent, which
-- is what made the shared number look like an oversight rather than a decision:
-- somebody who wants a five-minute warning before their shift starts wants a
-- one-minute warning before it ends, because those are different problems.
-- Getting ready to start work takes time; stopping does not.
--
-- ----------------------------------------------------------------------------
-- ⚠️ `reminder_lead_minutes` IS DELIBERATELY LEFT IN PLACE.
--
-- `lib/preferences-server.ts` selects it by name. Dropping it here breaks the
-- settings page for everyone in the window between this migration being pasted
-- and the deploy landing — and migrations are pasted by hand, so that window is
-- however long somebody takes to get to Vercel. The column costs four bytes a
-- row on a table with fewer rows than there are staff.
--
-- A one-line follow-up drops it once the deploy is confirmed:
--
--     alter table vizserve_pms_user_preferences drop column reminder_lead_minutes;
--
-- ----------------------------------------------------------------------------
-- ⚠️ NOBODY'S SETTING CHANGES. Both new columns are backfilled from the old one,
-- so a person who chose 5 keeps 5 on both sides and simply gains the ability to
-- split them. The DEFAULT of 15 applies only to rows that do not exist — and
-- most do not: p8_11 created no rows and no trigger, so a missing row still
-- means the defaults, exactly as it did before.
-- ============================================================================

alter table vizserve_pms_user_preferences
  add column if not exists clock_in_lead_minutes  integer not null default 15,
  add column if not exists clock_out_lead_minutes integer not null default 15;

-- The same 1–120 bounds the single column carried, restated per side.
--
-- The floor is 1 rather than 0 because a reminder at the scheduled minute is a
-- report, not a warning. The ceiling is two hours because further ahead than
-- that it stops being about this shift.
alter table vizserve_pms_user_preferences
  drop constraint if exists vizserve_pms_user_preferences_in_lead_range;
alter table vizserve_pms_user_preferences
  add constraint vizserve_pms_user_preferences_in_lead_range
  check (clock_in_lead_minutes >= 1 and clock_in_lead_minutes <= 120);

alter table vizserve_pms_user_preferences
  drop constraint if exists vizserve_pms_user_preferences_out_lead_range;
alter table vizserve_pms_user_preferences
  add constraint vizserve_pms_user_preferences_out_lead_range
  check (clock_out_lead_minutes >= 1 and clock_out_lead_minutes <= 120);

-- Carry every existing choice across, both sides.
--
-- Guarded on the old column still existing, so this file stays runnable after
-- the follow-up drop above.
--
-- ⚠️ THE `= 15` GUARD MEANS "STILL UNTOUCHED", NOT "EQUALS FIFTEEN", and it is
-- what makes a second run harmless: a person who has since split their leads has
-- at least one side off the default, so the AND fails and their choice survives.
-- The one case it cannot tell apart is somebody who deliberately sets BOTH sides
-- back to 15 and then has this migration re-run at them — they would be reset to
-- their old shared value, which is 15 in every case except a person who had a
-- different number and then chose 15 twice. This runs once, by hand, today.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'vizserve_pms_user_preferences'
       and column_name = 'reminder_lead_minutes'
  ) then
    update vizserve_pms_user_preferences
       set clock_in_lead_minutes  = reminder_lead_minutes,
           clock_out_lead_minutes = reminder_lead_minutes
     where clock_in_lead_minutes = 15
       and clock_out_lead_minutes = 15;
  end if;
end
$$;

comment on column vizserve_pms_user_preferences.clock_in_lead_minutes is
  'P11-02. Minutes before work_start to remind. 1-120. Independent of the clock-out lead.';

comment on column vizserve_pms_user_preferences.clock_out_lead_minutes is
  'P11-02. Minutes before work_end to remind. 1-120. Independent of the clock-in lead.';

comment on column vizserve_pms_user_preferences.reminder_lead_minutes is
  'SUPERSEDED by clock_in_lead_minutes / clock_out_lead_minutes (P11-02). Kept only so the '
  'pre-P11 deploy keeps working until the new one lands; drop it after that.';

-- ============================================================================
-- WHAT THIS DOES NOT TOUCH.
--
-- No RLS change. The table is owner-only for select/insert/update (p8_11:133)
-- and these columns inherit that; a person's reminder settings are nobody else's
-- business, HR included.
--
-- No cron, because there isn't one. The reminder is a browser timer over a pure
-- function (`dueReminder` in lib/reminders.ts) — it writes nothing, sends
-- nothing, and leaves no record that it fired. That is why this whole change is
-- unit-testable rather than needing a scheduled job to be observed.
-- ============================================================================
