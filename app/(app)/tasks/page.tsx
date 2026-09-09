import { Suspense } from "react";
import { ListChecks } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  TaskColumnsMenu,
  TaskColumnsProvider,
  type ListRow,
  type TaskRow,
} from "./tasks-table";
import { isTaskStatus } from "@/components/status-badge";
import { Reveal, RevealFallback } from "@/components/ui/reveal";
import { TaskStatusGroups } from "./task-status-groups";
import {
  canAdminDepartment,
  realtimeDepartmentFilter,
  requireAuthContext,
  type AuthContext,
} from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { sanitizeRichText } from "@/lib/rich-text-server";
import type { PendingRequest } from "@/lib/schemas/approvals";
import {
  isTerminal,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
} from "@/lib/schemas/tasks";

import { EmptyState } from "@/components/empty-state";
import { loadPendingRequests } from "@/lib/pending-requests-server";
import { MINE_COLUMN } from "@/lib/tasks-server";
import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { QueryError } from "@/components/query-error";
import { FilterBarSkeleton, TaskStatusGroupSkeleton } from "@/components/skeletons";
import { createClient } from "@/utils/supabase/server";
import type { TaskComment } from "./comment-thread";

import { TaskSelectionProvider } from "./task-selection";
import { TaskFilters } from "./filters";
import { NewTaskButton } from "./new-task-button";
import { PendingRequestList } from "./pending-requests";
import { TaskToolbar } from "./toolbar";

export const metadata: Metadata = { title: "Tasks" };


/*
 * P7-65 — WIDENED FOR THE SORTABLE HEADERS.
 *
 * `due` and `priority` are the two the toolbar Select has always offered; the
 * rest are the columns whose header is now a control. They share one `?sort=`
 * param, so the Select and the headers cannot disagree about what the list is
 * ordered by.
 *
 * ⚠️ SORTING THE QUERY IS WHAT MAKES THIS WORK ON A GROUPED LIST. The rows are
 * ordered before they are split into stages, so all eight tables reorder
 * together. A browser-side sort would have reordered each group independently
 * and meant nothing across them, which is why the headers were left inert when
 * the tables first moved onto TanStack.
 */
const SORTS = ["due", "priority", "title", "start", "estimate"] as const;
type Sort = (typeof SORTS)[number];

function isSort(value: string | undefined): value is Sort {
  return typeof value === "string" && (SORTS as readonly string[]).includes(value);
}

/**
 * The order applied when the URL asks for none: by deadline, soonest first.
 *
 * `tasks-table.tsx` passes the same pair to `DataTable` as `defaultSort`, which
 * is the only reason the headers can draw an arrow for an order nobody put in
 * the query string — change one and change the other or it goes back to lying
 * about it.
 */
const DEFAULT_SORT = { sort: "due", ascending: true } as const;

function isPriority(value: string | undefined): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Named rather than written inline on the page signature, because the streaming
 * child below takes the same bag. See `TaskGroups`.
 */
type TasksSearchParams = {
  status?: string;
  view?: string;
  list?: string;
  group?: string;
  kind?: string;
  priority?: string;
  sort?: string;
  dir?: string;
};

type View = "all" | "mine" | "qa";
type Kind = "all" | "internal" | "client";

/*
 * The two cheap reads, typed as the PROMISES they are passed around as.
 *
 * ⚠️ A POSTGREST BUILDER IS A THENABLE, NOT A PROMISE — `.then()` is what fires
 * the request, so awaiting one builder in two different Suspense children would
 * issue the same query TWICE. `Promise.resolve()` settles it once and hands
 * every child the one result. The lists read has three readers below (the
 * breadcrumb, the filter panel and the row lookups) and is still one query.
 */
type ListsResult = {
  data:
    | { id: string; name: string; group_id: string | null; owner_id: string | null }[]
    | null;
};
type GroupsResult = { data: { id: string; name: string }[] | null };

