-- ---------------------------------------------------------------------------
-- P8-03 — Supabase Realtime for the client request workflow.
--
-- WHAT THIS FILE DOES, in one sentence: it puts exactly two tables on the
-- logical-replication publication that Realtime reads, so a browser can be told
-- "something you can see has changed" and re-fetch. NOTHING ELSE. No policy is
-- created, dropped or widened here; no grant moves.
--
-- ⚠️ THIS FILE GRANTS NOBODY ANY NEW READ. That sentence is the whole security
-- argument and it is worth being precise about why it is true:
--
--   Postgres Changes authorizes EVERY event against EVERY subscriber's own JWT,
--   through the same RLS policies a `select` goes through. Publishing a table
--   does not publish its rows to anybody — it makes the table's WAL stream
--   available to a service that then asks, per subscriber, per row, "may this
--   person see this?". Somebody who cannot select a task row cannot receive its
--   change event either.
--
--   The `filter` the client sends is a SECOND, narrower gate evaluated
--   SERVER-SIDE: a filtered-out event never leaves the database, so it is not
--   "the browser ignores it", it is "the browser is never sent it". Filter plus
--   RLS is belt and braces, in that order — the filter is an efficiency and a
--   blast-radius control, RLS is the enforcement. See the doc comment on
--   `realtimeDepartmentScope` in lib/auth/authorization.ts, which says the same
--   thing from the TypeScript side and is deliberately emphatic that the helper
--   there is NOT an enforcement boundary.
--
-- ⚠️ THE SUBSCRIPTION IS A PING, NOT A DATA CHANNEL. The client never reads the
-- payload. It calls `router.refresh()`, and the page re-fetches through RSC and
-- RLS exactly as it does on a navigation today. There is no client-side row
-- merging and therefore no second source of truth that can drift from the
-- database — which is the failure mode every "live table" implementation
-- eventually produces, and the reason this one is deliberately dumber.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7/P8 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
--
-- RE-PASTE SAFE. `alter publication ... add table` raises
-- `42710 relation "x" is already member of publication "supabase_realtime"`,
-- which would abort the whole batch on a second paste and leave whoever pasted
-- it unsure how much of the file took. So each add is guarded on
-- `pg_publication_tables`. `replica identity full` is idempotent by nature —
-- setting the identity a table already has is a no-op — and is left unguarded
-- for that reason.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 0. THE PUBLICATION MUST ALREADY EXIST.
--
-- Supabase creates `supabase_realtime` when a project is provisioned, and the
-- Realtime service reads that name and no other. If it were missing, adding
-- tables to a publication invented here would succeed and then do nothing — the
-- classic silent failure, where the SQL is green and no event ever arrives.
--
-- So this stops, loudly, with a sentence that says what to do. A legible refusal
-- IS the guard; `publication "supabase_realtime" does not exist` is not.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'The supabase_realtime publication is missing. Enable Realtime for this project in the Supabase dashboard, then re-run this file.'
      using errcode = 'undefined_object';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 1. NOTIFICATIONS — the live inbox badge, and one toast.
--
-- Filtered client-side as `user_id=eq.<me>`, which is the same predicate as the
-- policy behind it: `"notifications read own"` is `user_id = auth.uid()`
-- (20260729090400_p0_06_rls_policies.sql:86-88). The filter and the policy
-- agreeing exactly is the ideal case — the filter cannot be wrong in the
-- dangerous direction, because anything it let through that it should not have
-- would still be refused by the policy.
--
-- This is what stops the sidebar's unread count being a number that was only
-- true at the moment the page loaded.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'vizserve_pms_notifications'
  ) then
    alter publication supabase_realtime add table public.vizserve_pms_notifications;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2. TASKS — the board, the task lists, the task detail page and /requests.
--
-- Filtered client-side by DEPARTMENT: `department_id=eq.<uuid>` for one, or
-- `department_id=in.(<uuid>,<uuid>)` for several. `vizserve_pms_tasks
-- .department_id` is NOT NULL, so every row is reachable by that filter and
-- there is no null hole for an event to fall through.
--
-- ⚠️ THE FILTER IS NARROWER THAN THE POLICY, ON PURPOSE, AND THE GAP IS A
-- MISSED REFRESH RATHER THAN A LEAK. The SELECT policy
-- (20260819100000_p7_17_department_visibility.sql:110) is:
--
--     assignee_id = auth.uid()
--     or qa_assignee_id = auth.uid()
--     or vizserve_pms_manages_department(department_id)
--     or vizserve_pms_is_on_task(id, auth.uid())
--     or (same department and not personal)
--
-- The first, second and fourth branches can reach OUTSIDE the subscriber's own
-- and managed departments — a task in another department that you are assigned
-- to, or watching. Those rows are visible to you and will not push. The page is
-- then exactly as stale as it is today, and stale is this design's chosen
-- failure: it never shows a row RLS would refuse, it occasionally shows an old
-- one. Widening the filter to close that would mean an unfiltered stream, which
-- is the firehose this whole design exists to avoid.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'vizserve_pms_tasks'
  ) then
    alter publication supabase_realtime add table public.vizserve_pms_tasks;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 3. REPLICA IDENTITY FULL — required, and it is not free.
