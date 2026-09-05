-- P9-05 — "MINE", ANSWERED IN POSTGRES INSTEAD OF IN THE URL.
--
-- THE BUG THIS FIXES PRODUCED NO ERROR ANYWHERE.
--
-- `mineFilter` in lib/tasks-server.ts built a PostgREST `or(...)` fragment
-- holding every id from `vizserve_pms_task_assignees` for the caller. Filters
-- travel in the QUERY STRING, and one real user has 444 rows in that table — a
-- 16,542-character URL. The request did not come back 414 and did not come back
-- with a PostgREST error: `fetch` itself failed. The page did `data ?? []`, so
-- the failure rendered as an empty list, which on a task board reads as "you
-- have no work" and on the reliever picker read as "you have nothing to hand
-- over" to somebody holding 22 open tasks.
--
-- Found on the reliever picker (P9-01) and fixed there first with two separate
-- queries. `/tasks?view=mine` and `/tasks/board?view=mine` were over the same
-- cliff for the same person and had simply not been reported yet.
--
-- ---------------------------------------------------------------------------
-- WHY A COMPUTED COLUMN RATHER THAN SPLITTING THE QUERY.
--
-- The obvious fix is what the picker got: run it twice, once for the column and
-- once through the join table, and merge. That works there because the picker
-- asks for two fields with no sort worth preserving.
--
-- It is a bad fix for /tasks and /tasks/board. Both build ONE query out of six
-- optional filters, a chosen sort column, a direction, `nullsFirst` and a
-- `created_at` tie-break. Splitting them means building that chain twice and
-- then RE-SORTING THE MERGE IN TYPESCRIPT — a second implementation of the sort
-- that has to agree with the first for ever, on the page whose sort headers
-- have already been wrong twice (P7-64, P7-65).
--
-- PostgREST exposes a function whose single argument is a table row as a
-- VIRTUAL COLUMN on that table: selectable, filterable and orderable like any
-- other. So the rule moves into SQL, the query keeps its single `.eq()`, its
-- ordering and every one of its filters, and NOTHING variable-length is ever
-- sent. It also puts "what counts as mine" in one place instead of two.
--
-- ⚠️ NAMED WITHOUT THE `vizserve_pms_` PREFIX, and that is deliberate rather
-- than an oversight. PostgREST takes the COLUMN NAME from the function name, so
-- this is `?is_mine=is.true` to a caller. CLAUDE.md prefixes every table and
-- enum type and explicitly does NOT prefix columns; from the API surface this is
-- a column, and `vizserve_pms_is_mine` would be the only prefixed one in the
-- schema. The argument type keeps it unambiguous.
-- ---------------------------------------------------------------------------

create or replace function is_mine(t vizserve_pms_tasks)
returns boolean
language sql
stable
-- NOT security definer, and it does not need to be: `vizserve_pms_is_on_task`
-- already is, and this function only ever runs against rows the tasks policy
-- has ALREADY returned to the caller. A definer wrapper here would add nothing
-- and would be one more function reading past RLS for no reason.
set search_path = public, extensions
as $$
  select
    t.assignee_id = auth.uid()
    -- P7-43, unchanged in meaning. On INTERNAL work there is no person in
    -- charge, so being on the task at all makes it yours. On CLIENT work the
    -- accountable name is the answer to "whose is this" — somebody has to be
    -- answerable to the person who filed the request — so membership alone does
    -- not put it on your board.
    --
    -- This is the ONE place that rule now lives. `mineFilter` restated it in a
    -- PostgREST fragment and `seat()` restates the RIGHTS half separately; the
    -- fragment is deleted with this migration.
    or (t.request_id is null and vizserve_pms_is_on_task(t.id, auth.uid()));
$$;

comment on function is_mine(vizserve_pms_tasks) is
  'P9-05. PostgREST computed column: ?is_mine=is.true. The "Mine" view on '
  '/tasks and /tasks/board. Replaces lib/tasks-server.ts mineFilter, which put '
  'every joined task id in the URL and broke at 444 of them. P7-43 semantics: '
  'the PIC column always, plus membership on internal work only.';

grant execute on function is_mine(vizserve_pms_tasks) to authenticated;

-- ---------------------------------------------------------------------------
-- The index the join-table half leans on.
--
-- `vizserve_pms_is_on_task` runs once per candidate row now rather than once
-- per request, so its `vizserve_pms_task_assignees` lookup wants to be a scan
-- of nothing. The primary key is `(task_id, user_id)`, so the task-first lookup
-- is already covered and this is the one that is not.
--
-- `if not exists`: P9-01 created the same index for the reliever queries. Stated
-- again here so this file stands alone if the two are ever applied apart.
-- ---------------------------------------------------------------------------
create index if not exists vizserve_pms_task_assignees_user_idx
  on vizserve_pms_task_assignees (user_id);

-- ---------------------------------------------------------------------------
-- HOW TO CHECK THIS LANDED, because the failure mode is silent in BOTH
-- directions and neither is an error.
--
-- A computed column PostgREST has not picked up is not a 500 — an unknown
-- column in a filter comes back as a PostgREST error, but a stale schema cache
-- is what you actually hit, and the fix is a reload rather than a rewrite:
--
--   notify pgrst, 'reload schema';
--
-- Then, signed in as a real user, `/tasks?view=mine` must return the same set
-- it did before for somebody with FEW joined rows, and a non-empty set for
-- somebody with many. The second half is the whole point.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
