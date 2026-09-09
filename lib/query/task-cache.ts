/**
 * P12-10 — WHAT A TASK WRITE PAINTS, BEFORE THE SERVER ANSWERS.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS REPLACES `app/(app)/tasks/optimistic-move.tsx` AND EVERY
 * `useOptimistic` IT SERVED, AND THE REASON IS LATENCY RATHER THAN TIDINESS.
 *
 * `useOptimistic` DROPS ITS VALUE THE INSTANT THE TRANSITION THAT SET IT ENDS.
 * So every control that used one had to keep its transition open until real data
 * had landed — which is why `invalidateTaskWrite` was `await`ed inside it, and
 * why that await covered `qk.tasks()`, the prefix over the list AND the board.
 * Changing one field therefore waited for the whole surface to refetch — seven
 * queries in two waves on `/tasks`, eight on the detail page — before the
 * controls came back. The chip moved instantly and the interaction stayed
 * pending for about a second afterwards. That await was not a mistake: with
 * `useOptimistic` it was the only thing holding the value on screen. `a64b06c`
 * removed the equivalent hold and `ded2244` restored it across eighteen files
 * the same day.
 *
 * `onMutate` REMOVES THE REASON FOR THE AWAIT. The predicted value goes into the
 * QUERY CACHE rather than into transition-scoped state, so the cache keeps it
 * until a refetch replaces it. Nothing reverts by itself, so nothing has to be
 * awaited, and the interaction ends when the write returns.
 *
 * ⚠️ AND ROLLBACK IS NO LONGER FREE, WHICH IS THE HALF MOST LIKELY TO BE LOST.
 * React used to put the old value back on a refusal with no code at all. Here
 * the snapshot `beginTaskWrite` returns is that rollback, and `onError` must
 * hand it to `rollbackTaskWrite`. `tests/unit/task-cache.test.ts` asserts
 * exactly that: apply, refuse, and the cache is byte-for-byte what it was.
 *
 * ------------------------------------------------------------------------
 * ⚠️ A LEAF MODULE, IMPORTING NOTHING BUT TYPES AND `./keys`, AND THAT IS NOT A
 * STYLE PREFERENCE. Its predecessor broke once by living in
 * `task-status-groups.tsx`: that file imports the table, which imports the
 * status control, which imported the hook, which imported the context back — a
 * cycle. Under a bundler a cycle can hand two halves of the graph two different
 * evaluations of one module, so `createContext` ran twice, the provider
 * published to one context and `useContext` read the other, and the row silently
 * never moved. Nothing here may import a component, and `QueryClient` is
 * imported as a TYPE so this file contributes no runtime edge at all.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THE POINT IS TO PATCH THE ROW, NOT TO REFETCH THE SURFACE. A status change
 * used to re-read every row on screen plus its six `.in("task_id", …)` lookups.
 * Those lookups go through the `vizserve_pms_task_assignees` policy, which
 * P12-03 could NOT hoist into an InitPlan because
 * `vizserve_pms_is_on_task(task_id, auth.uid())` takes the row's own id — so
 * they are the expensive half and they are re-run per row. One `setQueryData`
 * on the row it changed costs none of that.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { CacheSnapshot } from "./write-cache";

import { qk, type TaskPart } from "./keys";
import { beginWrite, cancelRefetches, rollbackWrite } from "./write-cache";

/**
 * The columns a control writes, as they are named in the database.
 *
 * Deliberately loose: `updateTaskField` takes `unknown` and the zod contract
 * lives in the action, so a typed union here would be a third statement of the
 * same list, drifting from the other two on the first new column.
 */
export type TaskFields = Record<string, unknown>;

/**
 * What the cache held before a control painted over it.
 *
 * ⚠️ IT IS THE ROLLBACK, AND IT IS WHY `onError` CANNOT BE OMITTED. Every entry
 * is `[key, data]` exactly as TanStack handed it over — the same object
 * references, so restoring is a pointer swap rather than a rebuild, and a
 * refused write leaves the cache indistinguishable from before it was pressed.
 */
export type TaskCacheSnapshot = CacheSnapshot;

