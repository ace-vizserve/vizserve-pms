import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks, ListTree } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { isOverdue } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  TASK_CATEGORY_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  isTerminal,
  taskCategory,
} from "@/lib/schemas/tasks";
import { formatCellDuration } from "@/lib/schemas/timesheet";
import { isTaskStatus } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";

import type { TaskComment } from "./comment-thread";
import { LatestCommentCell } from "./latest-comment-cell";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { createClient } from "@/utils/supabase/server";

import { TaskFilters } from "./filters";
import {
  InlineDate,
  InlineEstimate,
  InlinePriority,
  SubtaskProgress,
  TaskRowActions,
} from "./inline";
import { NewTaskButton } from "./new-task-button";
import { QuickAddTask } from "./quick-add";
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

  let query = supabase
    .from("vizserve_pms_tasks")
    .select(
      "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, list_id, request_id, is_personal, priority, estimate_minutes, parent_task_id, resolution",
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
  if (priorityFilter) query = query.eq("priority", priorityFilter);
  if (kind === "client") query = query.not("request_id", "is", null);
  if (kind === "internal") query = query.is("request_id", null);
  if (view === "mine") query = query.eq("assignee_id", context.userId);
  // P3-08 — the QA queue is a view of this list, not a separate screen with a
  // separate set of rules that can drift from it.
  if (view === "qa") {
    query = query.eq("qa_assignee_id", context.userId).in("status", ["FOR_QA", "QA_IN_PROGRESS"]);
  }

  const [{ data: tasks, error: tasksError }, { data: people }, { data: lists }] = await Promise.all(
    [
      query,
      supabase.from("vizserve_pms_users").select("id, full_name"),
      supabase.from("vizserve_pms_lists").select("id, name").eq("is_active", true).order("name"),
    ],
  );

  const rows = (tasks ?? []) as TaskRow[];
  const taskIds = rows.map((task) => task.id);

  /*
   * Three queries against the visible ids, run together.
   *
   * All three are scoped by `.in()` on ids the policy has ALREADY returned, so a
   * task somebody cannot see cannot have its comments, its children or its hours
   * pulled in through the back door — and each of the three has its own policy
   * underneath this anyway.
   */
  const [{ data: commentRows }, { data: childRows }, { data: trackedRows }] = taskIds.length
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
        supabase
          .from("vizserve_pms_tasks")
          .select("id, parent_task_id, status")
          .in("parent_task_id", taskIds),

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
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

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

  const tracked = new Map(
    ((trackedRows ?? []) as { task_id: string; minutes: number }[]).map((row) => [
      row.task_id,
      row.minutes,
    ]),
  );

  const isFiltered =
    Boolean(params.status || params.list || priorityFilter) || view !== "all" || kind !== "all";

  const grouped = new Map<VizservePmsTaskStatus, TaskRow[]>(
    TASK_STATUSES.map((status) => [status, [] as TaskRow[]]),
  );
  for (const task of rows) grouped.get(task.status)?.push(task);

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
  const isAdmin = roleAtLeast(context.role, "admin");
  function seat(task: TaskRow) {
    return {
      isPic: task.assignee_id === context.userId,
      isQa: task.qa_assignee_id === context.userId,
      leadsDepartment:
        context.role === "admin" || context.managedDepartmentIds.includes(task.department_id),
      isAdmin,
    };
  }

  const columns: Column<TaskRow>[] = [
    {
      key: "task",
      header: "Task",
      className: "max-w-sm whitespace-normal",
      cell: (task) => {
        const bars = progress.get(task.id);

        return (
          // `group/task` is what the hover strip keys off. Named, because the
          // status group above is a group too and an unnamed one would make the
          // whole panel's hover reveal every row's actions at once.
          <div className="group/task">
            <span className="flex min-w-0 items-center gap-2">
              <Link href={`/tasks/${task.id}`} className="truncate font-medium hover:underline">
                {task.title}
              </Link>

              {/* Renders nothing when unranked, which is most tasks. A "None"
                  chip on every row would mark everything, and a mark carried by
                  everything marks nothing. */}
              <InlinePriority taskId={task.id} value={task.priority} />

              <TaskRowActions taskId={task.id} title={task.title} priority={task.priority}>
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
              {task.parent_task_id ? (
                <Link
                  href={`/tasks/${task.parent_task_id}`}
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  <ListTree className="size-3" aria-hidden />
                  subtask
                </Link>
              ) : null}
              {bars ? <SubtaskProgress done={bars.done} total={bars.total} /> : null}
            </div>
          </div>
        );
      },
    },
    {
      key: "pic",
      header: "PIC",
      className: "hidden md:table-cell text-muted-foreground",
      cell: (task) => (task.assignee_id ? (nameOf.get(task.assignee_id) ?? "—") : "Unassigned"),
    },
    {
      key: "qa",
      header: "QA",
      className: "hidden 2xl:table-cell text-muted-foreground",
      cell: (task) => (task.qa_assignee_id ? (nameOf.get(task.qa_assignee_id) ?? "—") : "—"),
    },
    {
      key: "start",
      header: "Start",
      className: "hidden lg:table-cell whitespace-nowrap",
      cell: (task) => (
        <InlineDate taskId={task.id} field="start_date" value={task.start_date} label="Start" />
      ),
    },
    {
      key: "due",
      header: "Due",
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
      key: "time",
      // Two figures in one column, because they are only meaningful beside each
      // other: an estimate with no hours against it is a guess nobody tested,
      // and hours with no estimate are a number with nothing to judge them by.
      header: "Tracked / est.",
      className: "hidden lg:table-cell whitespace-nowrap",
      align: "end",
      cell: (task) => {
        const minutes = tracked.get(task.id) ?? 0;
        const over = task.estimate_minutes !== null && minutes > task.estimate_minutes;

        return (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <span
              className={over ? "font-medium text-warning" : "text-muted-foreground"}
              // Never colour alone — and this is the one place the word has to
              // be in a tooltip rather than on screen, because a fourth glyph in
              // a numeric column stops it scanning down.
              title={
                over
                  ? `Over the estimate — ${formatCellDuration(minutes)} logged against ${formatCellDuration(task.estimate_minutes!)}`
                  : `${formatCellDuration(minutes)} logged`
              }
            >
              {minutes === 0 ? <span className="text-foreground-faint">—</span> : formatCellDuration(minutes)}
              {over ? <span className="ml-0.5 text-2xs">over</span> : null}
            </span>
            <span className="text-foreground-faint" aria-hidden>
              /
            </span>
            <InlineEstimate taskId={task.id} minutes={task.estimate_minutes} />
          </span>
        );
      },
    },
    {
      key: "comment",
      header: "Latest comment",
      // Last column, and the widest thing in the row. It is the only cell that
      // is a control rather than a value, so it sits where the eye finishes.
      className: "hidden xl:table-cell",
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

      <TaskFilters lists={lists ?? []} />

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
                defaultOpen
              >
                {group.length === 0 ? (
                  <p className="px-3.5 py-4 text-xs text-muted-foreground">
                    {status === INITIAL_TASK_STATUS
                      ? "Nothing waiting to be picked up."
                      : "Nothing at this stage. Work reaches it from the stage before."}
                  </p>
                ) : (
                  <DataTable bare columns={columns} rows={group} getRowKey={(task) => task.id} />
                )}

                {/*
                  Only under the first heading, and that is a database constraint
                  rather than a layout preference: `status` is not a writable
                  column and both create functions open every task at OPEN, so
                  this control under any other heading would promise a stage it
                  cannot produce. See `quickAddTask`.

                  The dialog stays beside it for the case where somebody wants
                  dates, an assignee and a priority in one pass — it renders
                  nothing at all for a member who has nobody to assign to, and
                  settles that for itself rather than the page guessing.
                */}
                {status === INITIAL_TASK_STATUS ? (
                  <>
                    <QuickAddTask />
                    <NewTaskButton trigger="row" />
                  </>
                ) : null}
              </TaskStatusGroup>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
