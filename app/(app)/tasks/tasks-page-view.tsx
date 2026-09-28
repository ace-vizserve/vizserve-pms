"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { isTaskStatus } from "@/components/status-badge";
import { FilterBarSkeleton } from "@/components/skeletons";
import { useAuth } from "@/lib/auth/client-auth";
import { canAdminDepartment, realtimeDepartmentFilter } from "@/lib/auth/rules";
import { todayInAppZone } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import {
  fetchListFieldManager,
  fetchListFields,
  fetchTaskGroups,
  fetchVisibleLists,
} from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";
import { TASK_PRIORITIES, type TaskPriority } from "@/lib/schemas/tasks";
import { readExtraFilters } from "@/lib/task-extra-filters";
import type { TaskKind, TaskView } from "@/lib/task-scope";

import { TaskFilters } from "./filters";
import { ListFieldsSheet } from "./list-fields-sheet";
import { NewTaskButton } from "./new-task-button";
import { TaskListView } from "./task-list-view";
import { TaskSelectionProvider } from "./task-selection";
import { TaskColumnsMenu, TaskColumnsProvider } from "./tasks-table";
import { TaskToolbar } from "./toolbar";

function isPriority(value: string | null): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

/**
 * P12 Phase A — `/tasks`, entirely in the browser.
 *
 * This was a server component that awaited the auth context and the URL, then
 * streamed the filter panel, the field controls and the rows behind their own
 * boundaries. Every piece reads from the query cache now, keyed on the URL, so
 * a click into a list switches at once and the parts fill in as their (usually
 * warm) entries land. The layout still runs the auth gate; RLS scopes every row.
 *
 * The layout is the one the server page drew, boundary for boundary: the
 * toolbar and New task first, the filter panel beside the column menu, then the
 * Gate 1 queue and the stages.
 */
export function TasksPageView() {
  const auth = useAuth();
  const router = useRouter();
  const search = useSearchParams();

  const listId = search.get("list");
  const viewParam = search.get("view");
  const view: TaskView = viewParam === "mine" || viewParam === "qa" ? viewParam : "all";
  const kindParam = search.get("kind");
  const kind: TaskKind = kindParam === "internal" || kindParam === "client" ? kindParam : "all";
  const statusParam = search.get("status") ?? undefined;
  const status = isTaskStatus(statusParam) ? statusParam : null;
  const group = search.get("group");
  const priorityParam = search.get("priority");
  const priority = isPriority(priorityParam) ? priorityParam : null;

  // `/tasks` on its own is not a page: with no list and no cross-list view it
  // goes to the list index, exactly as the server page's redirect did.
  const orphan = !listId && view === "all";
  useEffect(() => {
    if (orphan) router.replace("/tasks/lists");
  }, [orphan, router]);

  const lists = useQuery({ queryKey: qk.listsVisible(), queryFn: () => fetchVisibleLists(browserClient()) });
  const groups = useQuery({ queryKey: qk.ref("task-groups"), queryFn: () => fetchTaskGroups(browserClient()) });
  const fields = useQuery({
    queryKey: qk.listFields(listId ?? ""),
    queryFn: () => fetchListFields(browserClient(), listId!),
    enabled: Boolean(listId),
  });
  const manager = useQuery({
    queryKey: qk.listFieldManager(listId ?? ""),
    queryFn: () => fetchListFieldManager(browserClient(), listId!),
    enabled: Boolean(listId),
  });

  if (orphan) return null;

  const listName = listId ? lists.data?.find((list) => list.id === listId)?.name : undefined;
  const inPersonalList = Boolean(lists.data?.some((list) => list.id === listId && list.owner_id !== null));
  const filterReady = lists.data && groups.data && (!listId || fields.data);

  // P12 — search, person and due date. `?person=me` resolves to the viewer.
  const extra = readExtraFilters((key) => search.get(key), auth.userId);

  const fieldFilters = Object.fromEntries(
    [...search.entries()].filter(([key]) => key.startsWith("cf:")),
  ) as Record<string, string>;

  return (
    <PageShell>
      {/* P8-03 — live rows: a ping invalidates the cached rows under RLS. */}
      <RealtimeTasks filter={realtimeDepartmentFilter(auth)} />

      {/* Spans the toolbar AND the groups: the menu is in the filter row and the
          tables it controls are further down. */}
      <TaskColumnsProvider>
        {/* Which list you are in, once its name is known. */}
        {listName ? <BreadcrumbLabel value={listName} /> : null}

        <div className="flex flex-wrap items-center gap-2">
          <TaskToolbar view="list" />
          <div className="ml-auto">
            {/* The list being read, so a task made here lands in it. */}
            <NewTaskButton listId={listId} />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {filterReady ? (
            inPersonalList ? (
              <TaskFilters lists={[]} groups={[]} customFields={fields.data ?? []} />
            ) : (
              <TaskFilters
                lists={lists.data!.filter((list) => list.owner_id === null)}
                groups={groups.data!}
                customFields={fields.data ?? []}
              />
            )
          ) : (
            <div role="status" aria-busy="true">
              <span className="sr-only">Loading filters…</span>
              <FilterBarSkeleton fields={2} />
            </div>
          )}

          {/* P7-73 — with a list open, its custom fields join the column menu and
              its field manager sits beside it for whoever may manage it. */}
          <div className="ml-auto flex items-center gap-2">
            <TaskColumnsMenu customFields={listId ? (manager.data?.fields.filter((field) => field.is_active) ?? []) : []} />
            {listId && manager.data?.canManage ? (
              <ListFieldsSheet listId={listId} fields={manager.data.fields} />
            ) : null}
          </div>
        </div>

        {/* Outside the rows so the fallback-to-content swap cannot clear which
            rows are ticked. */}
        <TaskSelectionProvider>
          <TaskListView
            filters={{
              listId,
              view,
              kind,
              status,
              group,
              priority,
              sort: search.get("sort"),
              dir: search.get("dir"),
              fieldFilters,
              extra,
            }}
            viewer={{
              userId: auth.userId,
              role: auth.role,
              managedDepartmentIds: auth.managedDepartmentIds,
              deptAdminOf: canAdminDepartment(auth, auth.primaryDepartmentId) ? auth.primaryDepartmentId : null,
              primaryDepartmentId: auth.primaryDepartmentId,
            }}
            seat={{
              sharedDepartmentIds: auth.sharedDepartmentIds,
              role: auth.role,
              managedDepartmentIds: auth.managedDepartmentIds,
              primaryDepartmentId: auth.primaryDepartmentId,
            }}
            today={todayInAppZone()}
            baseFiltered={
              Boolean(status || listId || group || priority || extra.q || extra.person || extra.due) ||
              view !== "all" ||
              kind !== "all"
            }
          />
        </TaskSelectionProvider>
      </TaskColumnsProvider>
    </PageShell>
  );
}
