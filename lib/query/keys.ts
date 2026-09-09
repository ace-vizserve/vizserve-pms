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
 */
export type RefTable = "users" | "departments" | "holidays" | "leave-types" | "events";

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

  /** Lists and folders for the management screen. Department-scoped by policy. */
  lists: (departmentId: string) => ["lists", departmentId] as const,

  // ── the two approval domains ────────────────────────────────────────────────
  // Separate prefixes on purpose. Client forms and internal approvals look
  // mergeable and are not (different auth models, different lifecycles) — a
  // shared prefix here would be the first step towards unifying them.
  requests: (filters: Record<string, string | undefined>) =>
    ["requests", normalize(filters)] as const,
  request: (id: string) => ["request", id] as const,
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
