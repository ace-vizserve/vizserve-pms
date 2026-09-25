"use client";

import { useQuery } from "@tanstack/react-query";

import { useRefetchOnServerRender } from "@/lib/query/use-refetch-on-server-render";
import { ListChecks } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { TaskStatusGroupSkeleton } from "@/components/skeletons";
import { assignableInList } from "@/lib/assignable";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { browserClient } from "@/lib/query/browser-client";
import { fetchVisibleLists } from "@/lib/query/fetchers/task";
import {
  fetchPendingRequests,
  fetchTaskListView,
  subtaskProgress,
  type TaskListFilters,
} from "@/lib/query/fetchers/task-list";
import { qk } from "@/lib/query/keys";
import { isTerminal, TASK_STATUSES } from "@/lib/schemas/tasks";
import { QA_STAGES } from "@/lib/task-scope";

import { PendingRequestList } from "./pending-requests";
import { TaskStatusGroups } from "./task-status-groups";
import type { ListRow, TaskRow, Viewer } from "./tasks-table";

/**
 * P12-07 — the list's rows, the Gate 1 queue above them, read from the cache.
 *
 * ⚠️ THIS IS `TaskGroups` AND `PendingRequests` FROM `page.tsx`, MOVED, NOT
 * REDESIGNED. The grouping, the one-level subtask nesting, the assignable set
 * and both empty states are the RSC's code over the same rows. The difference
 * is where the rows come from: `qk.taskListView(filters)`, so returning to a
 * list paints at once, and an inline edit refetches this one entry instead of
 * re-running the whole server page.
 *
 * ⚠️ AUTHORIZATION STAYS ON THE SERVER. `viewer` and `seat` are computed in
 * `page.tsx` from `AuthContext`; RLS scopes every read.
 */

export type TaskListSeat = {
  sharedDepartmentIds: string[];
  role: Viewer["role"];
  managedDepartmentIds: string[];
  primaryDepartmentId: string | null;
};