/**
 * THE TWO ROOTS A TASK LIVES UNDER, and both are needed.
 *
 * `["tasks"]` is the list and the board (`qk.taskList`, `qk.taskBoard`,
 * `qk.taskView`). `["task"]` is every detail page and every panel under one —
 * and it is deliberately the ROOT rather than `["task", id]`, because a task can
 * be a row in ANOTHER task's subtask panel (`qk.taskPart(parentId, "subtasks")`)
 * and that key carries the parent's id, not this one's. Scanning the root is how
 * a subtask ticked from the list also moves on the parent's page.
 */
const TASK_ROOTS: readonly QueryKey[] = [qk.tasks(), ["task"]];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/* Snapshot and rollback.                                                      */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ P12-16 — THE THREE BELOW ARE NOW THIN NAMED WRAPPERS OVER
 * `lib/query/write-cache.ts`, WHICH HOLDS THEIR BODIES AND THEIR REASONING.
 *
 * Nothing about the behaviour changed and nothing about the ordering did: the
 * snapshot is still synchronous, `cancelTaskRefetches` is still fired after the
 * patch rather than awaited before it, and `rollbackTaskWrite` is still the
 * whole of `onError`. Read that file for WHY each of those is the way round it
 * is — both were paid for here.
 *
 * They kept their task-shaped names because eighteen call sites read them, and
 * because `TASK_ROOTS` is the part that is genuinely about tasks. Phase 4 added
 * four more domains needing exactly this bookkeeping over different roots, and
 * five copies of a rollback is five chances at the one failure in the optimistic
 * path that is completely silent when it is wrong.
 */
export function beginTaskWrite(client: QueryClient): TaskCacheSnapshot {
  return beginWrite(client, TASK_ROOTS);
}

export function cancelTaskRefetches(client: QueryClient): void {
  cancelRefetches(client, TASK_ROOTS);
}

export function rollbackTaskWrite(client: QueryClient, snapshot: TaskCacheSnapshot): void {
  rollbackWrite(client, snapshot);
}

/* -------------------------------------------------------------------------- */
/* The row edits.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Apply `edit` to every task-shaped object in one cache entry.
 *
 * ⚠️ ONE RULE, NOT A SHAPE PER SURFACE: anything with an `id` equal to the task
 * is the task. That reaches `TaskListView.rows`, `TaskBoardView.live` and
 * `.finished`, the `children` arrays both of them carry for the progress bars,
 * `TaskDetail.task`, and the bare `SubtaskRow[]` under
 * `qk.taskPart(parentId, "subtasks")` — five shapes, one predicate, and a sixth
 * surface arriving in Phase 4 needs no line here.
 *
 * It cannot collide with the comment and attachment rows that share these
 * entries: their ids are their own rows' uuids, never a task's.
 *
 * ⚠️ AN UNCHANGED ENTRY IS RETURNED BY REFERENCE. `setQueryData` notifies its
 * observers whenever the reference moves, so rebuilding every cached list on
 * every keystroke-sized write would re-render six screens to change one. Every
 * branch below returns the original object when nothing matched.
 */
function editEntry(
  data: unknown,
  edit: (rows: unknown[]) => unknown[],
  editOne: (row: Record<string, unknown>) => Record<string, unknown> | null,
): unknown {
  if (Array.isArray(data)) {
    const next = edit(data);
    return next === data ? data : next;
  }

  if (!isRecord(data)) return data;

  let changed = false;
  const next: Record<string, unknown> = { ...data };

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      const rows = edit(value);
      if (rows !== value) {
        next[key] = rows;
        changed = true;
      }
      continue;
    }

    /* `TaskDetail.task` — one row rather than a list of them. */
    if (isRecord(value)) {
      const row = editOne(value);
      if (row !== null && row !== value) {
        next[key] = row;
        changed = true;
      }
    }
  }

  return changed ? next : data;
}

function applyToTaskRoots(
  client: QueryClient,
  edit: (rows: unknown[]) => unknown[],
  editOne: (row: Record<string, unknown>) => Record<string, unknown> | null,
): void {
  for (const queryKey of TASK_ROOTS) {
    client.setQueriesData({ queryKey }, (data: unknown) => editEntry(data, edit, editOne));
  }
}

