"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { FilterBarSkeleton, TaskStatusGroupSkeleton } from "@/components/skeletons";
import { isTaskStatus } from "@/components/status-badge";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { browserClient } from "@/lib/query/browser-client";
import { fetchDirectory, fetchVisibleLists } from "@/lib/query/fetchers/task";
import {
  fetchPendingRequests,
  fetchTaskFolders,
  fetchTaskListView,
  type TaskListView,
  type TaskViewKind,
  type TaskViewScope,
} from "@/lib/query/fetchers/task-list";
import { qk } from "@/lib/query/keys";
import { roleAtLeast } from "@/lib/auth/roles";
import { sanitizeRichTextInBrowser } from "@/lib/rich-text-dom";
import { pendingRequestsApply } from "@/lib/schemas/approvals";
import type { DirectoryPerson } from "@/lib/schemas/task-list";
import {
  isTerminal,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
} from "@/lib/schemas/tasks";

import type { TaskComment } from "./comment-thread";
import { TaskFilters } from "./filters";
import { NewTaskButton } from "./new-task-button";
import { PendingRequestList } from "./pending-requests";
import { TaskSelectionProvider } from "./task-selection";
import { TaskStatusGroups } from "./task-status-groups";
import {
  TaskColumnsMenu,
  TaskColumnsProvider,
  type ListRow,
  type TaskRow,
  type Viewer,
} from "./tasks-table";
import { TaskToolbar } from "./toolbar";

/**
 * P3-03 / P3-14 / P12-07 — the task list, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * This was a 1,156-line RSC: a row query, then a six-query batch against the ids
 * it returned, then every derivation below, all behind ONE cache entry — the
 * route's own render. Ticking a priority on one row therefore re-read the
 * comments, the subtasks, the time rollup, the coverage view, the assignee join
 * and the closed-date history for every row on screen, and re-rendered the shell
 * above them, because `revalidatePath` has no smaller unit than a route. The
 * reads are now five query keys (`lib/query/fetchers/task-list.ts` argues which
 * key owns which read) and a write invalidates the ones it actually moved.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. `requireAuthContext()` — the
 * temporary-password wall, the `app_access` gate, the deactivation check — runs
 * in `page.tsx` beside this, and the redirect for the bare route runs there too.
 * Everything derived from the auth context arrives here as `viewer`, computed on
 * the server: `canAdminDepartment` lives in a `server-only` module, so the Admin
 * tick has to be resolved on that side of the wire. No decision about what
 * anybody may see is made in this file — `lib/schemas/tasks.ts` says in capitals
 * that `viewer` is PRESENTATION ONLY, and every rule here is re-checked in
 * `vizserve_pms_transition_task` and in both tasks policies.
 *
 * ⚠️ AND NOTHING ABOUT THE QUERY, THE FILTERS OR THE DERIVATIONS CHANGED ON THE
 * WAY. They are the same lines in the same order, minus the `?? []`s that a
 * throwing `read()` makes unnecessary. What they lost is the ability to hold the
 * toolbar off the screen while they run — and what they gained is that a status
 * change repaints from the cache instead of from a fourteen-query route render.
 *
 * ⚠️ THE SUSPENSE BOUNDARIES ARE GONE, AND WITH THEM `Reveal`/`RevealFallback`.
 * They were streaming a server render; there is no server render here to stream.
 * Each region now paints from its own query's `isPending`, which is the same
 * staging with the same skeletons and no router involvement. The P11-05 handoff
 * animation went with them rather than being faked: `<ViewTransition>` animates a
 * React transition, and a query settling is not one, so keeping the wrapper
 * would have been inert markup pretending to be a fade. `/tasks/[id]` dropped it
 * in Phase 3a for the same reason.
 * ------------------------------------------------------------------------
 */

/**
 * The URL contract, unchanged and still the shareable source of truth.
 *
 * Read on the server, passed down as a prop, and handed to `qk.taskList` /
 * `qk.taskView` as the filter half of the key. Deliberately NOT re-read here
 * with `useSearchParams`: the page already awaited them, and two readings of the
 * same URL is how a key and a query drift by one navigation.
 */
export type TasksSearchParams = {
  status?: string;
  view?: string;
  list?: string;
  group?: string;
  kind?: string;
  priority?: string;
  sort?: string;
  dir?: string;
};