export function TaskListView({
  filters,
  viewer,
  seat,
  today,
  /** Any toolbar or URL filter besides a custom field's. */
  baseFiltered,
  serverRenderedAt,
}: {
  filters: TaskListFilters;
  viewer: Viewer;
  seat: TaskListSeat;
  today: string;
  baseFiltered: boolean;
  /** When the server last rendered the page. See `useRefetchOnServerRender`. */
  serverRenderedAt: number;
}) {
  useRefetchOnServerRender(serverRenderedAt, [qk.tasks(), ["requests", "pending"]]);

  const hasTaskOnlyFilter = Boolean(filters.status || filters.priority || filters.group);

  const pendingQuery = useQuery({
    queryKey: qk.pendingRequests({
      listId: filters.listId ?? undefined,
      kind: filters.kind,
      scope: filters.view,
      taskOnly: hasTaskOnlyFilter ? "1" : undefined,
    }),
    queryFn: () =>
      fetchPendingRequests(browserClient(), {
        listId: filters.listId,
        kind: filters.kind,
        scope: filters.view,
        hasTaskOnlyFilter,
      }),
  });

  const listQuery = useQuery({
    queryKey: qk.taskListView({
      list: filters.listId ?? undefined,
      view: filters.view,
      kind: filters.kind,
      status: filters.status ?? undefined,
      group: filters.group ?? undefined,
      priority: filters.priority ?? undefined,
      sort: filters.sort ?? undefined,
      dir: filters.dir ?? undefined,
      ...filters.fieldFilters,
    }),
    queryFn: () => fetchTaskListView(browserClient(), filters, viewer.userId),
  });

  const listsQuery = useQuery({
    queryKey: qk.listsVisible(),
    queryFn: () => fetchVisibleLists(browserClient()),
  });

  /*
   * ⚠️ THE QUEUE, ABOVE THE STAGES — and OUTSIDE the empty-state branch. A
   * department with three requests waiting and no tasks yet must not render
   * "Nothing here yet" over the very thing it is waiting on. A failed read of
   * it degrades to no queue, as the server loader always did.
   */
  const pendingRequests = pendingQuery.data ?? [];
  const queue = <PendingRequestList requests={pendingRequests} />;

  if (listQuery.isError) {
    return (
      <>
        {queue}
        <QueryError what="tasks" message={listQuery.error.message} />
      </>
    );
  }

  if (listQuery.isPending || listsQuery.isPending) {
    return (
      <>
        {queue}
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading tasks…</span>
          <TaskStatusGroupSkeleton />
        </div>
      </>
    );
  }

  const data = listQuery.data;
  const lists = listsQuery.data ?? [];
  const rows = data.rows;
  const people = data.people;

  const nameOf = new Map(people.map((person) => [person.id, person.full_name]));
  const listName = Object.fromEntries(lists.map((list) => [list.id, list.name]));

  /** Everyone on a task besides its PIC, named. */
  const extraAssignees: Record<string, { id: string; full_name: string }[]> = {};
  for (const row of data.assigneeRows) {
    (extraAssignees[row.task_id] ??= []).push({
      id: row.user_id,
      full_name: nameOf.get(row.user_id) ?? "Someone no longer active",
    });
  }

  const isFiltered = baseFiltered || data.fieldFiltered;

  /*
   * One level of nesting: an OPEN child whose parent is on screen is drawn under
   * it; a finished child, or one whose parent is filtered out, stays in its own
   * stage so it is never hidden.
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

  const grouped = new Map<VizservePmsTaskStatus, ListRow[]>(TASK_STATUSES.map((status) => [status, [] as ListRow[]]));

  for (const task of rows) {
    if (nested.has(task.id)) continue;

    const bucket = grouped.get(task.status);
    if (!bucket) continue;

    const children = childrenByParent.get(task.id);
    bucket.push({
      ...task,
      depth: 0,
      subRows: children?.map((child) => ({ ...child, depth: 1 as const })),
    });
  }

  const visibleStatuses: readonly VizservePmsTaskStatus[] = filters.status
    ? [filters.status]
    : filters.view === "qa"
      ? QA_STAGES
      : TASK_STATUSES;

  const currentListDepartment = lists.find((list) => list.id === filters.listId)?.department_id ?? null;
  const inSharedList = currentListDepartment !== null && seat.sharedDepartmentIds.includes(currentListDepartment);

  const assignable = assignableInList({
    people,
    collaborators: data.collaborators,
    listDepartmentId: currentListDepartment,
    sharedDepartmentIds: seat.sharedDepartmentIds,
    role: seat.role,
    managedDepartmentIds: seat.managedDepartmentIds,
    primaryDepartmentId: seat.primaryDepartmentId,
    selfId: viewer.userId,
  });

  const byDepartment: Record<string, { id: string; full_name: string }[]> = {};
  for (const person of people) {
    if (!person.is_active || !person.primary_department_id) continue;
    (byDepartment[person.primary_department_id] ??= []).push({ id: person.id, full_name: person.full_name });
  }

  // P13-01 — the collaboration space hands work to anybody who may collaborate.
  const showsSharedWork = inSharedList || rows.some((row) => seat.sharedDepartmentIds.includes(row.department_id));
  if (showsSharedWork) {
    for (const sharedId of seat.sharedDepartmentIds) byDepartment[sharedId] = data.collaborators;
  }

  const lookups = {
    today,
    customFields: data.customFields,
    nameOf: Object.fromEntries(nameOf),
    listName,
    threads: data.threads,
    progress: subtaskProgress(data.childRows),
    extraAssignees,
    closedOn: data.closedOn,
    tracked: data.tracked,
    coverage: data.coverage,
    byDepartment,
  };

  if (rows.length === 0) {
    return (
      <>
        {queue}
        <div className="rounded-lg border bg-card grade-surface shadow-raised-lg">
          {isFiltered ? (
            <EmptyState
              icon={<ListChecks />}
              title={
                filters.view === "qa"
                  ? "Nothing waiting on your review"
                  : filters.view === "mine"
                    ? "No tasks assigned to you"
                    : "No tasks match these filters"
              }
              description={
                filters.view === "qa"
                  ? "No work is sitting in QA with you as the reviewer. Switch to All to see the rest of the list."
                  : filters.view === "mine"
                    ? "Nothing is currently yours to move. Switch to All to see the rest of your department's work."
                    : "Clear the status, list or priority filter to see the rest of the list."
              }
            />
          ) : (
            <EmptyState
              icon={<ListChecks />}
              title={pendingRequests.length > 0 ? "Nothing approved yet" : "Nothing here yet"}
              description={
                pendingRequests.length > 0
                  ? "The requests above have not been approved yet. Approving one creates the task and files it in a list."
                  : "Tasks appear once a Team Leader approves a request, or when one is added by hand. Each moves through set stages — the server refuses any step that is not one of them."
              }
            />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {queue}
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
