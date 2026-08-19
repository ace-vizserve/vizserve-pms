import { CornerDownRight, ListChecks, ListTree } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { TaskStatusGlyph, isTaskStatus } from "@/components/status-badge";
import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate, isOverdue } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  isTerminal,
  TASK_CATEGORY_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  taskCategory,
  type TaskPriority,
} from "@/lib/schemas/tasks";
import { formatCellDuration } from "@/lib/schemas/timesheet";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { cn } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import type { TaskComment } from "./comment-thread";
import { LatestCommentCell } from "./latest-comment-cell";

import { GroupComposer } from "./add-task";
import { AssigneePicker } from "./assignees";
import { TaskSelectCheckbox, TaskSelectionProvider } from "./task-selection";
import { TaskFilters } from "./filters";
import { InlineDate, InlineEstimate, InlinePriority, SubtaskProgress, TaskRowActions } from "./inline";
import { NewTaskButton } from "./new-task-button";
import { TaskStatusGroup } from "./status-group";
import { TaskStatusSelect } from "./status-select";
import { TaskToolbar } from "./toolbar";

export const metadata: Metadata = { title: "Tasks" };

type TaskRow = {
  id: string;
  title: string;
  status: VizservePmsTaskStatus;
  due_date: string | null;
  start_date: string | null;
  assignee_id: string | null;
  qa_assignee_id: string | null;
  department_id: string;
  list_id: string | null;
  request_id: string | null;
  /** P7-19. Whoever filed it — a member may delete a task they created. */
  created_by: string | null;
  /** P7-01. With `request_id`, decides which of the three categories this is. */
  is_personal: boolean;
  /** P7-11. Null on most tasks — that is the ordinary state, not a gap. */
  priority: TaskPriority | null;
  /** P7-15. Minutes somebody expects it to take. Null = nobody estimated. */
  estimate_minutes: number | null;
  /** P7-09. Set on a subtask, so the row can say what it belongs to. */
  parent_task_id: string | null;
  /**
   * Fetched only to answer "is the resolution gate met" for the status control.
   * Never rendered here — it is a paragraph, and a row is not where it is read.
   */
  resolution: string | null;
};

/**
 * A row as the table renders it — a task plus how deep it sits.
 *
 * P7-09. Only two levels exist (`parent_task_id` is one level by trigger), so
 * this is 0 or 1 and never a tree.
 */
type ListRow = TaskRow & { depth: 0 | 1 };

/** `?sort=` — the two orders a task list is actually read in. */
const SORTS = ["due", "priority"] as const;
type Sort = (typeof SORTS)[number];

function isSort(value: string | undefined): value is Sort {
  return typeof value === "string" && (SORTS as readonly string[]).includes(value);
}

