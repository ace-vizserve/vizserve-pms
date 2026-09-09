-- ---------------------------------------------------------------------------
-- P12-01 — the rail, in one round trip.
--
-- THE PROBLEM THIS REPLACES. `app/(app)/sidebar-panel.tsx` builds the sidebar
-- from NINE queries on every render, and two of them ship rows the browser only
-- ever counts: one row per OPEN TASK in every list the caller can see, and one
-- row per PENDING REQUEST. On a lead's account that is the whole department's
-- backlog, downloaded into the SHELL — the one component every authenticated
-- page in this app renders — and then reduced to a handful of small integers in
-- a `Map`. The counting belongs where the rows already are.
--
-- ⚠️ `SECURITY INVOKER`, AND IT IS NOT A STYLE CHOICE. Every policy on every
-- table below still decides what the caller sees, exactly as it does for the
-- nine queries this replaces. A `SECURITY DEFINER` version of this function
-- would run as its owner and hand EVERY DEPARTMENT'S project tree to every
-- member in the company, on every page, silently — the tree would simply look
-- bigger than it should and nobody would read it as a leak. Definer functions in
-- this repo restate their authority check in a `where` clause because they have
-- to (see `vizserve_pms_leave_report`); this one has nothing to restate, because
-- it never leaves the caller's own reach. Do not "fix" a permissions problem
-- here by switching it.
--
-- ⚠️ NO SCOPE FILTERS, ANYWHERE IN THIS FUNCTION. Same rule the TypeScript it
-- replaces already states three times: departments, lists, folders, tasks,
-- requests and notifications all scope by policy, so a member gets their own
-- department's tree and an admin gets every one of them from the same SQL.
-- Restating a policy here would imply the policy were optional. The two
-- predicates that look like scope filters and are not — `owner_id is null` on
-- the department tree and `owner_id = auth.uid()` on the personal set — are
-- argued at the point they appear.
--
-- WHAT IT RETURNS. One jsonb object, keyed the way the components already want
-- it, so the browser does no reshaping at all:
--
--   {
--     "unread":          12,
--     "awaiting_review": 3,
--     "spaces": [ { "departmentId", "departmentName",
--                   "lists":   [ { "id", "name", "openTasks", "pendingRequests" } ],
--                   "folders": [ { "id", "name", "isSystem", "lists",
--                                  "openTasks", "pendingRequests" } ] } ],
--     "personal": [ { "id", "name", "isActive" } ]
--   }
--
-- The two top-level counts are snake_case and everything nested is camelCase.
-- That reads as an inconsistency and it is a deliberate one: the nested objects
-- are the `ProjectSpace` / `ProjectFolder` / `ProjectList` / `PersonalList` prop
-- types in `components/app-shell/` verbatim, so `JSON.parse` produces the props
-- and a rename in either direction would need a mapping layer whose only job is
-- to be forgotten.
--
-- ⚠️ SEVEN RULES LIVE HERE NOW THAT USED TO LIVE IN TYPESCRIPT. They are marked
-- (a)–(g) at the exact line that implements each. If the rail ever disagrees
-- with this function, the rail is wrong — there is no second copy of these rules
-- left in `sidebar-panel.tsx` to drift against.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Nothing in this repo applies migrations to the live project.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_sidebar_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
with
  -- (a) OPEN TASKS PER LIST, COUNTED IN POSTGRES.
  --
  -- "Live work only" — a count including everything ever finished would grow
  -- forever and stop meaning "how much is in here". `COMPLETED` and
  -- `COMPLETED_NO_RESPONSE` are deliberately distinct statuses (CLAUDE.md) and
  -- BOTH are terminal, so both are excluded; naming only the first is the
  -- obvious mistake and it would show as a count that never quite reaches zero.
  --
  -- No `parent_id` filter, faithfully to the query this replaces: a subtask that
  -- carries a `list_id` is counted like any other row. Changing that is a
  -- product decision, not a migration.
  open_by_list as (
    select
      t.list_id,
      count(*)::int as n
    from vizserve_pms_tasks t
    where t.list_id is not null
      and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
    group by t.list_id
  ),

  -- P7-26 — client requests waiting on Gate 1, counted per list.
  --
  -- A pending request has no task and therefore no `list_id`; where it WILL land
  -- is the form's inbox list, so the count is grouped through the form. An INNER
  -- join, matching the `!inner` embed it replaces: a request whose form has gone
  -- has nowhere to be counted.
  --
  -- Returns nothing for a member — `vizserve_pms_requests` is lead-only, so the
  -- badge simply never appears for them and no role check is needed here.
  pending_by_list as (
    select
      f.default_list_id as list_id,
      count(*)::int as n
    from vizserve_pms_requests r
    join vizserve_pms_forms f on f.id = r.form_id
    where r.status = 'PENDING_REVIEW'
      and f.default_list_id is not null
    group by f.default_list_id
  ),

  -- Every DEPARTMENT list the caller can see, with both counts already attached.
  dept_list as (
    select
      l.id,
      l.name,
      l.department_id,
      l.group_id,
      l.sort_order,
      coalesce(o.n, 0) as open_tasks,
      coalesce(p.n, 0) as pending_requests,
      jsonb_build_object(
        'id', l.id,
        'name', l.name,
        'openTasks', coalesce(o.n, 0),
        'pendingRequests', coalesce(p.n, 0)
      ) as node
    from vizserve_pms_lists l
    left join open_by_list o on o.list_id = l.id
    left join pending_by_list p on p.list_id = l.id
    /*
     * (b) ⚠️ P11-06 — THE ONE PREDICATE HERE THAT LOOKS LIKE A SCOPE FILTER AND
     * IS NOT.
     *
     * It shipped without this line and the result was the bug Amier reported on
     * 8 Sep: your own personal list appearing TWICE in the rail — once under
     * Personal lists where it belongs, and once under your department in the
     * project tree, as a folderless list with an open-task count beside it.
     *
     * The "no scope filters" rule in the header is still right and that is
     * exactly why this is needed. `personal lists belong to their owner` DOES
     * return your own personal lists to you, correctly — the policy is not being
     * second-guessed. What this excludes is a KIND of list, not a set of rows
     * somebody may not see: a personal list carries a department (it has to; see
     * 20260908090000_p11_06_personal_lists.sql) but is not part of that
     * department's shape. It is in no folder, nobody else can see it, and the
     * tree is explicitly where the DEPARTMENT'S work lives.
     *
     * Nobody else's tree changes by one row — for every other reader `owner_id`
     * was already null on everything they could see.
     */
    where l.owner_id is null
      and l.is_active
  ),

  -- Folders (P7-18), each carrying its lists and its rolled-up counts.
  folder as (
    select
      g.id,
      g.name,
      g.department_id,
      g.is_system,
      g.sort_order,
      jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'isSystem', g.is_system,
        'lists', coalesce(held.items, '[]'::jsonb),
        -- Rolled up, so a collapsed folder still says how much is inside.
        'openTasks', coalesce(held.open_tasks, 0),
        'pendingRequests', coalesce(held.pending_requests, 0)
      ) as node
    from vizserve_pms_task_groups g
    left join lateral (
      select
        jsonb_agg(l.node order by l.sort_order, l.name) as items,
        sum(l.open_tasks)::int as open_tasks,
        sum(l.pending_requests)::int as pending_requests,
        count(*)::int as n
      from dept_list l
      where l.group_id = g.id
        -- BOTH predicates, matching the TypeScript exactly: it filtered the
        -- department's own lists first and then split them by folder. The
        -- department test is redundant while `vizserve_pms_lists_group_guard`
        -- holds, and stating it means a folder can never borrow a list from
        -- another team if that guard is ever relaxed the way P7-25 relaxed its
        -- sibling.
        and l.department_id = g.department_id
    ) held on true
    where g.is_active
      /*
       * (e) THE RESERVED FOLDER IS DROPPED WHILE EMPTY, AND ONLY THAT ONE.
       *
       * The P7-18 backfill gives every department a "Client Requests" folder, so
       * without this every team grows a permanently empty section the day the
       * SQL is pasted. An empty folder somebody MADE is kept — otherwise it
       * vanishes the moment they create it, and the way to put a list in it is
       * unreachable.
       */
      and (not g.is_system or coalesce(held.n, 0) > 0)
  ),

  -- Departments, with their folderless lists and their surviving folders.
  dept_space as (
    select
      d.id,
      d.name,
      coalesce(loose.items, '[]'::jsonb) as lists,
      coalesce(filed.items, '[]'::jsonb) as folders
    from vizserve_pms_departments d
    left join lateral (
      /*
       * (c) FOLDERLESS LISTS — ClickUp's own term, and what EVERY list is until
       * somebody makes a folder. They are a separate key from `folders` rather
       * than a leading run inside it, which is what makes them render ABOVE the
       * folders in `nav-projects.tsx`: folders-first would have buried the whole
       * company's work under a heading on the day P7-18 landed.
       */
      select jsonb_agg(l.node order by l.sort_order, l.name) as items
      from dept_list l
      where l.department_id = d.id
        and l.group_id is null
    ) loose on true
    left join lateral (
      /*
       * (d) SYSTEM FOLDER LAST, tie-broken on the flag rather than on
       * `sort_order`, which a lead could out-bid by renumbering their own
       * folders. `is_system` is boolean and `false < true`, so ordering on it
       * ascending puts the reserved folder at the end; `sort_order, name` then
       * orders each half exactly as the query it replaces did.
       */
      select jsonb_agg(f.node order by f.is_system, f.sort_order, f.name) as items
      from folder f
      where f.department_id = d.id
    ) filed on true
    where d.is_active
  )

