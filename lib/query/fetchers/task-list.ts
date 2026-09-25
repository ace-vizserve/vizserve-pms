import type { TaskComment } from "@/app/(app)/tasks/comment-thread";
import type { TaskRow } from "@/app/(app)/tasks/tasks-table";
import { read } from "@/lib/query/read";
import { sanitizeRichTextInBrowser } from "@/lib/rich-text-dom";
import {
  pendingRequestsApply,
  type PendingRequest,
  type PendingRequestFilters,
} from "@/lib/schemas/approvals";
import {
  compareFieldValues,
  fieldIdFromKey,
  fieldKey,
  matchesFieldFilter,
  parseFieldFilter,
  readFieldValue,
  type ListField,
} from "@/lib/schemas/list-fields";
import { isTerminal, type TaskPriority, type TaskStatus } from "@/lib/schemas/tasks";
import { applyTaskScope, type TaskKind, type TaskView } from "@/lib/task-scope";

import { fetchCollaborators, fetchListFields, type TaskReadClient } from "./task";

/**
 * P12-07 — the reads behind `/tasks` (and the Gate 1 queue both task views
 * show), browser → PostgREST.
 *
 * ⚠️ THE SAME QUERIES THE SERVER PAGE RAN, IN THE SAME TWO WAVES. The rows (with
 * the custom-field filter and sort applied, which need the list's fields), then
 * six reads keyed on the ids that survived. What changed is that a failure
 * THROWS: the page used to swallow every second-wave error into `{ data: [] }`,
 * which drew a thread with no comments and a task with no time on it.
 *
 * ⚠️ NO SCOPE FILTER BEYOND `applyTaskScope`. RLS decides which tasks come back,
 * exactly as it did for the RSC.
 */

/* -------------------------------------------------------------------------- */
/* The Gate 1 queue.                                                           */
/* -------------------------------------------------------------------------- */

type PendingRow = {
  id: string;
  reference_no: string;
  title: string;
  requester_name: string;
  requester_org: string | null;
  target_date: string | null;
  submitted_at: string | null;
  vizserve_pms_forms: { name: string; default_list_id: string | null } | null;
};

/**
 * `qk.pendingRequests(filters)` — the requests still waiting on Gate 1.
 *
 * The same read as `loadPendingRequests` (lib/pending-requests-server.ts), and
 * the same `pendingRequestsApply` decides whether it runs at all. Empty for a
 * member: `vizserve_pms_requests` is lead-only, so nothing comes back.
 */
export async function fetchPendingRequests(
  client: TaskReadClient,
  filters: PendingRequestFilters & { listId?: string | null },
): Promise<PendingRequest[]> {
  if (!pendingRequestsApply(filters)) return [];

  let query = client
    .from("vizserve_pms_requests")
    .select(
      "id, reference_no, title, requester_name, requester_org, target_date, submitted_at, vizserve_pms_forms!inner(name, default_list_id)",
    )
    .eq("status", "PENDING_REVIEW")
    .order("submitted_at", { ascending: true, nullsFirst: false });

  if (filters.listId) query = query.eq("vizserve_pms_forms.default_list_id", filters.listId);

  const rows = (await read(query)) as unknown as PendingRow[];

  return rows.map((row) => ({
    id: row.id,
    reference_no: row.reference_no,
    title: row.title,
    requester_name: row.requester_name,
    requester_org: row.requester_org,
    target_date: row.target_date,
    submitted_at: row.submitted_at,
    listId: row.vizserve_pms_forms?.default_list_id ?? null,
    formName: row.vizserve_pms_forms?.name ?? "",
  }));
}

/* -------------------------------------------------------------------------- */
/* The list.                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * P7-65 — `due` and `priority` are the two the toolbar Select offers; the rest
 * are sortable column headers. One `?sort=` param, so the Select and the headers
 * cannot disagree.
 *
 * ⚠️ SORTING THE QUERY IS WHAT MAKES THIS WORK ON A GROUPED LIST. The rows are
 * ordered before they are split into stages, so all eight tables reorder
 * together; a per-table sort would mean nothing across them.
 */
