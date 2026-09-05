-- P9-06 — `is_mine`, MEASURED AND MADE CHEAP. Same answer, two fixes.
--
-- P9-05 moved the "Mine" rule into Postgres as a computed column and that was
-- the right call — it is what took a 16,542-character URL down to a boolean.
-- Then it was measured, which P9-05 was not:
--
--   is_mine over all 3,858 tasks ............ 1,970 ms
--   is_mine within one department (1,611) ..... 975 ms
--   is_mine + a status filter ................. 554 ms
--   the same query with no is_mine ............ 288 ms
--
-- Linear in ROWS SCANNED, at roughly half a millisecond each. That is not the
-- index lookups — `vizserve_pms_task_assignees` is keyed `(task_id, user_id)`
-- and the probe is free. It is the per-row cost of calling
-- `vizserve_pms_is_on_task`, which is SECURITY DEFINER: Postgres cannot inline
-- one, so every row paid a function call plus a `search_path` switch.
--
-- Those numbers are the WORST CASE — measured with the service key, which
-- bypasses RLS and therefore scans every task in the company. A real member's
-- query is narrowed by the tasks policy first. It was still the wrong shape to
-- leave on a page people keep open all day.
--
-- MEASURED AGAIN AFTER THIS FILE, same probe, same rows returned:
--
--   is_mine over all 3,858 tasks ....... 1,970 ms -> 199 ms
--   is_mine within one department ......... 975 ms -> 162 ms
--   is_mine + a status filter ............. 554 ms -> 150 ms
--
-- Per row, taking the difference between the 3,858-row and 1,611-row scans:
-- 0.44 ms before, 0.016 ms after. About twenty-seven times cheaper, and the
-- remainder is round-trip rather than the column.
--
-- ⚠️ Do NOT read those against the 288 ms "no is_mine" control in the list
-- above. That query returns all 3,858 ROWS and these return none, because the
-- service key has no `auth.uid()` — the payloads are not comparable. The
-- before/after pair is, because both ends returned nothing.
--
-- ---------------------------------------------------------------------------
-- FIX 1 — inline the EXISTS, drop the nested definer call.
--
-- `is_mine` needs only the join-table half of `vizserve_pms_is_on_task`: it
-- tests `assignee_id` itself, and the QA column is deliberately not part of
-- "mine" (P7-43). So the call is replaced by the one EXISTS it needed, and the
-- per-row work becomes a single index probe.
--
-- ⚠️ IT MUST BE SECURITY DEFINER TO BE FAST, and that is a real decision rather
-- than a flag. `vizserve_pms_task_assignees` has its own policy, and that
-- policy calls `vizserve_pms_is_on_task` — so an invoker-rights function
-- reading that table would evaluate the join table's RLS once per row and end
-- up slower than what it replaced.
--
-- Safe, because of what it can answer: it reads one row of the join table for a
-- task the caller can ALREADY see (the tasks policy has filtered before this
-- runs) and returns a boolean about `auth.uid()` themselves. It tells you
-- whether YOU are on a task you can already read. There is no third party in
-- the question and nothing to leak.
--
-- ---------------------------------------------------------------------------
-- FIX 2 — `coalesce(..., false)`, so it is never NULL.
--
-- Found by the same probe. With no `auth.uid()` the column came back NULL, not
-- false, because `t.assignee_id = null` is NULL and `NULL or false` is NULL.
--
-- `.eq("is_mine", true)` is unaffected — it excludes NULL exactly as it excludes
-- false — which is why nothing was broken and why nothing would have reported
-- this. The trap is the other direction: `.eq("is_mine", false)` or an
-- `.order()` silently treats "not mine" and "unknown" as different things. A
-- three-valued boolean nobody knows is three-valued is the kind of thing that
-- reads as a data bug a year from now.
--
-- The same NULL arises for a signed-in caller on any task with no assignee, so
-- this is not only a service-role curiosity.
--
-- Signature unchanged, so: create or replace, no drop, no regrant.
-- ---------------------------------------------------------------------------
create or replace function is_mine(t vizserve_pms_tasks)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    t.assignee_id = auth.uid()
    -- P7-43, unchanged in meaning and now stated in full rather than borrowed.
    -- On INTERNAL work there is no person in charge, so being on the task at
    -- all makes it yours. On CLIENT work the accountable name is the answer to
    -- "whose is this", so membership alone does not put it on your board.
    or (
      t.request_id is null
      and exists (
        select 1
          from vizserve_pms_task_assignees a
         where a.task_id = t.id
           and a.user_id = auth.uid()
      )
    ),
    false
  );
$$;

comment on function is_mine(vizserve_pms_tasks) is
  'P9-05, made cheap in P9-06. PostgREST computed column: ?is_mine=is.true. '
  'The "Mine" view on /tasks and /tasks/board. SECURITY DEFINER so the join '
  'table''s own policy is not evaluated once per row — it answers only '
  '"is auth.uid() on this task", about a task the caller can already see. '
  'Never NULL: coalesced to false so a task with no assignee does not read as '
  'unknown.';

-- The grant survives `create or replace`. Restated for the reason p7_16b
-- restates its own: if a paste ever dies between a DROP and its regrant, the
-- function is present and unexecutable, and `permission denied for function`
-- reads nothing like any other failure here.
grant execute on function is_mine(vizserve_pms_tasks) to authenticated;

-- A changed function body does not need a schema reload — the signature is the
-- same and PostgREST already knows the column. Sent anyway because it costs
-- nothing and the alternative is somebody wondering whether it was needed.
notify pgrst, 'reload schema';