select jsonb_build_object(
  /*
   * The unread badge. RLS scopes it to the caller — the "notifications read
   * own" policy — so there is no user filter here.
   */
  'unread', (
    select count(*)::int
    from vizserve_pms_notifications n
    where n.read_at is null
  ),

  /*
   * P7-50 — the Requests badge: how many are sitting at Gate 1.
   *
   * PENDING_REVIEW only. That is the one status where somebody is WAITING on a
   * decision from whoever is reading the sidebar — approved, returned and
   * rejected have all had their answer, and counting them would make the badge a
   * total rather than a to-do.
   *
   * No scope filter, exactly as the unread count above: the policy on
   * `vizserve_pms_requests` already decides what the caller can see, so a Team
   * Leader gets their departments and an admin gets everyone.
   */
  'awaiting_review', (
    select count(*)::int
    from vizserve_pms_requests r
    where r.status = 'PENDING_REVIEW'
  ),

  'spaces', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'departmentId', s.id,
               'departmentName', s.name,
               'lists', s.lists,
               'folders', s.folders
             )
             order by s.name
           )
    from dept_space s
    /*
     * (f) A DEPARTMENT WITH NOTHING IN IT OPENS ONTO NOTHING, so it is dropped
     * rather than shown empty — the tree is for navigating to work, and an admin
     * sees every department in the company here.
     *
     * ⚠️ TESTED AFTER (e), NOT BEFORE IT. `s.folders` is the SURVIVING set, so a
     * department whose only folder is an empty "Client Requests" is dropped too.
     * Ordering these two rules the other way round would leave a team with a
     * heading over a folder that was itself about to be hidden.
     *
     * The Projects GROUP still renders in the rail regardless, carrying the
     * "Create a list" row, so the feature is reachable before anybody has made
     * one — that is `nav-projects.tsx`'s job, not this function's.
     */
    where jsonb_array_length(s.lists) > 0
       or jsonb_array_length(s.folders) > 0
  ), '[]'::jsonb),

  /*
   * (g) P11-06 — THE READER'S OWN LISTS, A SEPARATE SET FROM THE TREE ABOVE.
   *
   * ⚠️ NOT A COLUMN ON `dept_list`, and that is the point. Selecting `owner_id`
   * up there and splitting the rows in the browser would have made the project
   * tree — the thing every person in the company looks at all day — depend on
   * this feature parsing correctly. It does not: a fault in this branch empties
   * the Personal group and leaves the tree alone.
   *
   * ⚠️ NO `is_active` FILTER, unlike every other lists read in this app. The
   * Personal group shows archived lists behind a disclosure, because the only
   * screen that could otherwise un-archive one is `/tasks/lists`, which is
   * department-scoped and refuses a plain member — so filtering here would make
   * archiving a ONE-WAY DOOR. `isActive` rides along on each row and the
   * component decides where to put it.
   *
   * The `owner_id` filter is BELT AND BRACES, not the enforcement: `personal
   * lists belong to their owner` is the only policy that admits an owned row, so
   * the caller could not read anybody else's regardless. It is stated because
   * without it this branch would also return every DEPARTMENT list a second
   * time, which is a correctness bug rather than a security one.
   */
  'personal', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id', l.id,
               'name', l.name,
               'isActive', l.is_active
             )
             order by l.sort_order, l.name
           )
    from vizserve_pms_lists l
    where l.owner_id = auth.uid()
  ), '[]'::jsonb)
);
$$;

-- ---------------------------------------------------------------------------
-- GRANTS ARE A SEPARATE GATE FROM RLS AND BOTH MUST PASS (CLAUDE.md, P0-06).
--
-- `authenticated` only. `anon` holds no table privileges at all, and every table
-- this function touches is behind a policy that needs an `auth.uid()` — so an
-- anonymous caller would get an empty object rather than an error, which is
-- precisely the silent-empty failure Phase 1 exists to remove. Refusing the
-- EXECUTE is the honest answer.
--
-- `revoke ... from public` first: functions are executable by PUBLIC by default,
-- and `alter default privileges` in P0-06 covers tables and sequences only.
-- ---------------------------------------------------------------------------
revoke all on function vizserve_pms_sidebar_snapshot() from public, anon;
grant execute on function vizserve_pms_sidebar_snapshot() to authenticated;

comment on function vizserve_pms_sidebar_snapshot() is
  'P12-01. The whole sidebar in one jsonb: unread, awaiting_review, the '
  'department tree (folderless lists first, system folder last, empty system '
  'folders and empty departments dropped) and the caller''s own personal lists '
  'including archived ones. SECURITY INVOKER — every existing policy still '
  'decides what comes back. Counts are aggregated here rather than shipped as '
  'rows.';