export const TASK_LIST_SORTS = ["due", "priority", "title", "start", "estimate"] as const;
export type TaskListSort = (typeof TASK_LIST_SORTS)[number];

export function isTaskListSort(value: string | undefined): value is TaskListSort {
  return typeof value === "string" && (TASK_LIST_SORTS as readonly string[]).includes(value);
}

const DEFAULT_SORT = { sort: "due", ascending: true } as const;

const ORDER_COLUMN: Record<TaskListSort, string> = {
  due: "due_date",
  priority: "priority",
  title: "title",
  start: "start_date",
  estimate: "estimate_minutes",
};

const TASK_COLUMNS =
  "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, created_by, list_id, request_id, is_personal, priority, estimate_minutes, parent_task_id, resolution, custom_fields";

export type TaskListFilters = {
  listId: string | null;
  view: TaskView;
  kind: TaskKind;
  status: TaskStatus | null;
  group: string | null;
  priority: TaskPriority | null;
  /** The raw `?sort=` — a built-in column, or a custom field's `cf:<id>`. */
  sort: string | null;
  dir: string | null;
  /** `cf:<id>` → the raw filter string, for the list's custom fields. */
  fieldFilters: Record<string, string>;
};

export type TaskListPerson = {
  id: string;
  full_name: string;
  primary_department_id: string | null;
  is_active: boolean;
};

export type TaskListView = {
  rows: TaskRow[];
  people: TaskListPerson[];
  customFields: ListField[];
  collaborators: { id: string; full_name: string }[];
  /** Whether any custom-field filter narrowed the rows. */
  fieldFiltered: boolean;
  threads: Record<string, TaskComment[]>;
  childRows: { id: string; parent_task_id: string | null; status: TaskStatus }[];
  tracked: Record<string, number>;
  coverage: Record<string, { relieverId: string; until: string }>;
  assigneeRows: { task_id: string; user_id: string }[];
  /** The most recent close per task, from the trail. */
  closedOn: Record<string, string>;
};