function isPriority(value: string | undefined): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

export function TasksView({
  params,
  viewer,
  realtimeFilter,
}: {
  params: TasksSearchParams;
  /** Every role and department decision, made on the server. See `page.tsx`. */
  viewer: Viewer;
  /** `realtimeDepartmentFilter(context)`, computed with the rest of the seat. */
  realtimeFilter: string | null;
}) {
  const view: TaskViewScope =
    params.view === "mine" || params.view === "qa" ? params.view : "all";

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
  const kind: TaskViewKind =
    params.kind === "internal" || params.kind === "client" ? params.kind : "all";
  const priorityFilter = isPriority(params.priority) ? params.priority : null;
  const status = isTaskStatus(params.status) ? params.status : null;

  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still RENDERED ON THE SERVER for its initial
   * HTML, and `createBrowserClient` reaches for `document.cookie` — which is why
   * that helper is lazy, and why calling it up here would move that reach into
   * the server pass. A `queryFn` only ever runs in the browser.
   */

  /*
   * ⚠️ TWO KEYS FOR ONE FETCHER, AND WHICH ONE IS NOT A DETAIL.
   *
   * A list is `qk.taskList(listId, filters)`; the two CROSS-LIST views are
   * `qk.taskView(view, filters)`, because "what is on me" and "what am I
   * reviewing" are questions no single list can answer and filing them under a
   * list id would mean inventing one. `page.tsx` redirects the bare route, so
   * reaching here with neither is not possible — and the `as` below is that
   * guarantee written down rather than a cast over a doubt.
   */
  const rowsQuery = useQuery({
    queryKey: params.list
      ? qk.taskList(params.list, params)
      : qk.taskView(view as "mine" | "qa", params),
    queryFn: () =>
      fetchTaskListView(browserClient(), {
        listId: params.list ?? null,
        view,
        kind,
        status,
        groupId: params.group ?? null,
        priority: priorityFilter,
        sort: params.sort,
        dir: params.dir,
        userId: viewer.userId,
      }),
  });

  /*
   * The staff directory, under `qk.ref("users")` — the same entry `/tasks/[id]`
   * reads, so opening a task from this list costs nothing to name its people.
   */
  const peopleQuery = useQuery({
    queryKey: qk.ref("users"),
    queryFn: () => fetchDirectory(browserClient()),
  });

  /*
   * ⚠️ ONE LISTS READ WITH THREE CONSUMERS, exactly as the RSC had. The
   * breadcrumb, the filter panel and the row labels all want it, and it is one
   * query because they share a cache entry rather than because anybody remembered
   * to pass a promise around.
   */
  const listsQuery = useQuery({
    queryKey: qk.listsVisible(),
    queryFn: () => fetchVisibleLists(browserClient()),
  });

  const foldersQuery = useQuery({
    queryKey: qk.ref("task-groups"),
    queryFn: () => fetchTaskFolders(browserClient()),
  });

  /*
   * P7-26 — the requests that have not been decided yet.
   *
   * ⚠️ IT CANNOT FAIL THE PAGE, AND IT NO LONGER FAILS SILENTLY EITHER. This is
   * an ADDITION to a page whose job is tasks: its own key, its own error state,
   * and the rows beside it are unaffected by either. The server version returned
   * `[]` on failure, which met the first half of that and rendered the second
   * half as "nothing waiting" — the P12-01 bug in the one place on this page
   * where an empty list is the ordinary case.
   *
   * `enabled` rather than a fetch-and-discard: `pendingRequestsApply` is the
   * pure, unit-tested rule for whether a request can answer this page's filters
   * at all, and a view it cannot answer should issue no query.
   */
  const showsPending = pendingRequestsApply({
    kind,
    scope: view,
    hasTaskOnlyFilter: Boolean(params.status || priorityFilter || params.group),
  });

  const pendingQuery = useQuery({
    queryKey: qk.pendingRequests({
      list: params.list,
      kind: params.kind,
      view: params.view,
      // The rule is "any task-only filter hides these", so the KEY records the
      // answer rather than the three values that produced it.
      taskOnly: params.status || priorityFilter || params.group ? "1" : undefined,
    }),
    queryFn: () =>
      fetchPendingRequests(browserClient(), {
        listId: params.list ?? null,
        kind,
        scope: view,
        hasTaskOnlyFilter: Boolean(params.status || priorityFilter || params.group),
      }),
    enabled: showsPending,
  });

  const people = peopleQuery.data ?? [];
  const lists = listsQuery.data ?? [];
  const pendingRequests = pendingQuery.data ?? [];

  const listName = new Map(lists.map((list) => [list.id, list.name]));
  const nameOf = new Map(people.map((person) => [person.id, person.full_name]));

  /*
   * ⚠️ P11-06 — PERSONAL LISTS ARE DROPPED FROM THE FILTER PANEL AND NOWHERE
   * ELSE, and the split is the point.
   *
   * The lists read has THREE readers: this panel, the breadcrumb, and the row
   * labels on the table. The other two NEED personal lists in it — standing in
   * one, the breadcrumb is what puts its name at the top of the page, and
   * without it the crumb reads "Tasks" over your own list. So the filter is
   * applied to this reader alone rather than to the query.
   *
   * Why drop them from the FILTER at all: this panel narrows a department's
   * board, and it sits next to a folder filter no personal list can ever match.
   * The rail's Personal lists group is the way into one, deliberately — Amier,
   * 8 Sep: "i want i can only see it under the personal lists".
   */
  const departmentLists = lists.filter((list) => list.owner_id === null);

  const crumb = params.list ? listName.get(params.list) : undefined;

  return (
    <PageShell>
      {/*
        P8-03 — the list refreshes itself when a task in one of this person's
        departments changes.

        Renders nothing, and patches no row into client state — the payload is
        thrown away unread and the data comes back through a scoped read.

        ⚠️ P12-07 CLOSED THE GAP P12-02 OPENED HERE. That change narrowed the
        ping from `router.refresh()` to invalidating `qk.tasks()` and
        `qk.snapshot()`, and noted that only the rail observed either — so a
        COLLEAGUE's change moved the sidebar counts and left these rows alone
        until you navigated. `qk.taskList` and `qk.taskView` live under
        `["tasks"]`, so the rows are observing it now and a colleague's move
        repaints them. Do not put `router.refresh()` back in the hook: that is
        the three-renders-per-mutation storm P12-02 removed.

        The scope comes from `realtimeDepartmentFilter`, which is narrower than
        the SELECT policy on purpose: a task assigned to you in another
        department is visible here and will not push. See the doc comment there
        — the failure is a stale row, never a leaked one.
      */}
      <RealtimeTasks filter={realtimeFilter} />

      {/* Which list you are in, in the breadcrumb. Since the Tasks nav group was
          removed, a list is opened from the project tree and List/Board are two
          shapes of it, so the page has to name the list rather than leaving the
          crumb reading "Tasks" over somebody else's work.

          Only when the id resolves: a stale `?list=` from a bookmark whose list
          has since been archived should not put an empty label in the crumb —
          `fetchVisibleLists` filters `is_active`, so an archived list is absent
          here and the crumb stays generic, which is the behaviour that note has
          described since it was written. */}
      {crumb ? <BreadcrumbLabel value={crumb} /> : null}

      {/* Wraps the toolbar AND the groups: the menu lives in the filter row and
          the tables it controls are further down, so the provider has to span
          both. It is a client context holding which columns you hid; it stays
          ABOVE every conditional branch below, never inside one, or the
          skeleton-to-content swap would remount it and reset the setting. */}
      <TaskColumnsProvider>
        {/* Zero data between here and the first query, so this row is usable
            while the rows are still in flight: the view tabs and New Task are
            live before a single row has been read. */}
        <div className="flex flex-wrap items-center gap-2">
          <TaskToolbar view="list" />
          <div className="ml-auto">
            {/* The list being read, so a task made here lands in it. */}
            <NewTaskButton viewer={viewer} listId={params.list ?? null} />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {/*
            THE FILTER PANEL, WAITING ON ITS OWN TWO QUERIES AND NOTHING ELSE.

            It needs the lists and the folders — two small indexed reads that
            land long before the row batch does. Behind the same gate as the
            groups it would have sat dark for the whole wait, which is exactly
            the wrong way round: the filter panel is what somebody reaches for
            when the list is taking too long.

            `fields={2}` is the placeholder `app/(app)/tasks/loading.tsx` already
            draws, so a navigation and an in-page refresh look identical.

            ⚠️ `role="status"`, and this is the distinction the file-level note in
            components/skeletons.tsx exists to draw: `loading.tsx` is announced
            by the ROUTER, and a placeholder rendered inside a page is announced
            by nothing at all. The grey bars stay `aria-hidden` — enumerating
            them helps nobody — and the label is what speaks.
          */}
          {listsQuery.isError || foldersQuery.isError ? (
            /* ⚠️ A SENTENCE, NOT AN EMPTY DROPDOWN. A filter panel offering no
               lists says this department has none, which is a claim about the
               data rather than about the read. Same call `/tasks/[id]` makes
               for a failed directory: the region reports itself and the rest of
               the page carries on. */
            <p role="alert" className="text-xs text-destructive">
              The filters could not be loaded, so the list and folder pickers are
              not offered. This is a fault, not an empty department.{" "}
              {(listsQuery.error ?? foldersQuery.error)?.message}
            </p>
          ) : listsQuery.isPending || foldersQuery.isPending ? (
            <div role="status" aria-busy="true">
              <span className="sr-only">Loading filters…</span>
              <FilterBarSkeleton fields={2} />
            </div>
          ) : (
            <TaskFilters lists={departmentLists} groups={foldersQuery.data ?? []} />
          )}

          {/* One menu for all eight group tables — see `TaskColumnsProvider`. */}
          <div className="ml-auto">
            <TaskColumnsMenu />
          </div>
        </div>

        {/*
          THE QUEUE, ABOVE THE STAGES — and OUTSIDE the empty-state branch below.

          ⚠️ Putting this inside the `rows.length === 0` branch is the obvious
          placement and it is wrong: a department with three requests waiting and
          no tasks yet would render "Nothing here yet" and hide the very thing it
          is waiting on, which is the exact bug this feature exists to fix.

          Above the stages because a queue is read before the work. "Open" being
          the first heading on the page while three requests sit unlooked-at is
          how a request waits a week.

          Renders nothing for a member — `vizserve_pms_requests` is readable only
          by a lead of the form's department, so the array is empty and the
          component returns null. No role check here.

          ⚠️ AND NOTHING AT ALL WHILE IT LOADS, which is the one region with no
          placeholder. On most loads it resolves to nothing — a member has no
          readable requests and a lead usually has an empty queue — so a skeleton
          here would be a block that flashes and then vanishes, and a polite
          "loading" that resolves to silence is worse than saying nothing. There
          is no layout to reserve for a region whose ordinary size is zero.
        */}
        {showsPending && pendingQuery.isError ? (
          <p role="alert" className="text-xs text-destructive">
            The requests waiting for approval could not be loaded. This is a
            fault — it does not mean there are none.{" "}
            {pendingQuery.error.message}
          </p>
        ) : null}
        <PendingRequestList requests={pendingRequests} />

        {/*
          ⚠️ `TaskSelectionProvider` WRAPS EVERY BRANCH, never sits inside one,
          for the same reason `TaskColumnsProvider` does: it is a client context
          holding which rows are ticked, and remounting it clears the selection.
          It spans the empty and error branches harmlessly — `SelectionBar`
          renders null with nothing selected, and neither branch has a checkbox
          to put anything in it.
        */}
        <TaskSelectionProvider>
          <TaskGroups
            rowsQuery={rowsQuery}
            peopleQuery={peopleQuery}
            params={params}
            view={view}
            kind={kind}
            status={status}
            priorityFilter={priorityFilter}
            viewer={viewer}
            people={people}
            nameOf={nameOf}
            listName={listName}
            pendingCount={pendingRequests.length}
          />
        </TaskSelectionProvider>
      </TaskColumnsProvider>
    </PageShell>
  );
}