/**
 * The paint behind every inline edit, every status move and every reassignment.
 *
 * ⚠️ THIS IS WHAT FEEDS `InlinePriority`'S THREE READERS AT ONCE. That control
 * is rendered TWICE in a single task row — beside the title and as the priority
 * column — and `TaskRowActions` reads the same field a third time. Three
 * component instances of one field is why local state failed there and why a
 * context existed at all: the one you clicked moved and the other two sat on the
 * old value until the server answered. All three render from the ROW, the row
 * comes from this cache entry, so one call moves all three by construction.
 */
export function patchTaskRow(client: QueryClient, taskId: string, fields: TaskFields): void {
  const patchOne = (row: Record<string, unknown>) =>
    row.id === taskId ? { ...row, ...fields } : row;

  applyToTaskRoots(
    client,
    (rows) => {
      let changed = false;
      const next = rows.map((row) => {
        if (!isRecord(row) || row.id !== taskId) return row;
        changed = true;
        return { ...row, ...fields };
      });
      return changed ? next : rows;
    },
    patchOne,
  );
}

/**
 * A deleted task goes now.
 *
 * ⚠️ ARRAYS ONLY — `TaskDetail.task` IS LEFT ALONE ON PURPOSE. Deleting from a
 * subtask row leaves the parent's detail page mounted, and nulling the task in
 * its cache entry would blank the page under somebody rather than remove a row
 * from a list. `onSettled` invalidates `qk.task(id)`, which is what actually
 * retires the deleted task's own entry.
 *
 * The group COUNT follows by itself: the heading counts what is in the bucket
 * rather than holding a number of its own, so the rows and the count beside them
 * cannot disagree.
 */
export function dropTaskRow(client: QueryClient, taskId: string): void {
  applyToTaskRoots(
    client,
    (rows) => {
      const next = rows.filter((row) => !isRecord(row) || row.id !== taskId);
      return next.length === rows.length ? rows : next;
    },
    () => null,
  );
}

/* -------------------------------------------------------------------------- */
/* The placeholder row.                                                        */
/* -------------------------------------------------------------------------- */

/*
 * THE PLACEHOLDER ID — AND WHY IT IS NOT A UUID.
 *
 * An optimistic row stands for a task the server has not created yet, so it has
 * no id to carry. React still needs a key, and the key has to be one nothing can
 * mistake for a real id.
 *
 * ⚠️ THE MISTAKE IT GUARDS AGAINST IS REAL AND WAS SHIPPED: the placeholder row
 * rendered the ordinary task row, link and all, and
 * `<HoverPrefetchLink href={`/tasks/optimistic-0`}>` fetched that page on hover
 * — which reached Postgres and came back `invalid input syntax for type uuid:
 * "optimistic-0"`. Every control on that row had the same hole: a priority, a
 * date or a delete pressed before the server answered would have sent this
 * string to an action typed `uuid`.
 *
 * So the rule is: a placeholder row is INERT. It shows what was typed and says
 * it is still going in. `isPlaceholder` is how every renderer asks.
 */
const PLACEHOLDER_PREFIX = "optimistic-";

/**
 * A counter rather than the array length it used to be.
 *
 * ⚠️ THE LENGTH WAS ONLY EVER UNIQUE BECAUSE `useOptimistic` THREW THE ROW AWAY
 * A MOMENT LATER. The cache keeps it until the refetch replaces it, so two rows
 * typed in quick succession would both be `optimistic-0` and React would warn
 * about a duplicate key — and, worse, `dropPlaceholders` below would take the
 * wrong one.
 */
let placeholderSeq = 0;

/** The key for the next pending row. Never reaches the database. */
export function placeholderId(): string {
  placeholderSeq += 1;
  return `${PLACEHOLDER_PREFIX}${placeholderSeq}`;
}

