/**
 * Every query key in the app, in one place.
 *
 * ⚠️ THE HIERARCHY IS THE INVALIDATION API. TanStack matches a key by PREFIX, so
 * `["tasks"]` sweeps every list and every board view while
 * `["task", id, "comments"]` refetches one panel and leaves the task alone. The
 * shape of these arrays is therefore a design decision, not a naming one — get
 * the prefix order wrong and the only way to refresh a comment is to refetch the
 * whole task.
 *
 * ⚠️ KEYS ARE HASHED STRUCTURALLY, NOT BY IDENTITY. TanStack serialises a key
 * with sorted object properties, so `{list: "a"}` built fresh on every render is
 * the SAME key every time and needs no `useMemo`. What breaks it is CONTENT that
 * moves — a `Date.now()`, a `new Date()`, anything non-serialisable — and the
 * difference between an absent property and one set to `undefined`. That is what
 * `normalize` below is for; use it on anything derived from the URL.
 */
import type { VizservePmsTaskStatus } from "@/lib/database.types";

/**
 * The task list/board filter bag.
 *
 * Mirrors `TasksSearchParams` in `app/(app)/tasks/page.tsx` — the URL is still
 * the shareable source of truth for these, and the cache key is derived from it
 * rather than the other way round.
 */
export type TaskFilters = {
  status?: string;
  view?: string;
  list?: string;
  group?: string;
  kind?: string;
  priority?: string;
  sort?: string;
  dir?: string;
};

/**
 * The panels of a request detail page. See `qk.requestPart` for what each holds
 * and why it is not folded into the row.
 */
export type RequestPart = "context" | "outcome" | "review";

/** The panels of a task detail page, each invalidated on its own. */
export type TaskPart =
  | "comments"
  | "subtasks"
  | "assignees"
  | "history"
  | "attachments"
  | "time";

/**
 * Reference data — admin-managed, changes rarely, read by pickers everywhere.
 * Kept under one `["ref", …]` prefix so a settings change can sweep all of it.
 *
 * ⚠️ `task-groups` IS THE FOLDER LIST (P7-18), and it is reference data by the
 * same test as the rest: admin-managed, read by a picker, changed about once a
 * quarter. It is NOT under `["lists"]` even though a folder holds lists —
 * `lib/query/realtime.ts` already maps `vizserve_pms_task_groups` to `["lists"]`
 * so a folder rename sweeps the list labels that quote it, and putting the
 * folder list itself under that prefix as well would be correct but would spend
 * `REF_STALE_TIME` on nothing. The invalidation still reaches it: that map is
 * where a folder event is turned into keys, and it names both.
 */
export type RefTable =
  | "users"
  | "departments"
  | "holidays"
  | "leave-types"
  | "events"
  | "task-groups"
  /**
   * P12-18 — the CLIENT_REQUEST forms, for the `/requests` filter dropdown and
   * its SLA lookup.
   *
   * Reference data by the same test as the rest: admin-managed, read by a picker
   * on every visit to a queue that re-reads its rows on every filter change, and
   * changed about as often as a department is. It is NOT under `["forms"]` —
   * that prefix is Phase 6's builder, which owns the whole form INCLUDING its
   * fields and its draft state, and sweeping the builder from a request filter
   * would be the wrong direction entirely.
   *
   * ⚠️ SO A PUBLISHED-OR-RENAMED FORM TAKES UP TO `REF_STALE_TIME` TO APPEAR
   * HERE. That is the trade every `qk.ref` entry makes; the difference is that
   * `realtime.ts` has no `vizserve_pms_forms` row to close the gap, because that
   * table is not published to Realtime. Phase 6 owns forms and is where an
   * invalidation from the builder belongs.
   */
  | "client-forms";

/**
 * Drops keys whose value is `undefined` or `""`.
 *
 * ⚠️ `{}` AND `{status: undefined}` ARE DIFFERENT KEYS otherwise, and both come
 * out of the same URL depending on whether the parameter was present. Two cache
 * entries for one view is not a crash — it is a second fetch and a skeleton on a
 * screen that already had the data, which is exactly the class of bug nobody
 * files because the app still looks correct.
 */