/**
 * P3-03 / P3-14 — the task list.
 *
 * No department filter in the query, deliberately. RLS already says a member
 * sees tasks where they are PIC or QA and a lead sees their department's — so
 * the SAME query returns a member's own work and an admin's everything. Adding
 * `.eq("department_id", …)` here would restate a rule that already exists and
 * imply the policy were optional.
 *
 * The `mine` view is the one exception, and it is not a scope filter: it narrows
 * within what you can already see, to the work that is yours to move.
 *
 * GROUPED BY STAGE, not one flat table. The list and the board are the same
 * picture in two shapes — a board column and a list group are the same set of
 * tasks under the same heading — and grouping is what makes "how much is sitting
 * in QA" answerable without reading every row. Each group collapses, so the
 * stages nobody is working on today cost one line instead of a screenful.
 *
 * There is no Status COLUMN any more, and that is the point: inside a group the
 * status is a constant, so a column of identical pills would be eleven copies of
 * the heading. The group header carries the chip, the glyph and the label — and
 * the row's status CONTROL is a glyph in the hover strip for the same reason.
 *
 * K3/K5 — THE ROW IS EDITABLE AND IT CARRIES ITS NUMBERS. Title, both dates,
 * priority and the estimate change from here without opening anything; progress,
 * time tracked and the latest comment are read here without opening anything.
 * Every one of those columns is either already in the column-level UPDATE grant
 * or derived from a query, so none of it needed a migration.
 *
 * No <h1>. The shell breadcrumb is the page label, and the toolbar already says
 * which slice of the list you are looking at.
 *
 * ⚠️ THIS FUNCTION AWAITS NOTHING THAT COSTS A ROUND TRIP, and that is the shape
 * of the whole file. It reads the session and the URL, starts the queries and
 * returns the chrome — so the toolbar, the New Task button and the column menu
 * are on screen and usable while the ten-query batch is still in flight. Each
 * `<Suspense>` sits exactly where the data behind it is first read, so a slow
 * group cannot hold up a fast one.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<TasksSearchParams>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;

  /*
   * ⚠️ THE BARE ROUTE NO LONGER RENDERS ANYTHING. It sends you to the list tree.
   *
   * `/tasks` with no list listed EVERY task the reader could see — for a lead,
   * a whole department, thousands of rows spread across every list — under a
   * heading that promised precisely that and helped with nothing. Work here is
   * organised by list, and the flat dump was a different product wearing the
   * same route.
   *
   * Amier, 7 Sep: "the all tasks page should not be existing as its confusing,
   * task viewing should be by list only". The "All tasks" entry in the sidebar
   * went with it — see `components/app-shell/nav-projects.tsx`.
   *
   * ⚠️ THE TWO CROSS-LIST VIEWS SURVIVE, AND DELETING THEM WOULD BREAK FIVE
   * LINKS. "What is on me" and "what am I reviewing" are questions no single
   * list can answer, and `/dashboard` and `/` both link to them — the stat
   * tiles, the Needs-you overflow, the QA tile. So `?view=mine` and `?view=qa`
   * still render, and only the unfiltered entry point is gone.
   *
   * A REDIRECT RATHER THAN A DELETED FILE, deliberately: every `?list=` link in
   * the tree, every `router.refresh()` after a mutation and every bookmark
   * still resolves here. Removing the route would break all of them.
   */
  if (!params.list && params.view !== "mine" && params.view !== "qa") {
    redirect("/tasks/lists");
  }

  const supabase = await createClient();

  /*
   * ⚠️ P9-05 REMOVED A QUERY FROM THIS PAGE, and the deletion is the point.
   *
   * `fetchJoinedTaskIds` was read here for one reason: to spread every joined
   * task id into the "Mine" filter. That is what produced a 16,542-character
   * URL for a user with 444 of them and made `fetch` fail with no status code,
   * which `data ?? []` then rendered as an empty board.
   *
   * "Mine" is the `is_mine` computed column now, answered in Postgres. The
   * per-row membership this page draws controls from comes from
   * `lookups.extraAssignees`, which it already fetches for the assignee cell —
   * so nothing here needs the id list at all.
   */

  const view: View = params.view === "mine" || params.view === "qa" ? params.view : "all";

  /*
   * Client work and internal work are two different jobs and get two different
   * lists. They share a table and a status enum and almost nothing else: a
   * client task is a contract with gates protecting somebody outside the
   * company, an internal task is a board card several people share and anyone
   * can drag between stages.
   *
   * "internal" INCLUDES personal work — `scopeAllows("internal", "personal")`
   * is true, and splitting them here would make the page argue with the
   * transition rules. `request_id` is the only test needed, and it is the same
   * one `taskCategory` uses.
   */
  const kind: Kind = params.kind === "internal" || params.kind === "client" ? params.kind : "all";
  const priorityFilter = isPriority(params.priority) ? params.priority : null;

  /*
   * Fired HERE, awaited in three different children.
   *
   * These are the two cheap indexed reads the filter panel needs, plus the list
   * names the rows and the breadcrumb need. Starting them before the JSX is
   * returned means they are already in flight while the browser paints the
   * toolbar — the boundaries below decide who WAITS on them, not when they run.
   */
  const listsPromise: Promise<ListsResult> = Promise.resolve(
    supabase
      .from("vizserve_pms_lists")
      // P11-06. `owner_id` rides along so `TaskFiltersSection` can drop personal
      // lists from the filter dropdown while the breadcrumb and the row labels —
      // the read's two other consumers — keep them. It is not filtered in SQL
      // for exactly that reason; see the note in that component.
      .select("id, name, group_id, owner_id")
      .eq("is_active", true)
      .order("name"),
  );

  // P7-18. The reserved folder is offered like any other here — "show me
  // everything that came through a form" is a filter people want, and it is
  // the one folder guaranteed to exist.
  const groupsPromise: Promise<GroupsResult> = Promise.resolve(
    supabase
      .from("vizserve_pms_task_groups")
      .select("id, name")
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
  );

  /*
   * P7-26 — the requests that have not been decided yet.
   *
   * This note has now said three different things, and all three are still
   * true. It was awaited on its own line, because this is an ADDITION to the
   * page rather than part of it — the task queries decide whether the page
   * renders at all and this one must not be able to change that. Then it moved
   * INTO the task batch, to save the round trip the separate await cost.
   *
   * It is fired here, before anything is awaited, so it still runs alongside
   * the task batch exactly as it did inside it, and it still cannot fail the
   * page: `loadPendingRequests` returns [] on its own errors rather than
   * throwing (lib/pending-requests-server.ts). What is new is that it no longer
   * has to FINISH alongside the batch — the queue has its own boundary and
   * paints the moment it lands, without waiting on ten task queries.
   *
   * ⚠️ TWO READERS, ONE CALL. The queue list reads it, and so does the empty
   * state inside `TaskGroups` — "Nothing approved yet" is a different sentence
   * from "Nothing here yet" and only the request count tells them apart. This
   * is a real async function rather than a PostgREST builder, so both children
   * await the one promise and the query runs once.
   *
   * `status` and `priority` are passed as one boolean rather than as values —
   * the rule is "any task-only filter hides these", and `pendingRequestsApply`
   * should not have to learn what a status is to express that.
   */
  const pendingRequestsPromise = loadPendingRequests({
    listId: params.list ?? null,
    kind,
    scope: view,
    hasTaskOnlyFilter: Boolean(params.status || priorityFilter || params.group),
  });

  return (
    <PageShell>
      {/*
        P8-03 — the list refreshes itself when a task in one of this
        person's departments changes.

        Renders nothing, and patches no row into client state — the payload
        is thrown away unread and the data comes back through a scoped read.

        ⚠️ P12-02 NARROWED THIS AND THE NARROWING IS TEMPORARY. The ping
        used to call `router.refresh()`, which re-ran THIS server component
        so every query above went again under RLS. It now invalidates
        `qk.tasks()` and `qk.snapshot()` (`lib/query/realtime.ts`). Only the
        rail observes the second one today, so a COLLEAGUE's change moves
        the counts in the sidebar and does NOT repaint these rows until you
        navigate. Your own changes still repaint, from the Server Action's
        `revalidatePath`. Phase 3 moves this page onto `qk.taskList` and the
        rows come back live; do not put `router.refresh()` back in the hook
        to close the gap early — that is the three-renders-per-mutation
        storm P12-02 removed.

        The scope comes from `realtimeDepartmentFilter`, which is narrower
        than the SELECT policy on purpose: a task assigned to you in
        another department is visible here and will not push. See the doc
        comment there — the failure is a stale row, never a leaked one.
      */}
      <RealtimeTasks filter={realtimeDepartmentFilter(context)} />

      {/* Wraps the toolbar AND the groups: the menu lives in the filter row and
          the tables it controls are further down, so the provider has to span
          both.

          ⚠️ IT IS A CLIENT CONTEXT PROVIDER AND IT STAYS OUTSIDE EVERY BOUNDARY
          BELOW, never inside one. Inside, the fallback-to-content swap would
          remount it and silently reset which columns you had hidden. */}
      <TaskColumnsProvider>
      {/* Which list you are in, in the breadcrumb — the same fix the board
          carries. Since the Tasks nav group was removed, a list is opened from
          the project tree and List/Board are two shapes of it, so the page has
          to name the list rather than leaving the crumb reading "Tasks" over
          somebody else's work. The name comes from the lists read, which the
          filter panel and the row lookups also want.

          Only when the id resolves: a stale `?list=` from a bookmark whose list
          has since been archived should not put an empty label in the crumb.

          Its own boundary, with NO fallback and no announcement: the component
          renders null and only sets a context value, so there is nothing to
          hold a place for — and the crumb must not be made to wait behind the
          ten-query batch that used to supply its name. */}
      {params.list ? (
        <Suspense fallback={null}>
          <ListCrumb listId={params.list} listsPromise={listsPromise} />
        </Suspense>
      ) : null}

      {/* Zero queries between here and the first boundary, so this row is in the
          first flush: the view tabs and New Task are live before a single row
          has been read. */}
      <div className="flex flex-wrap items-center gap-2">
        <TaskToolbar view="list" />
        <div className="ml-auto">
          {/* The list being read, so a task made here lands in it. */}
          <NewTaskButton listId={params.list ?? null} />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {/*
          THE FILTER PANEL, WAITING ON ITS OWN TWO QUERIES AND NOTHING ELSE.

          It needs the lists and the folders — two small indexed reads that land
          long before the task batch does. Behind the same boundary as the
          groups it would have sat dark for the whole wait, which is exactly the
          wrong way round: the filter panel is what somebody reaches for when
          the list is taking too long.

          `fields={2}` is the placeholder `app/(app)/tasks/loading.tsx` already
          draws, so a navigation and an in-page refresh look identical.

          ⚠️ `role="status"`, and this is the distinction the file-level note in
          components/skeletons.tsx exists to draw: `loading.tsx` is announced by
          the ROUTER, and a Suspense fallback inside a page is announced by
          nothing at all. The grey bars stay `aria-hidden` — enumerating them
          helps nobody — and the label is what speaks.
        */}
        <Suspense
          fallback={
            <div role="status" aria-busy="true">
              <span className="sr-only">Loading filters…</span>
              <FilterBarSkeleton fields={2} />
            </div>
          }>
          <TaskFiltersSection listsPromise={listsPromise} groupsPromise={groupsPromise} />
        </Suspense>

        {/* One menu for all eight group tables — see `TaskColumnsProvider`. */}
        <div className="ml-auto">
          <TaskColumnsMenu />
        </div>
      </div>

      {/*
        THE QUEUE, ABOVE THE STAGES — and OUTSIDE the empty-state branch below.

        ⚠️ Putting this inside the `rows.length === 0` ternary is the obvious
        placement and it is wrong: a department with three requests waiting and
        no tasks yet would render "Nothing here yet" and hide the very thing it
        is waiting on, which is the exact bug this feature exists to fix.

        Above the stages because a queue is read before the work. "Open" being
        the first heading on the page while three requests sit unlooked-at is
        how a request waits a week.

        Renders nothing for a member — `vizserve_pms_requests` is readable only
        by a lead of the form's department, so the array is empty and the
        component returns null. No role check here.

        ⚠️ ITS FALLBACK IS `null`, AND IT IS THE ONE STREAMING REGION WITH NO
        LOADING ANNOUNCEMENT. On most loads it resolves to nothing at all — a
        member has no readable requests and a lead usually has an empty queue —
        so a skeleton here would be a block that flashes and then vanishes, and
        a polite "loading" that resolves to silence is worse than saying
        nothing. There is no layout to reserve for a region whose ordinary size
        is zero.
      */}
      <Suspense fallback={null}>
        <PendingRequests pendingRequestsPromise={pendingRequestsPromise} />
      </Suspense>

      {/*
        THE SLOW PART, AND THE REASON THE REST OF THE PAGE IS ALREADY ON SCREEN.

        Everything above this line costs at most two indexed reads. Below it are
        the row query, the people read and the six-query batch against the
        visible ids — ten in all — and until this boundary existed the toolbar,
        the filter panel and the queue all waited on the slowest of them.

        ⚠️ `TaskSelectionProvider` IS OUTSIDE THE BOUNDARY, WRAPPING IT, for the
        same reason `TaskColumnsProvider` is: it is a client context holding
        which rows are ticked, and inside the boundary the fallback-to-content
        swap would remount it and clear the selection. It now also spans the
        empty and error branches, which it did not before — harmless, because
        `SelectionBar` renders null with nothing selected and neither branch has
        a checkbox to put anything in it.
      */}
      <TaskSelectionProvider>
        {/* P11-05 — the skeleton yields to the list rather than being replaced
            by it. This is the busiest boundary in the app: it re-resolves on
            every filter, every list switch and every status change. */}
        <Suspense
          fallback={
            <RevealFallback>
              <div role="status" aria-busy="true">
                <span className="sr-only">Loading tasks…</span>
                <TaskStatusGroupSkeleton />
              </div>
            </RevealFallback>
          }>
          <Reveal>
          <TaskGroups
            params={params}
            context={context}
            view={view}
            kind={kind}
            priorityFilter={priorityFilter}
            listsPromise={listsPromise}
            pendingRequestsPromise={pendingRequestsPromise}
          />
          </Reveal>
        </Suspense>
      </TaskSelectionProvider>
      </TaskColumnsProvider>
    </PageShell>
  );
}

