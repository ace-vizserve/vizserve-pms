-- ---------------------------------------------------------------------------
-- P11-09 — /admin/audit answers again.
--
-- The screen has been returning `canceling statement due to statement timeout`
-- instead of the trail. Nothing is wrong with the page, the query or the data —
-- the table simply grew past the point where two long-standing shortcuts stop
-- being free, and it grew there first because it is by a distance the biggest
-- table in this app. Measured against the live project on 8 Sep 2026:
--
--     18,819  vizserve_pms_audit_logs
--      3,911  vizserve_pms_tasks
--        542  vizserve_pms_task_comments
--        186  vizserve_pms_timesheet_entries
--
-- Every mutation in the app writes one of these rows and nothing prunes them, so
-- this is the shape of the table forever: the largest one, growing fastest, and
-- the only one a screen reads whole.
--
-- ⚠️ THE SAME QUERY IS FAST UNDER THE SERVICE ROLE — 153 ms for the page AND its
-- exact count. That is the diagnosis, not a footnote: the service role bypasses
-- POLICIES, so a query that is instant there and times out for an owner is a
-- query whose cost is entirely in the policy. Anyone re-measuring this with
-- `utils/supabase/admin` will conclude there is no problem.
--
-- TWO THINGS, and the first is most of it.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. THE POLICY FUNCTION WAS BEING CALLED ONCE PER ROW.
--
-- `using (vizserve_pms_is_admin())` reads like it is evaluated once — it takes
-- no arguments and names no column, so there is nothing about a row for it to
-- depend on. Postgres is entitled to hoist a qual like that out of the scan and
-- gate the whole plan on it. It is not obliged to, and here it does not.
--
-- So the owner opening this page paid for 18,819 calls, and each one is dearer
-- than a function call sounds: `vizserve_pms_is_admin` is SECURITY DEFINER with
-- `set search_path`, which blocks SQL inlining and makes every call a real
-- invocation with a GUC save and restore around it, wrapping
-- `vizserve_pms_has_role` around `vizserve_pms_current_role` and a lookup in
-- `vizserve_pms_users`. Then `count: "exact"` walks the same rows a second time.
-- Two full passes, ~38,000 privilege checks, to render twenty rows — and
-- `statement_timeout` for `authenticated` arrives long before the answer does.
--
-- ⚠️ `(select …)` IS THE ENTIRE FIX AND IT IS NOT COSMETIC. Wrapping the call in
-- a scalar subquery makes it an InitPlan: Postgres evaluates it ONCE, before the
-- scan, and reuses the boolean. Same function, same answer, same security
-- properties — 18,819 calls become one. This is the documented Supabase pattern
-- for policy functions and it is the reason to reach for it anywhere else in
-- this schema a policy calls a helper that does not depend on the row.
--
-- ⚠️ THE NAME MUST MATCH EXACTLY, and p7_17 and p11_08 both record why: a DROP
-- that silently matches nothing leaves the old policy alive beside the new one
-- and the two are OR-ed. Here that would not widen anything — the predicates are
-- identical — which makes it WORSE to spot: access stays correct, the per-row
-- call comes back through the surviving copy, and the page times out again for
-- no visible reason.
-- ---------------------------------------------------------------------------
drop policy if exists "audit logs readable by admin" on vizserve_pms_audit_logs;

create policy "audit logs readable by admin"
  on vizserve_pms_audit_logs for select to authenticated
  using ((select vizserve_pms_is_admin()));

-- Unchanged from p0_06 and restated so nobody has to go and check: there is
-- still NO insert, update or delete policy on this table. Entries arrive only
-- through `vizserve_pms_write_audit_log`, which is SECURITY DEFINER, so an actor
-- cannot forge or suppress their own trail. Read is owner-only and stays so.


-- ---------------------------------------------------------------------------
-- 2. NOTHING INDEXED `created_at`, WHICH IS THE ONLY COLUMN THE SCREEN USES.
--
-- p0_09 built two indexes and both are for the questions the WRITE side asks:
--
--     (entity_type, entity_id, created_at desc)   one record's history
--     (actor_id, created_at desc)                 one person's actions
--
-- Neither LEADS with `created_at`, so neither can serve the query the screen
-- actually runs — `where created_at >= $1 order by created_at desc limit 20`,
-- which is what `/admin/audit` issues with no filters at all. That is a full
-- scan of the table plus a sort, then a second full scan for the exact count,
-- every time anybody opens the page.
--
-- On its own this is survivable at 18,819 rows; with section 1 above it was
-- fatal, because the full scan is exactly what multiplied the per-row policy
-- call. Fixing only the policy would leave the page fast today and quietly
-- rebuilding the same problem as the table grows. Both, or neither.
--
-- `desc` to match the order the screen reads in — the trail is newest-first and
-- that is `DEFAULT_SORT` in app/(app)/admin/audit/page.tsx. A btree can be
-- walked backwards, so an ascending index would serve it too; matching the
-- declared order just means the plan needs no backward scan and the intent is
-- legible next to the query it exists for.
--
-- The exact count becomes an index-only scan against this index rather than a
-- second trip through the heap, so `count: "exact"` on the page stays honest
-- instead of being downgraded to an estimate. A paginator that reports a guess
-- is a paginator that offers a page 12 that does not exist.
--
-- NOT ADDED: an index for `?sort=action`. It would have to be
-- (action, created_at desc), and this is the most-written table in the app —
-- every server action and a dozen SQL functions insert into it — so a fourth
-- index taxes every mutation to serve a sort nobody reaches without clicking a
-- column header. With the window narrowed by the index above, that sort is a
-- scan of the period and a sort of what it holds, which is milliseconds.
--
-- Plain `create index`, not `concurrently`: the Supabase SQL editor runs
-- statements in a transaction and CONCURRENTLY cannot, and at this size the
-- build takes well under a second. It blocks writes for that moment, which
-- means an audit row or two waits, not that anything is lost.
-- ---------------------------------------------------------------------------
create index if not exists vizserve_pms_audit_logs_created_at_idx
  on vizserve_pms_audit_logs (created_at desc);


-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT CHANGE.
--
-- WHO CAN READ THE TRAIL. Owner only, exactly as before — the predicate is the
-- same function returning the same boolean. p8_01c section 6 remains the record
-- of why department admins are NOT given a scoped view of this table, and
-- nothing here reopens it.
--
-- THE 30-DAY DEFAULT WINDOW. Kept, though it is worth knowing it currently
-- filters nothing: the oldest row in the table is 18 Aug 2026, so every row is
-- inside the window and the screen's "in the last 30 days" is, for now, the
-- whole trail. That stops being true in October and the index is what makes it
-- cheap when it does.
--
-- THE PAGE. No application change is needed or made. The query in
-- app/(app)/admin/audit/page.tsx was always the right query; it was being
-- charged the wrong price for it.
-- ---------------------------------------------------------------------------