export function normalize<T extends Record<string, unknown>>(params: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

export const qk = {
  // ── the rail ────────────────────────────────────────────────────────────────
  /** Departments → folders → lists, both counts, both nav badges. One object. */
  snapshot: () => ["sidebar", "snapshot"] as const,

  // ── tasks ───────────────────────────────────────────────────────────────────
  /** The sweep. Any task write invalidates this and every view under it. */
  tasks: () => ["tasks"] as const,
  taskList: (listId: string, filters: TaskFilters) =>
    ["tasks", "list", listId, normalize(filters)] as const,
  taskBoard: (listId: string, filters: TaskFilters) =>
    ["tasks", "board", listId, normalize(filters)] as const,
  /** Cross-list views that no single list can answer — `?view=mine`, `?view=qa`. */
  taskView: (view: "mine" | "qa", filters: TaskFilters) =>
    ["tasks", "view", view, normalize(filters)] as const,

  task: (id: string) => ["task", id] as const,
  taskPart: (id: string, part: TaskPart) => ["task", id, part] as const,

  /**
   * One department's lists.
   *
   * ⚠️ DEFINED, AND STILL READ BY NOTHING AFTER PHASE 4 — which is a statement
   * about the shape rather than an oversight, so it is written down here instead
   * of being rediscovered a third time. Two consumers have now looked at this
   * key and both needed a different row set:
   *
   *   * `/tasks`, `/tasks/board` and `/tasks/[id]` want every ACTIVE list the
   *     reader may see, across departments → `listsVisible()` below.
   *   * `/tasks/lists` wants every DEPARTMENT list in scope, archived ones
   *     included and personal ones excluded → `listsManaged()` below.
   *
   * Neither is "department x's lists", and writing either here would have meant
   * whichever fetcher ran last won the entry. It is kept rather than deleted
   * because a genuinely per-department read is a plausible thing to want (a
   * picker on a screen that already knows its department), and because the
   * `["lists"]` prefix it sits under is what `realtime.ts` invalidates — so the
   * day something does use it, the plumbing is already right.
   */
  lists: (departmentId: string) => ["lists", departmentId] as const,

  /**
   * EVERY ACTIVE LIST THE READER MAY SEE, across departments. One entry, shared.
   *
   * ⚠️ THIS EXISTS BECAUSE `qk.lists(departmentId)` COULD NOT HOLD IT, and the
   * distinction is the one `fetchDepartmentLists` warned about in P12-06. That
   * key is keyed BY DEPARTMENT, so an entry under it holds one department's
   * rows. `/tasks` and `/tasks/board` need the lists of every department the
   * reader can see — a lead of two departments, an owner of all of them — which
   * is not a superset of any single entry, it is a different row set. Writing it
   * to `qk.lists(x)` would have meant whichever fetcher ran last won the entry
   * and the other consumer silently lost rows.
   *
   * ⚠️ AND THE DETAIL PAGE MOVED ONTO THIS ONE RATHER THAN KEEPING ITS OWN.
   * `/tasks/[id]` wants its own department's active lists, which IS a subset of
   * this — so it reads this entry and filters in the browser, and the tab holds
   * ONE copy of the list tree instead of one per department anybody opens. The
   * shape is the genuine superset of both: `group_id`, `owner_id` and
   * `department_id` ride along for the filter panel, the P11-06 personal-list
   * split and that filter respectively.
   *
   * Under the `["lists"]` prefix on purpose: `INVALIDATES` in `realtime.ts` maps
   * both list tables to it, so a rename or a new list sweeps this and
   * `qk.lists(…)` together.
   */
  listsVisible: () => ["lists", "visible"] as const,

  /**
   * P12-16 — THE LIST MANAGEMENT SCREEN'S ROW SET. `/tasks/lists`, and only it.
   *
   * ⚠️ A THIRD ENTRY UNDER `["lists"]` RATHER THAN A REUSE OF EITHER SIBLING,
   * for the same reason `listsVisible` is not `lists(departmentId)`: the rows
   * differ, not merely the columns.
   *
   *   * ARCHIVED LISTS AND ARCHIVED FOLDERS ARE INCLUDED. This is the only
   *     screen from which an archived list or folder can be brought back, so
   *     filtering them out here would make that impossible from the one place it
   *     is offered. `listsVisible()` filters `is_active = true` on purpose — an
   *     archived list must not appear in the `/tasks` filter dropdown — so the
   *     two row sets are not a subset either way round.
   *   * PERSONAL LISTS ARE EXCLUDED (P11-06). This screen is how a DEPARTMENT is
   *     organised; a personal list is in no folder and belongs to a person, and
   *     is made and renamed from the sidebar's Personal lists group instead.
   *     ⚠️ NOT REDUNDANT WITH RLS — the policy lets the caller read their OWN
   *     personal lists, so without the `owner_id is null` filter a lead would
   *     find their private lists sitting in their department's tree here,
   *     offered a folder picker the check constraint refuses.
   *
   * ONE ENTRY FOR EVERY DEPARTMENT IN SCOPE, not one per department, because
   * this screen renders them all at once — a lead of two departments sees two
   * sections. The whole payload is folders, lists and open counts together,
   * since a rename, an archive and a move all touch more than one of the three
   * and three keys would be three refetches with nothing to tell them apart.
   *
   * Under `["lists"]` so `realtime.ts` sweeps it with the rest: it maps both
   * `vizserve_pms_lists` and `vizserve_pms_task_groups` to that prefix.
   */
  listsManaged: () => ["lists", "managed"] as const,

  // ── the two approval domains ────────────────────────────────────────────────
  // Separate prefixes on purpose. Client forms and internal approvals look
  // mergeable and are not (different auth models, different lifecycles) — a
  // shared prefix here would be the first step towards unifying them.
  requests: (filters: Record<string, string | undefined>) =>
    ["requests", normalize(filters)] as const,
  request: (id: string) => ["request", id] as const,
  /**
   * P12-18 — the parts of ONE request that change on different schedules.
   *
   * ⚠️ THE THIRD SEGMENT IS WHAT MAKES A GATE 1 DECISION CHEAP. `["request", id]`
   * prefix-matches all of these, so a decision can sweep the lot — and the parts
   * that a decision cannot possibly have changed do not have to be swept
   * individually:
   *
   *   * `"context"` — the form's name, its field labels and the uploaded files.
   *     Fixed the moment the client pressed Submit. Nothing on this page can
   *     move it.
   *   * `"outcome"` — the decision log and the task the request became. Empty
   *     until there IS a decision, which is why the caller gates it with
   *     `enabled` rather than fetching an empty list on every pending request.
   *   * `"review"` — the candidates, the capacity scan, the lists and the
   *     reserved folder. Read only while the panel renders; `department_capacity`
   *     is a scan over the department's open tasks and there is no reason to pay
   *     for it on a request decided last week.
   *
   * Same shape and same argument as `qk.taskPart(id, part)`.
   */
  requestPart: (id: string, part: RequestPart) => ["request", id, part] as const,
  /**
   * P7-26 — the Gate 1 queue as the TASK VIEWS show it, above the stages and as
   * the board's first column.
   *
   * ⚠️ ITS OWN SEGMENT UNDER `["requests"]`, NOT `qk.requests(filters)`, and the
   * reason is the collision `fetchDepartmentLists` records: Phase 4 puts
   * `/requests` on that key with a far wider column set and no
   * `status = PENDING_REVIEW` filter. Two different row sets under one key is
   * whichever-ran-last-wins, silently. The shared PREFIX is deliberate though —
   * a Gate 1 decision invalidates `["requests"]` and moves both.
   */
  pendingRequests: (filters: Record<string, string | undefined>) =>
    ["requests", "pending", normalize(filters)] as const,
  approvals: (filters: Record<string, string | undefined>) =>
    ["approvals", normalize(filters)] as const,
  approval: (id: string) => ["approval", id] as const,

  // ── inbox ───────────────────────────────────────────────────────────────────
  /** The rail badge. Split from the list so a read receipt does not refetch it. */
  unread: () => ["notifications", "unread"] as const,
  inbox: (filters: Record<string, string | undefined>) =>
    ["inbox", normalize(filters)] as const,

  // ── time ────────────────────────────────────────────────────────────────────
  // `weekStart` is a bare `YYYY-MM-DD` string, never a Date. A Date in a key
  // serialises to an instant, so two identical weeks built a millisecond apart
  // would be two entries. `lib/dates.ts` is the only thing that makes these.
  week: (userId: string, weekStart: string) =>
    ["timesheet", "week", userId, weekStart] as const,
  teamWeek: (departmentId: string, weekStart: string) =>
    ["timesheet", "team", departmentId, weekStart] as const,

  punchState: () => ["dtr", "punch-state"] as const,
  dtrDay: (date: string) => ["dtr", "day", date] as const,

  // ── reference ───────────────────────────────────────────────────────────────
  ref: (table: RefTable) => ["ref", table] as const,

  // ── forms + reports ─────────────────────────────────────────────────────────
  forms: () => ["forms"] as const,
  form: (id: string) => ["form", id] as const,
  /** Keyed on the whole parameter bag — a report IS its parameters. */
  reports: (params: Record<string, unknown>) => ["reports", normalize(params)] as const,
} as const;

/** Re-exported so a fetcher can type a status without reaching for the DB types. */
export type { VizservePmsTaskStatus };