--
-- WHAT IT DOES: by default a table's WAL record for an UPDATE or a DELETE
-- carries only the PRIMARY KEY of the old row. `full` makes it carry THE WHOLE
-- OLD ROW.
--
-- WHY IT IS REQUIRED, for both of the things this phase depends on:
--
--   (a) THE DELETE FILTER. Realtime evaluates `department_id=in.(...)` against
--       the OLD row on a delete — the new row does not exist. With the default
--       identity there is no `department_id` in the record to compare against,
--       so a filtered subscription simply never sees deletes: a task deleted
--       from the board would stay on screen until somebody navigated. Same for
--       `user_id=eq.<me>` on a deleted notification.
--
--   (b) RLS ON THE OLD ROW OF AN UPDATE. The authorization check needs a whole
--       row to run the policy against. Without it, an update that moves a row
--       OUT of your visibility cannot be reasoned about at all.
--
-- ⚠️ THE COST, STATED HONESTLY: every UPDATE and DELETE on these two tables now
-- writes the entire old row to the WAL instead of a primary key. More WAL means
-- more disk, more replication bandwidth, and a slower write on wide rows.
-- `vizserve_pms_tasks` carries a rich-text description, so its rows are not
-- small, and a status change now costs a WAL record the size of the whole task.
--
-- It is accepted for these two tables because both are low-write by nature — a
-- task changes a handful of times over its life, a notification is written once
-- and read once — and it is NOT applied to anything else. If a future phase
-- wants Realtime on a high-churn table, this trade has to be made again for that
-- table rather than assumed to have been made here.
-- ---------------------------------------------------------------------------
alter table public.vizserve_pms_notifications replica identity full;
alter table public.vizserve_pms_tasks         replica identity full;


-- ---------------------------------------------------------------------------
-- 4. ⚠️ `vizserve_pms_requests` IS DELIBERATELY NOT PUBLISHED. READ THIS BEFORE
--    "FIXING" IT — /requests IS A LIVE PAGE AND ITS OWN TABLE IS NOT ON THIS
--    LIST, WHICH LOOKS LIKE AN OVERSIGHT AND IS NOT.
--
-- THE REASON IS ONE COLUMN THAT DOES NOT EXIST. `vizserve_pms_requests` has NO
-- `department_id`. A request reaches a department only through `form_id` →
-- `vizserve_pms_forms.department_id`, and a Postgres Changes `filter` is a
-- single `column=operator.value` expression on the CHANGED TABLE. It cannot
-- join. So there is no filter that scopes a request stream to a department, and
-- publishing the table would mean subscribing to `event: '*'` on every request
-- in the company with nothing but RLS between each subscriber and the firehose.
--
-- RLS would in fact hold — that is exactly the argument at the top of this file.
-- What would not hold is the SHAPE: every request row event in the business,
-- authorized per subscriber, to deliver a ping. This design's premise is that
-- the server-side filter comes FIRST and RLS is the second gate, not the only
-- one.
--
-- ⚠️ SO WHY IS /requests LIVE ANYWAY? Because approving at Gate 1 CREATES A
-- TASK. `vizserve_pms_approve_request` inserts into `vizserve_pms_tasks` in the
-- request's department, and that INSERT is an event THE FILTERED TASK STREAM IN
-- SECTION 2 ALREADY CARRIES. A Team Leader watching /requests is subscribed to
-- their own departments' tasks, so the approval that moves a request out of
-- their queue pushes them a refresh through the task table. The queue stays
-- correct without ever subscribing to the queue's own table.
--
-- ⚠️ AND HERE IS THE HONEST GAP, WHICH IS REAL AND IS ACCEPTED:
--
--   A SECOND TEAM LEADER RETURNING OR REJECTING A REQUEST WRITES NO TASK.
--   `RETURNED` and `REJECTED` create nothing in `vizserve_pms_tasks`, so
--   nothing is published, so a colleague's /requests sitting open will NOT
--   push. It corrects itself on their next navigation.
--
--   That is the pre-P8-03 behaviour of the entire app, so it is not a
--   regression — it is a place this phase did not reach.
--
--   ⚠️ CLOSING IT MEANS ADDING A NOTIFICATION, NOT WIDENING THIS STREAM. The
--   notification table IS published and IS filtered to the recipient, so
--   "notify the other leads of this department when a request is returned or
--   rejected" would make /requests push for exactly the people who care,
--   through a stream that is already scoped by construction. Publishing
--   `vizserve_pms_requests` to solve it would be the lazy fix and the wrong one.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 5. ⚠️ WHAT DELIBERATELY DOES NOT CHANGE.
--
-- NO POLICY IS TOUCHED. Not one `create policy`, `drop policy` or
-- `create or replace function` in this file. Realtime authorizes against the
-- policies that are already there, so editing them would change what a plain
-- `select` returns as well — a far larger blast radius than "the page refreshes
-- itself".
--
-- NO GRANTS. `alter default privileges` (p0_06_grants) already covers both
-- tables for `authenticated`, and Realtime authorizes as the subscriber rather
-- than as some new role. If a `permission denied for table` appears after this
-- paste it is the default privileges and it predates this file.
--
-- `anon` GETS NOTHING. It holds no table privileges at all (CLAUDE.md), so the
-- public form and the client approval page — which reach the database only
-- through SECURITY DEFINER functions — cannot subscribe to either table. That
-- is unchanged and must stay that way: nothing in this repo should open a socket
-- from a page with no session.
-- ---------------------------------------------------------------------------