/** `qk.taskList(filters)` — one list view's rows and everything drawn beside them. */
export async function fetchTaskListView(
  client: TaskReadClient,
  filters: TaskListFilters,
  userId: string,
): Promise<TaskListView> {
  // `undefined` when the URL named no sort we recognise: that decides whether
  // `?dir=` is obeyed at all, so it cannot be collapsed into `sort`.
  const requested = isTaskListSort(filters.sort ?? undefined) ? (filters.sort as TaskListSort) : undefined;
  const sort: TaskListSort = requested ?? DEFAULT_SORT.sort;
  const ascending = requested ? filters.dir !== "desc" : DEFAULT_SORT.ascending;

  let query = client
    .from("vizserve_pms_tasks")
    .select(filters.group ? `${TASK_COLUMNS}, vizserve_pms_lists!inner(group_id)` : TASK_COLUMNS)
    .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.group) query = query.eq("vizserve_pms_lists.group_id", filters.group);
  if (filters.priority) query = query.eq("priority", filters.priority);
  query = applyTaskScope(query, { listId: filters.listId, view: filters.view, kind: filters.kind, userId });

  const [tasks, people, customFields, collaborators] = await Promise.all([
    read(query),
    read(client.from("vizserve_pms_users").select("id, full_name, primary_department_id, is_active")),
    filters.listId ? fetchListFields(client, filters.listId) : Promise.resolve([] as ListField[]),
    fetchCollaborators(client),
  ]);

  const fetchedRows = (tasks ?? []) as unknown as TaskRow[];

  // P7-73 — the custom-field filters and sort, applied in memory, as the RSC did.
  const fieldFilters = customFields.flatMap((field) => {
    const filter = parseFieldFilter(field, filters.fieldFilters[fieldKey(field.id)]);
    return filter ? [{ field, filter }] : [];
  });

  const sortField = customFields.find((field) => field.id === fieldIdFromKey(filters.sort ?? undefined));

  const filteredRows = fieldFilters.length
    ? fetchedRows.filter((task) =>
        fieldFilters.every(({ field, filter }) =>
          matchesFieldFilter(field, filter, readFieldValue(field, task.custom_fields)),
        ),
      )
    : fetchedRows;

  const rows = sortField
    ? [...filteredRows].sort((a, b) =>
        compareFieldValues(
          sortField,
          readFieldValue(sortField, a.custom_fields),
          readFieldValue(sortField, b.custom_fields),
          filters.dir === "desc" ? "desc" : "asc",
        ),
      )
    : filteredRows;

  const taskIds = rows.map((task) => task.id);
  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));

  const empty = {
    threads: {},
    childRows: [],
    tracked: {},
    coverage: {},
    assigneeRows: [],
    closedOn: {},
  };

  if (taskIds.length === 0) {
    return {
      rows,
      people: (people ?? []) as TaskListPerson[],
      customFields,
      collaborators,
      fieldFiltered: fieldFilters.length > 0,
      ...empty,
    };
  }

  const [commentRows, childRows, trackedRows, coverageRows, assigneeRows, closedRows] = await Promise.all([
    read(
      client
        .from("vizserve_pms_task_comments")
        .select("id, task_id, body, author_id, created_at, updated_at")
        .in("task_id", taskIds)
        .order("created_at", { ascending: true }),
    ),
    read(client.from("vizserve_pms_tasks").select("id, parent_task_id, status").in("parent_task_id", taskIds)),
    read(client.rpc("vizserve_pms_task_time_tracked", { p_task_ids: taskIds })),
    read(
      client
        .from("vizserve_pms_active_task_coverage")
        .select("task_id, reliever_id, end_date")
        .in("task_id", taskIds),
    ),
    read(client.from("vizserve_pms_task_assignees").select("task_id, user_id").in("task_id", taskIds)),
    read(
      client
        .from("vizserve_pms_task_status_history")
        .select("task_id, to_status, created_at")
        .in("task_id", taskIds)
        .in("to_status", ["COMPLETED", "COMPLETED_NO_RESPONSE"])
        .order("created_at", { ascending: true }),
    ),
  ]);

  const threads: Record<string, TaskComment[]> = {};
  for (const row of commentRows ?? []) {
    (threads[row.task_id] ??= []).push({
      id: row.id,
      body: sanitizeRichTextInBrowser(row.body),
      authorId: row.author_id,
      authorName: nameOf.get(row.author_id) ?? "Someone no longer active",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  // Ascending fetch, so the last close written per task is the one kept.
  const closedOn: Record<string, string> = {};
  for (const row of closedRows ?? []) closedOn[row.task_id] = row.created_at;

  const tracked: Record<string, number> = {};
  for (const row of (trackedRows ?? []) as { task_id: string; minutes: number }[]) tracked[row.task_id] = row.minutes;

  const coverage: Record<string, { relieverId: string; until: string }> = {};
  for (const row of coverageRows ?? []) {
    if (!row.task_id || !row.reliever_id || !row.end_date) continue;
    coverage[row.task_id] = { relieverId: row.reliever_id, until: row.end_date };
  }

  return {
    rows,
    people: (people ?? []) as TaskListPerson[],
    customFields,
    collaborators,
    fieldFiltered: fieldFilters.length > 0,
    threads,
    childRows: (childRows ?? []) as TaskListView["childRows"],
    tracked,
    coverage,
    assigneeRows: assigneeRows ?? [],
    closedOn,
  };
}

/** Progress per parent: `[done, total]` over its children. */
export function subtaskProgress(childRows: TaskListView["childRows"]) {
  const progress: Record<string, { done: number; total: number }> = {};
  for (const child of childRows) {
    if (!child.parent_task_id) continue;
    const entry = (progress[child.parent_task_id] ??= { done: 0, total: 0 });
    entry.total += 1;
    if (isTerminal(child.status)) entry.done += 1;
  }
  return progress;
}
