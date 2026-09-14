-- ---------------------------------------------------------------------------
-- P7-35b — the 2026 calendar becomes SINGAPORE's, not the Philippines'.
--
-- `vizserve_pms_holidays` was seeded in P4 with regular Philippine holidays,
-- because that is where the app's clock still points: every date function in
-- this schema reads `now() at time zone 'Asia/Manila'`. The company observes the
-- Singapore calendar, so the seed was simply wrong about which days the office
-- is shut. Manila and Singapore are both UTC+8, so nothing about the timezone
-- needs to move with this — only the list of dates.
--
-- ⚠️ THIS REWRITES REPORTED LEAVE, and that is not a side effect worth burying.
-- `vizserve_pms_leave_days` counts working days by consulting this table on
-- EVERY read (D27 — nothing about leave usage is stored), so the five removals
-- below each add a day back to any leave request that spanned them. Three of the
-- five have already passed on the date this migration was written (2026-09-14):
--
--   2026-04-09  Araw ng Kagitingan     PAST
--   2026-06-12  Independence Day       PAST
--   2026-08-31  National Heroes Day    PAST
--   2026-11-30  Bonifacio Day          future
--   2026-12-30  Rizal Day              future
--
-- Anyone whose approved leave covered one of those three now shows one more day
-- used for 2026 than they did yesterday. That is the correct figure — they were
-- never entitled to a Philippine holiday — but it is a figure that MOVED, and
-- the December audit will not match a copy filed before today. Deliberate, and
-- exactly the consequence D32 warns about; recorded here because the audit log
-- will not carry it (a migration has no actor, so these writes leave no row the
-- way the `/admin/holidays` screen's would).
--
-- WEEKEND DATES ARE SEEDED ON PURPOSE. Four of the holidays below fall on a
-- Saturday or a Sunday, each with its own in-lieu weekday beside it.
-- `vizserve_pms_is_working_day` excludes weekends independently of this table,
-- so the weekend rows change no arithmetic at all — they cost nothing and they
-- are what makes the calendar say WHY the following Monday is closed. The in-lieu
-- Mondays are the rows that actually move a leave count.
--
-- THREE OF THE SEVENTEEN ARE NOT PUBLIC HOLIDAYS, and the table cannot tell you
-- which, so it is recorded here. Checked against MOM's published 2026 list
-- (https://www.mom.gov.sg/employment-practices/public-holidays) on 2026-09-14:
-- the ten gazetted holidays below all match it exactly, including the three
-- in-lieu Mondays it grants for Vesak Day, National Day and Deepavali falling on
-- a Sunday. These three are the company's own:
--
--   2026-01-02  Non-working Day                  company
--   2026-03-23  In lieu of Hari Raya Puasa       company — MOM grants no in-lieu
--                                                day for the SATURDAY holiday,
--                                                only for Sunday ones
--   2026-04-02  Maundy Thursday                  company
--
-- They belong in this table anyway: it is the authority on which days the office
-- is SHUT, not on which days are gazetted, and a leave request spanning 2 January
-- must not consume a day. But they are the rows to check first if the calendar
-- and the statutory list ever have to be reconciled.
--
-- The movable ones still arrive by proclamation and still cannot be derived —
-- Hari Raya Puasa, Hari Raya Haji, Vesak Day, Deepavali and Chinese New Year all
-- shift every year. 2027 needs a list nobody has yet, and since P7-35 that list
-- is entered at /admin/holidays rather than in a migration like this one.
-- ---------------------------------------------------------------------------

-- The Philippine-only dates. Named individually rather than cleared by year:
-- a blanket `delete ... where holiday_date between '2026-01-01' and '2026-12-31'`
-- would also take anything an admin had already entered by hand through
-- /admin/holidays, which this migration knows nothing about and has no business
-- discarding.
delete from vizserve_pms_holidays
 where holiday_date in (
   date '2026-04-09',  -- Araw ng Kagitingan
   date '2026-06-12',  -- Independence Day
   date '2026-08-31',  -- National Heroes Day
   date '2026-11-30',  -- Bonifacio Day
   date '2026-12-30'   -- Rizal Day
 );

-- Upsert, not plain insert. Five of these dates are already present from the P4
-- seed and two of them need their NAME corrected — 'Labor Day' to the local
-- spelling, and Maundy Thursday to say that it is the company's own special
-- non-working day rather than a public holiday, which is the question somebody
-- will ask of it in April. `do nothing` would leave both wrong.
insert into vizserve_pms_holidays (holiday_date, name) values
  ('2026-01-01', 'New Year''s Day'),
  ('2026-01-02', 'Non-working Day'),                          -- company
  ('2026-02-17', 'Chinese New Year'),
  ('2026-02-18', 'Chinese New Year'),
  ('2026-03-21', 'Hari Raya Puasa'),                          -- Saturday
  ('2026-03-23', 'In lieu of Hari Raya Puasa (Saturday)'),    -- company
  ('2026-04-02', 'Maundy Thursday (Special Non-Working Day)'), -- company
  ('2026-04-03', 'Good Friday'),
  ('2026-05-01', 'Labour Day'),
  ('2026-05-27', 'Hari Raya Haji'),
  ('2026-05-31', 'Vesak Day'),                                -- Sunday
  ('2026-06-01', 'In lieu of Vesak Day (Sunday)'),
  ('2026-08-09', 'National Day'),                             -- Sunday
  ('2026-08-10', 'In lieu of National Day (Sunday)'),
  ('2026-11-08', 'Deepavali'),                                -- Sunday
  ('2026-11-09', 'In lieu of Deepavali (Sunday)'),
  ('2026-12-25', 'Christmas Day')
on conflict (holiday_date) do update set name = excluded.name;