/**
 * The stages, and every derivation the rows feed.
 *
 * Split out of the view so the branching — loading, failed, empty, full — is one
 * component's whole output rather than four ternaries inside a page. Nothing
 * about the derivations changed on the way out of the RSC; they are the same
 * lines in the same order.
 */
function TaskGroups({
  rowsQuery,
  peopleQuery,
  params,
  view,
  kind,
  status,
  priorityFilter,
  viewer,
  people,
  nameOf,
  listName,
  pendingCount,
}: {
  rowsQuery: UseQueryResult<TaskListView, Error>;
  peopleQuery: UseQueryResult<DirectoryPerson[], Error>;
  params: TasksSearchParams;
  view: TaskViewScope;
  kind: TaskViewKind;
  status: VizservePmsTaskStatus | null;
  priorityFilter: TaskPriority | null;
  viewer: Viewer;
  people: DirectoryPerson[];
  nameOf: Map<string, string>;
  listName: Map<string, string>;
  pendingCount: number;
}) {
  /*
   * Three messages, because there are three ways of arriving at an empty screen
   * and only two of them are somebody's fault: a filter that is too narrow needs
   * loosening, an empty system needs explaining, and a failed query needs saying
   * out loud rather than being dressed up as either of the others. Drawing eight
   * empty stage headings in any of those cases would bury the sentence that
   * actually helps.
   *
   * ⚠️ THE FAILED CASE IS FIRST AND IT IS A `QueryError`, NOT A THROW. The
   * toolbar, the filter panel and the pending queue above are all still usable
   * — a failed row read is a failure of the LIST, not of the page — and
   * `app/(app)/error.tsx` would take the lot. The detail page makes the opposite
   * call for its own task row, and states it: without that row there is no page
   * to render. Here there is.
   */
  if (rowsQuery.isError) {
    return <QueryError what="tasks" message={rowsQuery.error.message} />;
  }

  /*
   * ⚠️ `isPending` IS "NO DATA YET", NOT "FETCHING". A background refetch over
   * data we already have must NOT throw the rows away and redraw a skeleton,
   * which is the flicker the whole cache exists to remove.
   *
   * ⚠️ AND THE DIRECTORY IS PART OF THE FIRST PAINT, which is not a preloading
   * preference. Every name on these rows is resolved through `nameOf`, and the
   * assignee cell renders a missing one as "—". Drawing the list before the
   * people are back would tell somebody eighty tasks are unassigned for as long
   * as that query takes — the same class of lie as a count of zero over a failed
   * read (P12-01). The two queries fire in parallel, so this waits on the slower
   * rather than on both in turn, and an ERROR in the directory is not pending:
   * the strip below reports it and the rows draw.
   */
  if (rowsQuery.isPending || peopleQuery.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading tasks…</span>
        <TaskStatusGroupSkeleton />
      </div>
    );
  }

  const data = rowsQuery.data;
  /*
   * ⚠️ ANNOTATED, NOT CAST, AND THAT IS DELIBERATE. `taskListRowSchema` and
   * `tasks-table.tsx`'s own `TaskRow` describe the same sixteen columns from two
   * directions — the contract and the component — and this line is where they
   * are checked against each other. An `as` here would compile through a column
   * added to one and not the other, which is exactly the drift the schema exists
   * to catch.
   */
  const rows: TaskRow[] = data.rows;

  // Threads by task, oldest first — the order they were fetched in, so the cell
  // can take the last one without sorting again.
  const threads = new Map<string, TaskComment[]>();
  for (const row of data.comments) {
    const thread = threads.get(row.task_id) ?? [];
    thread.push({
      id: row.id,
      /*
       * ⚠️ SANITISED HERE, WHERE THE ROW IS READ, AND IT USED TO BE THE SERVER
       * DOING IT. `comment-thread.tsx` is `"use client"` and paints this string
       * with `dangerouslySetInnerHTML`; its own note says the markup is trusted
       * "because of where it came from", and where it comes from is this line.
       * The read moved to the browser, so the pass moved with it — see
       * `lib/rich-text-dom.ts` for why dropping it was not an option.
       */
      body: sanitizeRichTextInBrowser(row.body),
      authorId: row.author_id,
      authorName: nameOf.get(row.author_id) ?? "Someone no longer active",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    threads.set(row.task_id, thread);
  }

  /** `parent id → [done, total]`. Both counts, because a bar needs the ratio. */
  const progress = new Map<string, { done: number; total: number }>();
  for (const child of data.children) {
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
  for (const row of data.assignees) {
    const list = extraAssignees.get(row.task_id) ?? [];
    list.push({ id: row.user_id, full_name: nameOf.get(row.user_id) ?? "Someone no longer active" });
    extraAssignees.set(row.task_id, list);
  }

  /** The most recent close, from the trail. Ascending fetch, last one wins. */
  const closedOn = new Map<string, string>();
  for (const row of data.closed) closedOn.set(row.task_id, row.created_at);

  const tracked = new Map(data.tracked.map((row) => [row.task_id, row.minutes]));

  /*
   * P9-01. Keyed by task, carrying the covering person and the last day. The
   * name is resolved through `nameOf` in the row, like every other person on
   * this page — a second map of names would be a second thing to keep in step.
   */
  const coverage = new Map(
    data.coverage.map((row) => [
      row.task_id,
      { relieverId: row.reliever_id, until: row.end_date },
    ]),
  );

  const isFiltered =
    Boolean(params.status || params.list || params.group || priorityFilter) ||
    view !== "all" ||
    kind !== "all";

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
    TASK_STATUSES.map((each) => [each, [] as ListRow[]]),
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
  const visibleStatuses: readonly VizservePmsTaskStatus[] = status
    ? [status]
    : view === "qa"
      ? (["FOR_QA", "QA_IN_PROGRESS"] as const)
      : TASK_STATUSES;

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
   *
   * ⚠️ `is_active` IS TESTED HERE AND NOT IN THE QUERY. `qk.ref("users")` holds
   * the whole directory on purpose — the people who leave are exactly the ones
   * whose old comments still need a name — so every consumer that offers
   * somebody a SEAT filters for itself. See `fetchDirectory`.
   */
  const assignableScope = new Set(
    [viewer.primaryDepartmentId, ...viewer.managedDepartmentIds].filter((id): id is string =>
      Boolean(id),
    ),
  );

  const assignable = people
    .filter(
      (person) =>
        person.is_active &&
        person.id !== viewer.userId &&
        person.primary_department_id !== null &&
        (roleAtLeast(viewer.role, "owner") ||
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
  for (const person of people) {
    if (!person.is_active || !person.primary_department_id) continue;
    const list = byDepartment.get(person.primary_department_id) ?? [];
    list.push({ id: person.id, full_name: person.full_name });
    byDepartment.set(person.primary_department_id, list);
  }

  /*
   * P7-64 — THE MAPS, FLATTENED.
   *
   * Every lookup above is a `Map`, and the table reads plain objects.
   * `Object.fromEntries` is the whole translation and it happens once, here,
   * rather than eight times at the call site. It was the RSC boundary that
   * demanded this originally — a Map does not survive it — and the table's prop
   * type outlived the boundary, which is fine: it is one shape either way.
   */
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
            title={pendingCount > 0 ? "Nothing approved yet" : "Nothing here yet"}
            // ⚠️ Two sentences, because this heading can now sit directly under
            // a list of requests waiting to be approved — and "tasks appear once
            // a Team Leader approves a request" reads as a brush-off when the
            // reader IS the team leader and the requests are on screen above it.
            description={
              pendingCount > 0
                ? "The requests above have not been approved yet. Approving one creates the task and files it in a list."
                : "Tasks appear once a Team Leader approves a request, or when one is added by hand. Each moves through set stages — the server refuses any step that is not one of them."
            }
          />
        )}
      </div>
    );
  }

  return (
    <>
      {/* ⚠️ A STRIP, NOT A REPLACEMENT FOR THE ROWS. A failed directory read
          leaves every name blank, which the assignee cell draws as "—" — so it
          has to say why, or eighty tasks read as unassigned. The tasks
          themselves are a different key and are fine. */}
      {peopleQuery.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Names could not be loaded, so people on these rows are shown as unnamed.
          Nobody has been unassigned — this is a fault. {peopleQuery.error.message}
        </p>
      ) : null}

      {/*
        P11-05 — THE BUCKETS ARE ASSIGNED IN THE BROWSER.

        The expensive half is still done before this line: the query, the filters
        and the parent/child nesting. What `<TaskStatusGroups>` owns is which
        heading a row sits under at this instant, so a status change moves the row
        on click rather than 2–3 seconds later, once the page had re-run all
        fourteen of its queries. That wait is what this phase removed; the
        optimism stays, because the refetch is still a round trip.
      */}
      <TaskStatusGroups
        groups={Object.fromEntries(grouped)}
        visibleStatuses={visibleStatuses}
        viewer={viewer}
        lookups={lookups}
        assignable={assignable}
      />
    </>
  );
}
