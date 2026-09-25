import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { TaskColumnsMenu, TaskColumnsProvider } from "./tasks-table";
import { isTaskStatus } from "@/components/status-badge";
import { canAdminDepartment, realtimeDepartmentFilter, requireAuthContext } from "@/lib/auth/authorization";
import { TASK_PRIORITIES, type TaskPriority } from "@/lib/schemas/tasks";
import { loadListFields } from "@/lib/list-fields-server";
import { ListFieldsSheet } from "./list-fields-sheet";
import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { FilterBarSkeleton } from "@/components/skeletons";
import { requestToday } from "@/lib/dates-server";
import { createClient } from "@/utils/supabase/server";

import { TaskSelectionProvider } from "./task-selection";
import { TaskFilters } from "./filters";
import { NewTaskButton } from "./new-task-button";
import { TaskListView } from "./task-list-view";
import { TaskToolbar } from "./toolbar";

export const metadata: Metadata = { title: "Tasks" };


/*
 * P7-65 / P12-07 — the sort (`?sort=`, `?dir=`) is applied in the query by
 * `fetchTaskListView` (lib/query/fetchers/task-list.ts), which now holds the
 * sortable columns and the default order. `tasks-table.tsx` passes the same
 * default to `DataTable` — change one and change the other.
 */
function isPriority(value: string | undefined): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Named rather than written inline on the page signature. The rows themselves
 * are read by `TaskListView` (P12-07) from the filters narrowed out of it.
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
  /**
   * P7-73 — a custom field's filter, `cf:<fieldId>`. Open-ended because the
   * keys are field ids; only a field of the list on screen is ever read.
   */
  [customField: `cf:${string}`]: string | undefined;
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
    | {
        id: string;
        name: string;
        group_id: string | null;
        owner_id: string | null;
        /** P13-01. Which department the list belongs to — see the select. */
        department_id: string;
      }[]
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
      //
      // P13-01. `department_id` likewise: the composer needs to know whether the
      // list being looked at is the shared space, because that is what decides
      // who may be assigned. An existing column, so it is safe to name here —
      // unlike `is_shared`, which is not (see `loadSharedDepartmentIds`).
      .select("id, name, group_id, owner_id, department_id")
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

  return (
    <PageShell>
      {/*
        P8-03 — the list refreshes itself when a task in one of this
        person's departments changes.

        Renders nothing. On a row event it invalidates the cached rows
        (`["tasks"]`), which `TaskListView` refetches under RLS with the same
        filters and sort, and refreshes this server page for the filter panel.
        No row is patched in from the payload.

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
          <TaskFiltersSection
            listId={params.list ?? null}
            listsPromise={listsPromise}
            groupsPromise={groupsPromise}
          />
        </Suspense>

        {/* One menu for all eight group tables — see `TaskColumnsProvider`.
            P7-73: with a list selected, its custom fields join the menu, and the
            list's field manager sits beside it. Behind its own boundary so the
            static menu is live before the fields are read. */}
        <div className="ml-auto flex items-center gap-2">
          {params.list ? (
            <Suspense fallback={<TaskColumnsMenu />}>
              <ListFieldControls listId={params.list} />
            </Suspense>
          ) : (
            <TaskColumnsMenu />
          )}
        </div>
      </div>

      {/*
        P12-07 — THE QUEUE AND THE STAGES ARE ONE CLIENT VIEW NOW, reading from
        the query cache (`task-list-view.tsx`). The queue still renders above the
        stages and outside the empty-state branch; the reasons travelled with it.
      */}

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
        <TaskListView
          filters={{
            listId: params.list ?? null,
            view,
            kind,
            status: isTaskStatus(params.status) ? params.status : null,
            group: params.group ?? null,
            priority: priorityFilter,
            sort: params.sort ?? null,
            dir: params.dir ?? null,
            fieldFilters: Object.fromEntries(
              Object.entries(params).filter(
                (entry): entry is [string, string] => entry[0].startsWith("cf:") && typeof entry[1] === "string",
              ),
            ),
          }}
          viewer={{
            userId: context.userId,
            role: context.role,
            managedDepartmentIds: context.managedDepartmentIds,
            deptAdminOf: canAdminDepartment(context, context.primaryDepartmentId)
              ? context.primaryDepartmentId
              : null,
            primaryDepartmentId: context.primaryDepartmentId,
          }}
          seat={{
            sharedDepartmentIds: context.sharedDepartmentIds,
            role: context.role,
            managedDepartmentIds: context.managedDepartmentIds,
            primaryDepartmentId: context.primaryDepartmentId,
          }}
          today={await requestToday()}
          // A server component renders once per request, so this is the fact
          // being reported, not an impure render. See `useRefetchOnServerRender`.
          // eslint-disable-next-line react-hooks/purity -- see the note above
          serverRenderedAt={Date.now()}
          baseFiltered={
            Boolean(params.status || params.list || params.group || priorityFilter) || view !== "all" || kind !== "all"
          }
        />
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
  listId,
  listsPromise,
  groupsPromise,
}: {
  listId: string | null;
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

  /*
   * ⚠️ AND INSIDE A PERSONAL LIST, NEITHER THE LIST NOR THE FOLDER FILTER RENDERS.
   *
   * `?list=` then names a list the dropdown was just told to leave out, so Base
   * UI had no label for the value and printed the raw uuid — over a menu of
   * every department list, none of which the page was showing. The folder
   * filter is no better: a personal list sits in no folder, so any choice there
   * empties the page. Leaving goes through the rail, the same way coming in did.
   */
  const inPersonalList = (lists ?? []).some((list) => list.id === listId && list.owner_id !== null);

  // P7-73. A list's fields filter the list, personal or not. `cache()`d — the
  // task groups read the same list's fields in this request.
  const { fields: customFields } = listId ? await loadListFields(listId) : { fields: [] };

  if (inPersonalList) return <TaskFilters lists={[]} groups={[]} customFields={customFields} />;

  return <TaskFilters lists={departmentLists} groups={groups ?? []} customFields={customFields} />;
}

/**
 * P7-73 — the Columns menu with the list's fields in it, and the field manager.
 *
 * `loadListFields` is `cache()`d, so the task groups reading the same list's
 * fields in this request share the one query.
 */
async function ListFieldControls({ listId }: { listId: string }) {
  const supabase = await createClient();

  const [{ fields }, { data: canManage }] = await Promise.all([
    loadListFields(listId, true),
    supabase.rpc("vizserve_pms_can_manage_list", { p_list_id: listId }),
  ]);

  return (
    <>
      <TaskColumnsMenu customFields={fields.filter((field) => field.is_active)} />
      {canManage ? <ListFieldsSheet listId={listId} fields={fields} /> : null}
    </>
  );
}