/**
 * The breadcrumb's list name, waiting on the lists read alone.
 *
 * Renders null either way — `BreadcrumbLabel` only sets a context value — so it
 * contributes no markup and cannot shift the layout when it resolves.
 */
async function ListCrumb({
  listId,
  listsPromise,
}: {
  listId: string;
  listsPromise: Promise<ListsResult>;
}) {
  const { data: lists } = await listsPromise;
  const name = (lists ?? []).find((list) => list.id === listId)?.name;

  return name ? <BreadcrumbLabel value={name} /> : null;
}

/** The filter panel and the two reads that populate it. Nothing else. */
async function TaskFiltersSection({
  listsPromise,
  groupsPromise,
}: {
  listsPromise: Promise<ListsResult>;
  groupsPromise: Promise<GroupsResult>;
}) {
  const [{ data: lists }, { data: groups }] = await Promise.all([listsPromise, groupsPromise]);

  /*
   * ⚠️ P11-06 — PERSONAL LISTS ARE DROPPED HERE AND NOWHERE ELSE, and the split
   * is the point.
   *
   * `listsPromise` has THREE readers (see the note where it is built): this
   * panel, the breadcrumb, and the row labels on the table. The other two NEED
   * personal lists in it — standing in one, `ListCrumb` is what puts its name in
   * the breadcrumb, and without it the crumb reads "Tasks" over your own list.
   * So the filter is applied to this reader alone rather than to the query.
   *
   * Why drop them from the FILTER at all: this panel narrows a department's
   * board, and it sits next to a folder filter no personal list can ever match.
   * The rail's Personal lists group is the way into one, deliberately — Amier,
   * 8 Sep: "i want i can only see it under the personal lists".
   */
  const departmentLists = (lists ?? []).filter((list) => list.owner_id === null);

  return <TaskFilters lists={departmentLists} groups={groups ?? []} />;
}