function isPriority(value: string | undefined): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

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
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    view?: string;
    list?: string;
    group?: string;
    kind?: string;
    priority?: string;
    sort?: string;
  }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  const view = params.view === "mine" || params.view === "qa" ? params.view : "all";

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
  const kind = params.kind === "internal" || params.kind === "client" ? params.kind : "all";
  const priorityFilter = isPriority(params.priority) ? params.priority : null;
  const sort: Sort = isSort(params.sort) ? params.sort : "due";

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
   * ids first — the lists query below sits in the same `Promise.all` as this
   * one, so reading it first would make the slow query wait on the fast one.
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
  query =
    sort === "priority"
      ? query
          .order("priority", { ascending: false, nullsFirst: false })
          .order("due_date", { ascending: true, nullsFirst: false })
      : query
          // Nearest deadline first; undated work sinks rather than leading.
          .order("due_date", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: false });

  if (isTaskStatus(params.status)) query = query.eq("status", params.status);
  if (params.list) query = query.eq("list_id", params.list);
  if (params.group) query = query.eq("vizserve_pms_lists.group_id", params.group);
  if (priorityFilter) query = query.eq("priority", priorityFilter);
  if (kind === "client") query = query.not("request_id", "is", null);
  if (kind === "internal") query = query.is("request_id", null);
  if (view === "mine") query = query.eq("assignee_id", context.userId);
  // P3-08 — the QA queue is a view of this list, not a separate screen with a
  // separate set of rules that can drift from it.
  if (view === "qa") {
    query = query.eq("qa_assignee_id", context.userId).in("status", ["FOR_QA", "QA_IN_PROGRESS"]);
  }

  const [{ data: tasks, error: tasksError }, { data: people }, { data: lists }, { data: groups }] =
    await Promise.all([
      query,
      supabase.from("vizserve_pms_users").select("id, full_name, primary_department_id, is_active"),
      supabase
        .from("vizserve_pms_lists")
        .select("id, name, group_id")
        .eq("is_active", true)
        .order("name"),
      // P7-18. The reserved folder is offered like any other here — "show me
      // everything that came through a form" is a filter people want, and it is
      // the one folder guaranteed to exist.
      supabase
        .from("vizserve_pms_task_groups")
        .select("id, name")
        .eq("is_active", true)
        .order("sort_order")
        .order("name"),
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
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));
  const listName = new Map((lists ?? []).map((list) => [list.id, list.name]));

  // Threads by task, oldest first — the order they were fetched in, so the cell
  // can take the last one without sorting again.
  const threads = new Map<string, TaskComment[]>();
  for (const row of commentRows ?? []) {
    const thread = threads.get(row.task_id) ?? [];
    thread.push({
      id: row.id,
      body: row.body,
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
    TASK_STATUSES.map((status) => [status, [] as ListRow[]]),
  );

  for (const task of rows) {
    if (nested.has(task.id)) continue;

    const bucket = grouped.get(task.status);
    if (!bucket) continue;

    bucket.push({ ...task, depth: 0 });
    for (const child of childrenByParent.get(task.id) ?? []) {
      bucket.push({ ...child, depth: 1 });
    }
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
        (context.role === "admin" || assignableScope.has(person.primary_department_id)),
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

  const isAdmin = roleAtLeast(context.role, "admin");
  /**
   * P7-19 — whether to offer the trash on this row.
   *
   * Mirrors `vizserve_pms_can_delete_task`: internal work only, and only for a
   * lead of the department, whoever created it, or the owner of a personal task.
   * The database is still the authority — this only decides whether to ask, so
   * nobody is offered a control that can only answer no.
   */
  function canDelete(task: TaskRow) {
    if (task.request_id !== null) return false;
    const leads =
      context.role === "admin" || context.managedDepartmentIds.includes(task.department_id);
    return (
      leads ||
      task.created_by === context.userId ||
      (task.is_personal && task.assignee_id === context.userId)
    );
  }

  function seat(task: TaskRow) {
    return {
      isPic: task.assignee_id === context.userId,
      isQa: task.qa_assignee_id === context.userId,
      leadsDepartment: context.role === "admin" || context.managedDepartmentIds.includes(task.department_id),
      isAdmin,
    };
  }

  /*
   * The columns, in the order Amier's reference sets them: name · progress ·
   * assignee · priority · start · due · date closed · estimate · tracked ·
   * latest comment.
   *
   * THE QA COLUMN IS GONE. It was a name repeated on every client row and empty
   * on every internal one — internal work needs no reviewer at all since P7-13a,
   * which is most of the list. The reviewer is on the task itself, where the
   * decision to appoint one is made.
   */
  const columns: Column<ListRow>[] = [
    {
      /*
       * P7-19 — the selection column.
       *
       * A checkbox ONLY where the row can actually be deleted, on the same rule
       * as the per-row trash: `canDelete` mirrors
       * `vizserve_pms_can_delete_task`, so client-backed work and a colleague's
       * tasks have nothing to tick. The cell is not merely disabled — a
       * disabled checkbox on two thirds of the rows reads as the feature being
       * broken rather than as the row being out of scope.
       */
      key: "select",
      header: "",
      className: "w-8 pr-0",
      cell: (task) =>
        canDelete(task) ? <TaskSelectCheckbox taskId={task.id} title={task.title} /> : null,
    },
    {
      key: "task",
      header: "Task",
      className: "max-w-sm whitespace-normal",
      cell: (task) => {
        const isChild = task.depth === 1;

        return (
          // `group/task` is what the hover strip keys off. Named, because the
          // status group above is a group too and an unnamed one would make the
          // whole panel's hover reveal every row's actions at once.
          //
          // P7-09. A subtask is INDENTED rather than labelled. The old row said
          // "⊢ subtask" in the meta line underneath and sat flush with its
          // parent, which reads as two tasks that happen to mention each other.
          // The indent is the relationship — it is how every reference draws it,
          // and it survives a screenshot where a word in a meta row does not.
          <div className={cn("group/task", isChild && "pl-6")}>
            <span className="flex min-w-0 items-center gap-2">
              {/* The elbow. Decoration only — the row's meaning is carried by
                  the indent and by the parent link in the meta line, so this is
                  hidden from a screen reader rather than read out as a glyph.
                  `--foreground-faint` is legal here for exactly that reason:
                  it is 3.44:1 and NON-TEXT ONLY (§1.1). */}
              {isChild ? (
                <CornerDownRight
                  aria-hidden
                  className="-ml-4 size-3.5 shrink-0 text-foreground-faint"
                />
              ) : null}

              {/*
                The stage, always visible and BEFORE the title — the shape the
                reference uses. It is not the hover strip's status control: that
                one moves the task and disappears when there is nowhere legal to
                move to, which is exactly when a reader still needs to know where
                the task is. See the note on `TaskStatusGlyph`.
              */}
              <TaskStatusGlyph status={task.status} />

              <Link
                href={`/tasks/${task.id}`}
                className={cn(
                  "truncate hover:underline",
                  // A subtask is a smaller thing than its parent and should not
                  // compete with it for the eye.
                  isChild ? "text-sm font-normal" : "font-medium",
                )}>
                {task.title}
              </Link>

              {/* Renders nothing when unranked, which is most tasks. A "None"
                  chip on every row would mark everything, and a mark carried by
                  everything marks nothing. */}
              <InlinePriority taskId={task.id} value={task.priority} />

              <TaskRowActions
                taskId={task.id}
                title={task.title}
                priority={task.priority}
                assignable={assignable}
                deletable={canDelete(task)}>
                {/* The glyph, not the chip: the group heading right above this
                    row already says the status in words. */}
                <TaskStatusSelect
                  taskId={task.id}
                  status={task.status}
                  viewer={seat(task)}
                  task={task}
                  resolutionMissing={!task.resolution?.trim()}
                  variant="compact"
                />
              </TaskRowActions>
            </span>

            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
              {task.list_id ? <span>{listName.get(task.list_id)}</span> : null}
              {/* P7-01. THREE categories, not two. "Added by hand" used to cover
                  both work a lead assigned you and work you made for yourself —
                  and those finish differently: an assigned task goes through
                  review, a personal one you close yourself. The distinction this
                  slice exists to make is not visible unless it is said here. */}
              <span>{TASK_CATEGORY_LABELS[taskCategory(task)]}</span>
              {/* A subtask says so. Without it the list shows two rows that look
                  like peers when one is part of the other. */}
              {/*
                P7-09. Only when the row is NOT already sitting under its parent.
                Once it is indented, the indent says "subtask" and a word saying
                it again is a word people stop reading. This survives for the two
                cases where the indent cannot: a subtask whose parent is filtered
                off screen, and a finished one that has left the nest for its own
                terminal group.
              */}
              {task.parent_task_id && task.depth === 0 ? (
                <Link href={`/tasks/${task.parent_task_id}`} className="inline-flex items-center gap-1 hover:underline">
                  <ListTree className="size-3" aria-hidden />
                  subtask
                </Link>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      /*
       * K5 — PROGRESS, from the subtasks and nowhere else.
       *
       * A task with no children renders NOTHING rather than 0%: "no subtasks"
       * and "no subtasks done" are different facts, and a permanent 0% is the
       * same lie as a permanent zero on a dashboard tile.
       */
      key: "progress",
      header: "Progress",
      className: "hidden lg:table-cell",
      cell: (task) => {
        const bars = progress.get(task.id);
        return bars ? <SubtaskProgress done={bars.done} total={bars.total} /> : null;
      },
    },
    {
      key: "assignee",
      header: "Assignee",
      className: "hidden md:table-cell text-muted-foreground",
      cell: (task) => (
        <AssigneePicker
          taskId={task.id}
          pic={task.assignee_id ? { id: task.assignee_id, full_name: nameOf.get(task.assignee_id) ?? "—" } : null}
          // P7-13. The join table is the whole reason this is fetched: a row
          // showing one name on a task three people are working on makes the
          // second and third invisible.
          others={(extraAssignees.get(task.id) ?? []).filter((person) => person.id !== task.assignee_id)}
          // Scoped to the TASK'S department, not the viewer's — the join table's
          // own function refuses anybody outside it, so offering a wider list
          // would only produce an error after the click.
          candidates={byDepartment.get(task.department_id) ?? []}
          canEdit={seat(task).isPic || seat(task).isQa || seat(task).leadsDepartment}
        />
      ),
    },
    {
      key: "priority",
      header: "Priority",
      className: "hidden lg:table-cell",
      // Its own column now, and editable in place. It used to sit beside the
      // title, which read well at one glance and badly at twenty — a column is
      // what makes "what is urgent" answerable by scanning down.
      cell: (task) => <InlinePriority taskId={task.id} value={task.priority} />,
    },
    {
      key: "start",
      header: "Start date",
      className: "hidden xl:table-cell whitespace-nowrap",
      cell: (task) => <InlineDate taskId={task.id} field="start_date" value={task.start_date} label="Start" />,
    },
    {
      key: "due",
      header: "Due date",
      className: "hidden sm:table-cell whitespace-nowrap",
      cell: (task) => (
        <>
          <InlineDate
            taskId={task.id}
            field="due_date"
            value={task.due_date}
            label="Due"
            // Overdue only matters on work that is still live. A completed task
            // delivered late is history, not an alarm.
            emphasis={isOverdue(task.due_date) && !isTerminal(task.status)}
          />
          {/* Never colour alone. */}
          {isOverdue(task.due_date) && !isTerminal(task.status) ? (
            <span className="ml-1 text-2xs text-destructive">overdue</span>
          ) : null}
        </>
      ),
    },
    {
      /*
       * Read from `vizserve_pms_task_status_history`, never from a column.
       *
       * A `completed_at` column can disagree with the trail; the trail cannot
       * disagree with itself. It is also correctly EMPTY on a task that was
       * closed and then reopened — which internal work can be (P7-06) — because
       * what the column asks is "when was this closed", and a live task has no
       * answer to that.
       */
      key: "closed",
      header: "Date closed",
      className: "hidden 2xl:table-cell whitespace-nowrap text-muted-foreground",
      cell: (task) => {
        const closed = isTerminal(task.status) ? closedOn.get(task.id) : null;
        return closed ? formatDate(closed.slice(0, 10)) : <span className="text-foreground-faint">—</span>;
      },
    },
    {
      key: "estimate",
      header: "Time estimate",
      className: "hidden xl:table-cell whitespace-nowrap",
      align: "end",
      cell: (task) => <InlineEstimate taskId={task.id} minutes={task.estimate_minutes} />,
    },
    {
      /*
       * P7-15 — TIME TRACKED CANNOT BE A PLAIN SUM, and this is the trap.
       *
       * The entries policy is owner-or-their-lead, so summing that table
       * client-side shows each viewer only their own hours and calls it the task
       * total. Two people on one task would read two different figures. The
       * rollup is `SECURITY DEFINER` for exactly that reason.
       */
      key: "tracked",
      header: "Time tracked",
      className: "hidden xl:table-cell whitespace-nowrap",
      align: "end",
      cell: (task) => {
        const minutes = tracked.get(task.id) ?? 0;
        const over = task.estimate_minutes !== null && minutes > task.estimate_minutes;

        if (minutes === 0) return <span className="text-foreground-faint">—</span>;

        return (
          <span
            className={cn("tabular-nums", over ? "font-medium text-warning" : "text-muted-foreground")}
            title={
              over
                ? `Over the estimate — ${formatCellDuration(minutes)} against ${formatCellDuration(task.estimate_minutes!)}`
                : `${formatCellDuration(minutes)} logged`
            }>
            {formatCellDuration(minutes)}
            {/* Never colour alone. */}
            {over ? <span className="ml-0.5 text-2xs">over</span> : null}
          </span>
        );
      },
    },
    {
      key: "comment",
      header: "Latest comment",
      // Last, and the widest thing in the row. It is the only cell that is a
      // control rather than a value, so it sits where the eye finishes.
      className: "hidden 2xl:table-cell",
      cell: (task) => (
        <LatestCommentCell
          taskId={task.id}
          taskTitle={task.title}
          comments={threads.get(task.id) ?? []}
          viewerId={context.userId}
        />
      ),
    },
  ];

  return (
    <PageShell>
      <div className="flex flex-wrap items-center gap-2">
        <TaskToolbar view="list" />
        <div className="ml-auto">
          <NewTaskButton />
        </div>
      </div>

      <TaskFilters lists={lists ?? []} groups={groups ?? []} />

      {/* Three messages, because there are three ways of arriving at an empty
          screen and only two of them are somebody's fault: a filter that is too
          narrow needs loosening, an empty system needs explaining, and a failed
          query needs saying out loud rather than being dressed up as either of
          the others. Drawing eight empty stage headings in any of those cases
          would bury the sentence that actually helps. */}
      {tasksError ? (
        <QueryError what="tasks" message={tasksError.message} />
      ) : rows.length === 0 ? (
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
              title="Nothing here yet"
              description="Tasks appear once a Team Leader approves a request, or when one is added by hand. Each moves through set stages — the server refuses any step that is not one of them."
            />
          )}
        </div>
      ) : (
        <TaskSelectionProvider>
        <div className="flex flex-col gap-3">
          {visibleStatuses.map((status) => {
            const group = grouped.get(status) ?? [];

            return (
              <TaskStatusGroup
                key={status}
                status={status}
                count={group.length}
                // A stage with nothing in it opens to one line. Closing it by
                // default would hide the only thing it has to say.
                defaultOpen>
                {/*
                  THE TABLE IS ALWAYS RENDERED, even for an empty stage, because
                  the composer is a `<tr>` inside it — a stage with nothing in it
                  is exactly where somebody wants to add the first task, and a
                  paragraph cannot hold a row. The empty sentence moves into the
                  table as its `empty` state.
                */}
                <DataTable
                  bare
                  columns={columns}
                  rows={group}
                  getRowKey={(task) => task.id}
                  empty={
                    <p className="px-3.5 py-4 text-xs text-muted-foreground">
                      {status === INITIAL_TASK_STATUS
                        ? "Nothing waiting to be picked up."
                        : "Nothing at this stage. Work reaches it from the stage before."}
                    </p>
                  }
                  appendRow={
                    status === "FOR_CLIENT_APPROVAL" ? null : (
                      <GroupComposer status={status} assignable={assignable} columnCount={columns.length} />
                    )
                  }
                />

                {/*
                  The dialog, under the first heading only.

                  The composer above now covers everything it does except a
                  description, a list and a QA reviewer — so repeating it under
                  eight headings would be eight controls that mostly duplicate the
                  row directly above them. It renders nothing at all for a member
                  with nobody to assign to, and settles that for itself rather
                  than the page guessing.
                */}
              </TaskStatusGroup>
            );
          })}
        </div>
        </TaskSelectionProvider>
      )}
    </PageShell>
  );
}
