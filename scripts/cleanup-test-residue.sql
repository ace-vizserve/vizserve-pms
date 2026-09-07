-- ============================================================================
-- ⚠️ THIS IS NOT A MIGRATION. Do not move it into supabase/migrations/.
--
-- A one-off cleanup, run by hand against the live project on 5 Sep 2026. It is
-- kept in the repo as the record of what was deleted from production and why —
-- not as something that should ever run twice. It is idempotent (everything is
-- defined by "the thing it points at no longer exists"), so a second run is
-- harmless, but it has no reason to happen.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS CLEANING UP
--
-- `tests/db/*.test.ts` has been running against the LIVE project since 18 Aug.
-- Those suites create a request, approve it, and delete the request in their
-- cleanup — but `vizserve_pms_approvals` has NO FOREIGN KEY to what it
-- references. `entity_type` is a plain text discriminator, deliberately, so
-- that Phase 5 could add `internal_request` without touching the table (P2-00).
--
-- The consequence is that every test run left its approval rows behind,
-- pointing at rows that no longer exist. Same for the notifications those
-- approvals raised. 12,148 such rows were removed earlier today; this file
-- removes the remaining 230 approvals and their notifications, and then the two
-- seeded accounts that made them.
--
-- ⚠️ Nothing here is cosmetic. Phase 6 reports turnaround FROM this table, so
-- 230 approvals of things that never existed is not clutter — it is a wrong
-- answer waiting to be reported.
--
-- ----------------------------------------------------------------------------
-- RUN PART 0 FIRST AND READ IT. It changes nothing.
-- ============================================================================


-- ============================================================================
-- PART 0 — PREVIEW. Read-only. Run this on its own and check the numbers
-- against what you expect before running anything below it.
-- ============================================================================

-- Every approval, split by whether the thing it decided still exists.
select
  a.entity_type,
  count(*)                                   as total,
  count(*) filter (where alive.ok)           as still_referenced,
  count(*) filter (where not alive.ok)       as orphaned
from vizserve_pms_approvals a
cross join lateral (
  select case a.entity_type
    when 'internal_request' then exists (select 1 from vizserve_pms_internal_requests r where r.id = a.entity_id)
    when 'timesheet_week'   then exists (select 1 from vizserve_pms_timesheet_weeks   w where w.id = a.entity_id)
    when 'request'          then exists (select 1 from vizserve_pms_requests          q where q.id = a.entity_id)
    -- An entity_type nobody has taught this query about counts as ALIVE, so a
    -- future one is never deleted by a file that predates it.
    else true
  end as ok
) alive
group by a.entity_type
order by a.entity_type;
-- Expected on 5 Sep: internal_request 177 (3 alive, 174 orphaned),
--                    timesheet_week    56 (0 alive,  56 orphaned).

-- Who made the orphans. Expected: all 230 by the two test.* accounts.
select u.email, count(*)
from vizserve_pms_approvals a
join vizserve_pms_users u on u.id = a.approver_id
where (a.entity_type = 'internal_request' and not exists (select 1 from vizserve_pms_internal_requests r where r.id = a.entity_id))
   or (a.entity_type = 'timesheet_week'   and not exists (select 1 from vizserve_pms_timesheet_weeks   w where w.id = a.entity_id))
   or (a.entity_type = 'request'          and not exists (select 1 from vizserve_pms_requests          q where q.id = a.entity_id))
group by u.email
order by 2 desc;

-- The accounts themselves, and everything that still points at them.
select
  u.email,
  u.role,
  (select count(*) from vizserve_pms_approvals            a  where a.approver_id = u.id) as approvals_restrict,
  (select count(*) from vizserve_pms_internal_requests    r  where r.requester_id = u.id) as requests_restrict,
  (select count(*) from vizserve_pms_internal_request_relievers rl where rl.reliever_id = u.id) as reliever_restrict,
  (select count(*) from vizserve_pms_dtr_entries          d  where d.user_id = u.id) as dtr_rows,
  (select count(*) from vizserve_pms_notifications        n  where n.user_id = u.id) as notifications,
  (select count(*) from vizserve_pms_user_managed_departments m where m.user_id = u.id) as leads_departments
from vizserve_pms_users u
where u.email like '%@example.com'
order by u.email;
-- ⚠️ The three *_restrict columns MUST read 0 before Part 2 will succeed.
-- They are ON DELETE RESTRICT, which is the database refusing to erase a
-- decision somebody made. Part 1 is what takes the approvals figure to zero.


-- ============================================================================
-- PART 1 — the orphaned approvals and notifications.
--
-- Wrapped in a transaction with the counts echoed, so you can ROLLBACK instead
-- of COMMIT if a number looks wrong.
-- ============================================================================
begin;

delete from vizserve_pms_approvals a
where (a.entity_type = 'internal_request' and not exists (select 1 from vizserve_pms_internal_requests r where r.id = a.entity_id))
   or (a.entity_type = 'timesheet_week'   and not exists (select 1 from vizserve_pms_timesheet_weeks   w where w.id = a.entity_id))
   or (a.entity_type = 'request'          and not exists (select 1 from vizserve_pms_requests          q where q.id = a.entity_id));
-- Expected: DELETE 230