/** True for a row that exists only in this browser. Nothing may be sent about it. */
export function isPlaceholder(id: string): boolean {
  return id.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * A row for a task that does not exist yet.
 *
 * ⚠️ IT CARRIES ONLY WHAT WAS TYPED. Everything else on a task row — the
 * assignee's name, the reference, the counts — is resolved server-side and would
 * be a guess here, so the placeholder shows the title and nothing else rather
 * than inventing fields that change when the real row lands.
 *
 * ⚠️ `request_id: null` IS STATED RATHER THAN OMITTED. The composer cannot
 * create client-backed work — that only ever arrives through a request — and
 * `taskCategory` reads this field, where `undefined !== null` would put the
 * client-work accent edge on a row that has no client.
 *
 * It goes into the LIST and BOARD entries only, never into a detail entry: those
 * are keyed by a task id this row does not have.
 */
export function addPlaceholderRow(
  client: QueryClient,
  row: { id: string; title: string; status: string },
): void {
  const placeholder = { ...row, depth: 0, request_id: null, parent_task_id: null };

  client.setQueriesData({ queryKey: qk.tasks() }, (data: unknown) => {
    if (!isRecord(data)) return data;

    /* `rows` is the list's array and `live` is the board's. A new task is never
       terminal, so `finished` is deliberately not touched. */
    const field = Array.isArray(data.rows) ? "rows" : Array.isArray(data.live) ? "live" : null;
    if (!field) return data;

    return { ...data, [field]: [...(data[field] as unknown[]), placeholder] };
  });
}

/* -------------------------------------------------------------------------- */
/* The lookups a row renders beside itself.                                    */
/* -------------------------------------------------------------------------- */

/**
 * P7-13 — somebody joining or leaving a task, on the row.
 *
 * The list reads the join table as one `.in("task_id", …)` query and hands the
 * rows out per task (`TaskListView.assignees`), so the monogram stack is fed
 * from that array rather than from a per-task key. One link added or removed is
 * one element of it.
 *
 * ⚠️ `assignee_id` IS NOT PREDICTED. `vizserve_pms_remove_task_assignee`
 * promotes the next assignee into that column on the way out, and which one it
 * picks is the database's decision. The stack moves now; who ends up accountable
 * arrives with the refetch.
 */
export function patchTaskAssignee(
  client: QueryClient,
  taskId: string,
  userId: string,
  onTask: boolean,
): void {
  client.setQueriesData({ queryKey: qk.tasks() }, (data: unknown) => {
    if (!isRecord(data) || !Array.isArray(data.assignees)) return data;

    const links = data.assignees as { task_id?: unknown; user_id?: unknown }[];
    const has = links.some((link) => link.task_id === taskId && link.user_id === userId);

    if (onTask === has) return data;

    return {
      ...data,
      assignees: onTask
        ? [...links, { task_id: taskId, user_id: userId }]
        : links.filter((link) => !(link.task_id === taskId && link.user_id === userId)),
    };
  });
}

/**
 * P7-08 — the comment appears when you post it.
 *
 * ⚠️ TWO ENTRIES, TWO SHAPES, AND THE SECOND IS EASY TO FORGET. The detail
 * page's thread is `qk.taskPart(id, "comments")`; the LIST carries a
 * latest-comment column read out of `TaskListView.comments`, which is under
 * `["tasks"]` — a different ROOT that `["task", id]` cannot prefix-match however
 * long you stare at the pair. `INVALIDATES` in `realtime.ts` records the same
 * trap for the same table.
 *
 * ⚠️ THE ROW IS MARKED AND SAYS SO. Predicting that a comment WILL be accepted
 * is fine; pretending it already has been is not — `isPlaceholder` is what the
 * thread dims and captions "Sending…", so nobody quotes a comment in a meeting
 * that never landed.
 */
export function addPlaceholderComment(
  client: QueryClient,
  taskId: string,
  comment: { id: string; body: string; author_id: string; created_at: string },
): void {
  const row = { ...comment, updated_at: comment.created_at };

  client.setQueryData(qk.taskPart(taskId, "comments"), (data: unknown) =>
    Array.isArray(data) ? [...data, row] : data,
  );

  client.setQueriesData({ queryKey: qk.tasks() }, (data: unknown) => {
    if (!isRecord(data) || !Array.isArray(data.comments)) return data;
    return { ...data, comments: [...data.comments, { ...row, task_id: taskId }] };
  });
}

/**
 * A file removed from the Outputs panel.
 *
 * One panel, not the task: removing an attachment changes nothing about the row,
 * which is why this is `qk.taskPart(id, "attachments")` alone.
 */
export function dropTaskPartRow(
  client: QueryClient,
  taskId: string,
  part: TaskPart,
  rowId: string,
): void {
  client.setQueryData(qk.taskPart(taskId, part), (data: unknown) =>
    Array.isArray(data) ? data.filter((row) => !isRecord(row) || row.id !== rowId) : data,
  );
}