/** The Gate 1 queue, waiting on `loadPendingRequests` and nothing else. */
async function PendingRequests({
  pendingRequestsPromise,
}: {
  pendingRequestsPromise: Promise<PendingRequest[]>;
}) {
  const pendingRequests = await pendingRequestsPromise;

  return <PendingRequestList requests={pendingRequests} />;
}

/**
 * The stages, and every query that costs anything.
 *
 * Split out of the page purely so it can stream. Nothing about the query, the
 * filters or the derivations below changed on the way here — they are the same
 * lines in the same order, and the only thing they lost was the ability to hold
 * the toolbar off the screen while they ran.
 *
 * `view`, `kind` and `priorityFilter` are read on the page rather than here
 * because the pending-request call needs the same three, and two readings of
 * "what does `?kind=` mean" is exactly one too many.
 */
async function TaskGroups({
  params,
  context,
  view,
  kind,
  priorityFilter,
  listsPromise,
  pendingRequestsPromise,
}: {
  params: TasksSearchParams;
  context: AuthContext;
  view: View;
  kind: Kind;
  priorityFilter: TaskPriority | null;
  listsPromise: Promise<ListsResult>;
  pendingRequestsPromise: Promise<PendingRequest[]>;
}) {
  const supabase = await createClient();

  /* `undefined` when the URL named no sort we recognise, and that distinction is
     load-bearing: it decides whether `?dir=` is obeyed at all, so it cannot be
     collapsed into `sort`. */
  const requested: Sort | undefined = isSort(params.sort) ? params.sort : undefined;
  const sort: Sort = requested ?? DEFAULT_SORT.sort;

  /*
   * P7-18 — filtering by FOLDER needs an embed, not an `.eq()`.
   *
   * A task carries `list_id` and never `group_id` (deliberately: a task holding
   * its own folder would be a second source of truth that disagrees with its
   * list the first time a list moves). So the folder is reached through the
   * list, and PostgREST does that with an embedded filter.
   *
   * `!inner` is what makes the filter actually restrict rather than just
   * decorate the rows — and it also drops tasks with no list at all, which is
   * right when a folder is selected, since a task with no list has no folder.
   * That is also why the embed is CONDITIONAL: always-on `!inner` would silently
   * hide every list-less task from the unfiltered board.
   *
   * Resolved in the same round trip rather than by fetching the folder's list
   * ids first — the lists query sits in the same `Promise.all` as this one, so
   * reading it first would make the slow query wait on the fast one.
   */
  const TASK_COLUMNS =
    "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, created_by, list_id, request_id, is_personal, priority, estimate_minutes, parent_task_id, resolution";

  let query = supabase
    .from("vizserve_pms_tasks")
    .select(
      params.group ? `${TASK_COLUMNS}, vizserve_pms_lists!inner(group_id)` : TASK_COLUMNS,
    );

  /*
   * J — SORTING, or the column is decoration.
   *
   * `priority` is a Postgres enum declared LOW → HIGH, so `descending` is
   * highest-first with no CASE and no lookup table — the same trick the role
   * enum relies on. `nullsFirst: false` is what puts the unranked majority at
   * the bottom instead of on top of the urgent work.
   *
   * Due date stays the default. A queue is read by deadline most days; priority
   * is the question you ask when there is more work than time.
   */
  /*
   * P7-65 — ONE SOURCE FOR THE DIRECTION.
   *
   * An explicit sort obeys `?dir=` — ascending unless it says otherwise, which
   * is why the table leaves `asc` out of the URL — and no explicit sort takes
   * the default's. This used to read the direction off the COLUMN NAME instead,
   * so a click on "Priority" wrote `?sort=priority` with no `dir`, the header
   * drew an ascending arrow and the server returned descending rows, and that
   * column could not be sorted ascending at all.
   *
   * Priority still reads highest-first where it is meant to: the toolbar Select
   * writes `dir=desc` beside it, because that is now the only thing that says
   * so.
   */
  const ascending = requested ? params.dir !== "desc" : DEFAULT_SORT.ascending;

  /*
   * ⚠️ A LITERAL COLUMN PER KEY, NEVER `.order(params.sort)`. `?sort=` is a
   * string somebody can type, and an unknown column name reaches Postgres as
   * `invalid input value` and 500s the page.
   */
  const ORDER_COLUMN: Record<Sort, string> = {
    due: "due_date",
    priority: "priority",
    title: "title",
    start: "start_date",
    estimate: "estimate_minutes",
  };

  query = query
    // `nullsFirst: false` is what puts the unranked, undated majority at the
    // bottom instead of on top of the work that has a deadline.
    .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
    // A stable tie-break, so two tasks due the same day do not swap places
    // between renders.
    .order("created_at", { ascending: false });

  if (isTaskStatus(params.status)) query = query.eq("status", params.status);
  if (params.list) query = query.eq("list_id", params.list);
  if (params.group) query = query.eq("vizserve_pms_lists.group_id", params.group);
  if (priorityFilter) query = query.eq("priority", priorityFilter);
  if (kind === "client") query = query.not("request_id", "is", null);
  if (kind === "internal") query = query.is("request_id", null);
  /*
   * P7-43 semantics, P9-05 mechanism. "Mine" is the accountable name PLUS, on
   * internal tasks only, being on the task at all — internal work has no person
   * in charge, so membership is the whole of the claim.
   *
   * ⚠️ A COMPUTED COLUMN, not a filter assembled here. This was
   * `.or(mineFilter(userId, joinedTaskIds))`, which put every joined task id in
   * the URL — 16,542 characters for a user with 444 of them, and `fetch` failed
   * with no status code. `data ?? []` below turned that into an empty board.
   * `is_mine` answers the same question in Postgres and sends nothing but a
   * boolean, so this query keeps its six filters, its sort and its tie-break.
   */
  if (view === "mine") query = query.eq(MINE_COLUMN, true);
  // P3-08 — the QA queue is a view of this list, not a separate screen with a
  // separate set of rules that can drift from it.
  if (view === "qa") {
    query = query.eq("qa_assignee_id", context.userId).in("status", ["FOR_QA", "QA_IN_PROGRESS"]);
  }

  const [
    { data: tasks, error: tasksError },
    { data: people },
    { data: lists },
    pendingRequests,
  ] = await Promise.all([
    query,
    supabase.from("vizserve_pms_users").select("id, full_name, primary_department_id, is_active"),
    /* Both of these were fired on the page, before this component was rendered.
       Awaiting them here costs nothing and keeps them in the same wave as the
       two queries above — they are simply no longer the reason anything else on
       the page has to wait. */
    listsPromise,
    pendingRequestsPromise,
  ]);

  /*
   * `as unknown` first, and only because the select string is CONDITIONAL.
   *
   * supabase-js types a query by parsing the select string at the type level,
   * and it can only do that for a literal. The ternary above hands it a union of
   * two, which it reports as a ParserError — a type-level complaint about a
   * string, not a claim that the rows are wrong. The columns are identical
   * either way; the embed adds a `vizserve_pms_lists` key that nothing here
   * reads.
   *
   * Widening the cast is the cost of one round trip instead of two. The
   * alternative — two literal branches — means maintaining the fifteen-column
   * list twice, which drifts the first time somebody adds a column to one.
   */
  const rows = (tasks ?? []) as unknown as TaskRow[];
  const taskIds = rows.map((task) => task.id);

  /*
   * Three queries against the visible ids, run together.
   *
   * All three are scoped by `.in()` on ids the policy has ALREADY returned, so a
   * task somebody cannot see cannot have its comments, its children or its hours
   * pulled in through the back door — and each of the three has its own policy
   * underneath this anyway.
   */
  const [
    { data: commentRows },
    { data: childRows },
    { data: trackedRows },
    { data: coverageRows },
    { data: assigneeRows },
    { data: closedRows },
  ] = taskIds.length
    ? await Promise.all([
        /*
         * P7-08 / K5 — every comment on every visible task, in ONE query.
         *
         * A query per row is an N+1 on the page people leave open all day, and
         * the cell needs the whole thread rather than just the last line:
         * clicking it opens the conversation in place, so fetching only the
         * latest would mean a second round trip on every open.
         */
        supabase
          .from("vizserve_pms_task_comments")
          .select("id, task_id, body, author_id, created_at, updated_at")
          .in("task_id", taskIds)
          .order("created_at", { ascending: true }),

        /*
         * K5 — PROGRESS COMES FROM THE SUBTASKS, and it is fetched rather than
         * derived from `rows`.
         *
         * Deriving it from what is already on screen would be wrong under every
         * filter: a status filter or the `mine` view hides most children, so a
         * parent would report 1/1 done because that is all the page happened to
         * load. P7-09 is one level deep and trigger-enforced, so this is a
         * single flat query — no recursion, and no stored counter to drift.
         */
        supabase.from("vizserve_pms_tasks").select("id, parent_task_id, status").in("parent_task_id", taskIds),

        /*
         * P7-15 / K5 — TIME TRACKED CANNOT BE A PLAIN SUM. This is the trap.
         *
         * `vizserve_pms_timesheet_entries`' SELECT policy is owner-or-their-lead,
         * so a member summing that table for a task sees only the hours THEY
         * logged and calls it the task total. Two people on one task would read
         * two different figures on the same row and a lead a third. Nobody
         * reports that as a bug; they quietly stop trusting the column.
         *
         * So it is a SECURITY DEFINER rollup that sums inside and returns a row
         * only for tasks the caller may already see — same shape and same reason
         * as `vizserve_pms_leave_calendar`.
         */
        supabase.rpc("vizserve_pms_task_time_tracked", { p_task_ids: taskIds }),

        /*
         * P9-01 — who is holding which of these while somebody is away.
         *
         * `vizserve_pms_active_task_coverage` already filters to APPROVED leave
         * whose dates contain today in Manila, so this is a lookup rather than a
         * date calculation, and it is scoped to the ids on screen.
         *
         * ⚠️ ON THE LIST AND NOT ONLY THE DETAIL. "The person whose name is on
         * this row is away until Friday" is exactly the fact somebody scanning a
         * board needs, and it is the one place they will not think to open the
         * task to find out. Ordinarily this returns nothing at all.
         *
         * `security_invoker`, so a reader who cannot see the leave request
         * behind it gets no row — which is right for a request whose reason they
         * have no business reading.
         */
        supabase
          .from("vizserve_pms_active_task_coverage")
          .select("task_id, reliever_id, end_date")
          .in("task_id", taskIds),

        /*
         * P7-13 — everyone on the visible tasks, in one query.
         *
         * The row shows the accountable name and a `+n`, so it needs the join
         * table as well as `assignee_id`. The table has its own policy; this is
         * scoped by `.in()` on ids the tasks policy has already returned.
         */
        supabase.from("vizserve_pms_task_assignees").select("task_id, user_id").in("task_id", taskIds),

        /*
         * K5 — DATE CLOSED, AND IT NEEDS NO COLUMN.
         *
         * `vizserve_pms_task_status_history` already records the move to
         * COMPLETED / COMPLETED_NO_RESPONSE with its timestamp, so reading it
         * from there is one query and cannot disagree with the trail — which a
         * `completed_at` column eventually would.
         *
         * Ordered ASCENDING and reduced by last-write-wins below, so a REOPENED
         * task (P7-06 lets internal work go COMPLETED → ONGOING) reports the
         * date it was closed MOST RECENTLY rather than the first time. It is
         * nullable in practice for exactly that reason: a task can be closed,
         * reopened, and be live again with a closing date in its past.
         */
        supabase
          .from("vizserve_pms_task_status_history")
          .select("task_id, to_status, created_at")
          .in("task_id", taskIds)
          .in("to_status", ["COMPLETED", "COMPLETED_NO_RESPONSE"])
          .order("created_at", { ascending: true }),
      ])
    : // ⚠️ ONE ENTRY PER QUERY ABOVE, and the compiler says so only indirectly:
      // a short tuple here does not error on this line, it mis-binds every
      // destructured name after the gap and reports the type mismatch several
      // hundred lines away. P9-01's coverage read is the sixth.
      [
        { data: [] },
        { data: [] },
        { data: [] },
        { data: [] },
        { data: [] },
        { data: [] },
      ];

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));
  /* Plain objects from here on: a Map cannot cross the RSC boundary. */
  const listName = new Map((lists ?? []).map((list) => [list.id, list.name]));

  // Threads by task, oldest first — the order they were fetched in, so the cell
  // can take the last one without sorting again.
  const threads = new Map<string, TaskComment[]>();
  for (const row of commentRows ?? []) {
    const thread = threads.get(row.task_id) ?? [];
    thread.push({
      id: row.id,
      body: sanitizeRichText(row.body),
      authorId: row.author_id,
      authorName: nameOf.get(row.author_id) ?? "Someone no longer active",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    threads.set(row.task_id, thread);
  }

  /** `parent id → [done, total]`. Both counts, because a bar needs the ratio. */
  const progress = new Map<string, { done: number; total: number }>();
  for (const child of childRows ?? []) {
    if (!child.parent_task_id) continue;
    const entry = progress.get(child.parent_task_id) ?? { done: 0, total: 0 };
    entry.total += 1;
    // COMPLETED and COMPLETED_NO_RESPONSE both count as done. They are
    // deliberately distinct statuses, but "the work is finished" is true of both
    // and that is the only question a progress bar asks.
    if (isTerminal(child.status)) entry.done += 1;
    progress.set(child.parent_task_id, entry);
  }

  /** Everyone on a task besides its PIC, named. */
  const extraAssignees = new Map<string, { id: string; full_name: string }[]>();
  for (const row of assigneeRows ?? []) {
    const list = extraAssignees.get(row.task_id) ?? [];
    list.push({ id: row.user_id, full_name: nameOf.get(row.user_id) ?? "Someone no longer active" });
    extraAssignees.set(row.task_id, list);
  }

  /** The most recent close, from the trail. Ascending fetch, last one wins. */
  const closedOn = new Map<string, string>();
  for (const row of closedRows ?? []) closedOn.set(row.task_id, row.created_at);

  const tracked = new Map(
    ((trackedRows ?? []) as { task_id: string; minutes: number }[]).map((row) => [row.task_id, row.minutes]),
  );

  /*
   * P9-01. Keyed by task, carrying the covering person and the last day. The
   * name is resolved through `nameOf` in the row, like every other person on
   * this page — a second map of names would be a second thing to keep in step.
   */
  const coverage = new Map(
    (coverageRows ?? []).map((row) => [
      row.task_id,
      { relieverId: row.reliever_id, until: row.end_date },
    ]),
  );

  const isFiltered =
    Boolean(params.status || params.list || params.group || priorityFilter) ||
    view !== "all" ||
    kind !== "all";

  /*
   * Does this view actually hold both kinds of work?
   *
   * Read off the rows already fetched, so it costs nothing. Counted BEFORE the
   * grouping below, and on the unfiltered-by-status set, because the question
   * is "is there a split here to filter", not "is there one in the stage you
   * happen to have open".
   *
   * A pending request counts as client work: it is client work, and it is on
   * screen. Without it, a list showing three pending requests and two internal
   * chores would call itself single-kind.
   */

  /*
   * P7-09 — A SUBTASK LIVES UNDER ITS PARENT, NOT IN ITS OWN STAGE.
   *
   * It used to be pushed into the group for its own status, so moving a subtask
   * to Ongoing tore it out of the piece of work it belongs to and stranded it
   * three headings away from its parent. On a board that reads as the subtask
   * having been promoted to a task of its own, which is precisely what it is not.
   *
   * So a subtask renders indented beneath its parent, IN THE PARENT'S GROUP,
   * whatever its own status. Two exceptions, and both are the same idea:
   *
   *   * FINISHED subtasks leave the nest and join their own terminal group.
   *     That is what "done" means on a checklist — it stops being outstanding
   *     work under the parent and becomes a completed thing in its own right.
   *   * A subtask whose PARENT IS NOT ON SCREEN stays top level. Filters and
   *     the kind tabs can hide a parent, and nesting a row under something that
   *     is not rendered would delete it from the view entirely.
   */
  const visibleIds = new Set(rows.map((task) => task.id));
  const childrenByParent = new Map<string, TaskRow[]>();
  const nested = new Set<string>();

  for (const task of rows) {
    if (!task.parent_task_id) continue;
    if (isTerminal(task.status)) continue;
    if (!visibleIds.has(task.parent_task_id)) continue;

    const bucket = childrenByParent.get(task.parent_task_id) ?? [];
    bucket.push(task);
    childrenByParent.set(task.parent_task_id, bucket);
    nested.add(task.id);
  }

  /** `depth` is what the Task column indents on. Flat list, one level only. */
  const grouped = new Map<VizservePmsTaskStatus, ListRow[]>(
    TASK_STATUSES.map((status) => [status, [] as ListRow[]]),
  );

  for (const task of rows) {
    if (nested.has(task.id)) continue;

    const bucket = grouped.get(task.status);
    if (!bucket) continue;

    /*
     * P7-65 — NESTED, NOT FLATTENED.
     *
     * These used to be pushed as two sibling rows carrying a `depth` marker,
     * and the indent was the only thing that said one belonged to the other.
     * TanStack's expanded row model wants the real shape, so a parent now
     * carries its children and the table flattens them itself — which is what
     * lets a parent collapse.
     *
     * `subRows` is left UNDEFINED rather than `[]` on a childless task:
     * `getCanExpand()` is true for an empty array, and a chevron that opens
     * onto nothing is worse than no chevron.
     */
    const children = childrenByParent.get(task.id);
    bucket.push({
      ...task,
      depth: 0,
      subRows: children?.map((child) => ({ ...child, depth: 1 as const })),
    });
  }

  /**
   * Which headings to draw.
   *
   * A group is worth an empty heading only where a task could legitimately have
   * landed: it tells you the stage is clear rather than leaving you to wonder
   * whether the page failed to load it. So the set follows the FILTERS, not the
   * results — one group under a status filter, the two QA stages in the QA view,
   * and the full workflow otherwise.
   */
  const visibleStatuses: readonly VizservePmsTaskStatus[] = isTaskStatus(params.status)
    ? [params.status]
    : view === "qa"
      ? (["FOR_QA", "QA_IN_PROGRESS"] as const)
      : TASK_STATUSES;

  /**
   * Which seat the reader is in, per task.
   *
   * The status control needs this and it is cheap: two comparisons and a lookup
   * in a list that is almost always empty or one long. It is NOT an authorization
   * decision — `vizserve_pms_transition_task` re-checks every part of it — it
   * only decides which moves are worth offering.
   */
  /**
   * Who the composer may assign to.
   *
   * P7-14's rule, mirrored: a member may create work for somebody in their OWN
   * department, and a lead may do it in any department they lead. Themselves
   * excluded, because "Myself" is the composer's default rather than a row in
   * the list — picking yourself calls `create_personal_task` and produces a
   * different KIND of task, so the two must not look like the same choice.
   *
   * The server re-derives the department from whoever is picked and
   * `vizserve_pms_create_task` refuses one outside the caller's scope, so this
   * list is a convenience. Offering somebody unassignable would only produce an
   * error message after the fact.
   */
  const assignableScope = new Set(
    [context.primaryDepartmentId, ...context.managedDepartmentIds].filter((id): id is string => Boolean(id)),
  );

  const assignable = (people ?? [])
    .filter(
      (person) =>
        person.is_active &&
        person.id !== context.userId &&
        person.primary_department_id !== null &&
        (roleAtLeast(context.role, "owner") ||
          assignableScope.has(person.primary_department_id)),
    )
    .map((person) => ({ id: person.id, full_name: person.full_name }));

  /**
   * People by department, for the assignee picker.
   *
   * The task's OWN department decides who may join it — `add_task_assignee`
   * refuses anybody else — which is a different question from `assignable`
   * above, where the CALLER's scope decides who they may create work for.
   */
  const byDepartment = new Map<string, { id: string; full_name: string }[]>();
  for (const person of people ?? []) {
    if (!person.is_active || !person.primary_department_id) continue;
    const list = byDepartment.get(person.primary_department_id) ?? [];
    list.push({ id: person.id, full_name: person.full_name });
    byDepartment.set(person.primary_department_id, list);
  }

  /*
   * P7-64 — THE MAPS, FLATTENED FOR THE WIRE.
   *
   * Every lookup above is a `Map`, which does not survive the RSC boundary. The
   * table reads plain objects instead; `Object.fromEntries` is the whole
   * translation and it happens once, here, rather than eight times at the call
   * site.
   */
  const viewer = {
    userId: context.userId,
    role: context.role,
    managedDepartmentIds: context.managedDepartmentIds,
    /*
     * P8-01c — the Admin tick, resolved HERE rather than shipped as the raw
     * `is_dept_admin` column.
     *
     * `canAdminDepartment` is the single TypeScript reading of
     * `vizserve_pms_is_dept_admin`, and it lives in a `server-only` module, so
     * the boolean has to be answered on this side of the wire. Sending the flag
     * instead would put a second reading of the capability in a client
     * component — which is the "scattered `if (role === 'admin')`" CLAUDE.md
     * exists to forbid, one capability later.
     */
    deptAdminOf: canAdminDepartment(context, context.primaryDepartmentId)
      ? context.primaryDepartmentId
      : null,
    /* P11-05 — the department this person BELONGS to, compared against each
       task's own on the client. Raw, unlike `deptAdminOf` above: this one
       carries no capability by itself, it is one half of a comparison. */
    primaryDepartmentId: context.primaryDepartmentId,
  };

  const lookups = {
    nameOf: Object.fromEntries(nameOf),
    listName: Object.fromEntries(listName),
    threads: Object.fromEntries(threads),
    progress: Object.fromEntries(progress),
    extraAssignees: Object.fromEntries(extraAssignees),
    closedOn: Object.fromEntries(closedOn),
    tracked: Object.fromEntries(tracked),
    coverage: Object.fromEntries(coverage),
    byDepartment: Object.fromEntries(byDepartment),
  };


  /*
   * Three messages, because there are three ways of arriving at an empty
   * screen and only two of them are somebody's fault: a filter that is too
   * narrow needs loosening, an empty system needs explaining, and a failed
   * query needs saying out loud rather than being dressed up as either of
   * the others. Drawing eight empty stage headings in any of those cases
   * would bury the sentence that actually helps.
   *
   * Early returns rather than the nested ternary this used to be — the three
   * branches are unchanged, but they are now the whole output of a component
   * instead of one expression inside a page, and a ternary chain that spans a
   * hundred lines reads worse than three exits.
   */
  if (tasksError) return <QueryError what="tasks" message={tasksError.message} />;

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card grade-surface shadow-raised-lg">
        {isFiltered ? (
          <EmptyState
            icon={<ListChecks />}
            title={
              view === "qa"
                ? "Nothing waiting on your review"
                : view === "mine"
                  ? "No tasks assigned to you"
                  : "No tasks match these filters"
            }
            description={
              view === "qa"
                ? "No work is sitting in QA with you as the reviewer. Switch to All to see the rest of the list."
                : view === "mine"
                  ? "Nothing is currently yours to move. Switch to All to see the rest of your department's work."
                  : "Clear the status, list or priority filter to see the rest of the list."
            }
          />
        ) : (
          <EmptyState
            icon={<ListChecks />}
            title={pendingRequests.length > 0 ? "Nothing approved yet" : "Nothing here yet"}
            // ⚠️ Two sentences, because this heading can now sit directly
            // under a list of requests waiting to be approved — and "tasks
            // appear once a Team Leader approves a request" reads as a
            // brush-off when the reader IS the team leader and the requests
            // are on screen above it.
            description={
              pendingRequests.length > 0
                ? "The requests above have not been approved yet. Approving one creates the task and files it in a list."
                : "Tasks appear once a Team Leader approves a request, or when one is added by hand. Each moves through set stages — the server refuses any step that is not one of them."
            }
          />
        )}
      </div>
    );
  }

  return (
    /*
     * P11-05 — THE BUCKETS ARE ASSIGNED IN THE BROWSER NOW.
     *
     * The server still does the expensive half above: the query, the filters and
     * the parent/child nesting. What it no longer decides is which heading a row
     * sits under at this instant — that moved into `<TaskStatusGroups>` so a
     * status change moves the row on click rather than 2–3 seconds later, once
     * this page had re-run all fourteen of its queries.
     *
     * `grouped` is a Map and a Map does not cross the RSC boundary
     * (`components/data-table.tsx` carries the same warning), so it is handed
     * over as a plain object.
     */
    <TaskStatusGroups
      groups={Object.fromEntries(grouped)}
      visibleStatuses={visibleStatuses}
      viewer={viewer}
      lookups={lookups}
      assignable={assignable}
    />
  );
}