-- The inbox rows raised for things that are gone. A notification whose
-- `entity_id` is null is a general one and is left alone.
delete from vizserve_pms_notifications n
where n.entity_id is not null
  and (
       (n.entity_type = 'internal_request' and not exists (select 1 from vizserve_pms_internal_requests r where r.id = n.entity_id))
    or (n.entity_type = 'timesheet_week'   and not exists (select 1 from vizserve_pms_timesheet_weeks   w where w.id = n.entity_id))
    or (n.entity_type = 'request'          and not exists (select 1 from vizserve_pms_requests          q where q.id = n.entity_id))
    or (n.entity_type = 'task'             and not exists (select 1 from vizserve_pms_tasks             t where t.id = n.entity_id))
  );
-- Expected: around 17. `task` is included because the client task deleted
-- earlier today left its own notifications behind the same way.

-- Read these before committing. Both should be 0.
select count(*) as approvals_still_orphaned
from vizserve_pms_approvals a
where (a.entity_type = 'internal_request' and not exists (select 1 from vizserve_pms_internal_requests r where r.id = a.entity_id))
   or (a.entity_type = 'timesheet_week'   and not exists (select 1 from vizserve_pms_timesheet_weeks   w where w.id = a.entity_id))
   or (a.entity_type = 'request'          and not exists (select 1 from vizserve_pms_requests          q where q.id = a.entity_id));

select count(*) as approvals_kept from vizserve_pms_approvals;
-- Expected: 3 — all by admin@vizserve.com, on internal requests that exist.

commit;
-- rollback;   -- <- use this instead if a number above looked wrong


-- ============================================================================
-- PART 2 — the two seeded accounts.
--
--   test.tl.vizbytes@example.com
--   test.tl.vizassists@example.com
--
-- CLAUDE.md: "Test accounts use @example.com only... A production smoke check
-- asserts zero @example.com rows." These two are the last of them.
--
-- ⚠️ THEY ARE THE NAMED LEADS OF VIZBYTES AND VIZASSISTS. Deleting them removes
-- two rows from `vizserve_pms_user_managed_departments`, so anything routed to
-- those departments will be approved by whoever else leads them. Check the
-- preview in Part 0 — as of 5 Sep both departments have four other leads
-- (nina, gary, manager@vizserve.com, and amier/joel), so neither is stranded.
-- If that is no longer true when you run this, STOP and add a lead first: a
-- department with no lead is a queue nobody can clear.
-- ============================================================================
begin;

-- Their own inbox and their one DTR row. Deleted explicitly rather than trusted
-- to cascade, because a RESTRICT here would abort the whole transaction with a
-- constraint name and no clue which table it came from.
delete from vizserve_pms_notifications
where user_id in (select id from vizserve_pms_users where email like 'test.%@example.com');

delete from vizserve_pms_dtr_entries
where user_id in (select id from vizserve_pms_users where email like 'test.%@example.com');

-- `vizserve_pms_users.id` REFERENCES `auth.users(id) ON DELETE CASCADE`, so
-- deleting the auth user removes the application row, and that in turn cascades
-- `vizserve_pms_user_managed_departments`. Deleting the app row alone would
-- leave a sign-in-able auth account with no profile — worse than either state.
delete from auth.users
where email like 'test.%@example.com';
-- Expected: DELETE 2

-- Both should return 0.
select count(*) as app_rows_left   from vizserve_pms_users where email like '%@example.com';
select count(*) as auth_rows_left  from auth.users         where email like '%@example.com';

commit;
-- rollback;


-- ============================================================================
-- PART 3 — verify, after both commits.
-- ============================================================================
select 'approvals'         as t, count(*) from vizserve_pms_approvals
union all select 'notifications',        count(*) from vizserve_pms_notifications
union all select 'internal_requests',    count(*) from vizserve_pms_internal_requests
union all select 'timesheet_weeks',      count(*) from vizserve_pms_timesheet_weeks
union all select 'tasks',                count(*) from vizserve_pms_tasks
union all select 'tasks_filed_in_a_list',count(*) from vizserve_pms_tasks where list_id is not null
union all select 'lists',                count(*) from vizserve_pms_lists
union all select 'forms',                count(*) from vizserve_pms_forms
union all select 'requests',             count(*) from vizserve_pms_requests
union all select 'example_com_accounts', count(*) from vizserve_pms_users where email like '%@example.com';

-- Expected after everything:
--   approvals              3        (admin@vizserve.com, on requests that exist)
--   notifications          ~504
--   internal_requests      4
--   timesheet_weeks        1
--   tasks                  3857     ⚠️ unchanged — the imported ClickUp work
--   tasks_filed_in_a_list  3857     ⚠️ unchanged — folder structure intact
--   lists                  43
--   forms                  1        the INTERNAL "Test Form"; client forms gone
--   requests               0
--   example_com_accounts   0

-- ⚠️ THE THING THAT CAUSED ALL OF THIS IS FIXED — 7 Sep 2026, and it is worth
-- recording here because this file is the only place the incident is written
-- down in full.
--
-- The cause was that `tests/db/helpers.ts` read NEXT_PUBLIC_SUPABASE_URL: the
-- suite pointed wherever the APP pointed, and the app has pointed at the live
-- project since 18 Aug. It now reads SUPABASE_TEST_URL /
-- SUPABASE_TEST_PUBLISHABLE_KEY / SUPABASE_TEST_SECRET_KEY and NOTHING ELSE,
-- and it refuses outright — with a message, not a skip — if those name the same
-- project as the app. Unset, the suite skips, so a fresh checkout and CI are
-- safe by default rather than by discipline.
--
-- `scripts/seed.mjs` gained its own guard of a different kind: it counts users
-- whose address is not @example.com and refuses if there are any. A URL check
-- would not have helped there, because seeding is always aimed at a project
-- somebody chose on purpose; "does this database have real people in it" is the
-- question that actually distinguishes the two cases.
