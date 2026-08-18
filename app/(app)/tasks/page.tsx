import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate, isOverdue } from "@/lib/dates";
import { INITIAL_TASK_STATUS, TASK_STATUSES, isTerminal } from "@/lib/schemas/tasks";
import { isTaskStatus } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { createClient } from "@/utils/supabase/server";

import { TaskFilters } from "./filters";
import { NewTaskButton } from "./new-task-button";
import { TaskStatusGroup } from "./status-group";
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
  list_id: string | null;
  request_id: string | null;
};

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
 * the heading. The group header carries the chip, the glyph and the label.
 *
 * No <h1>. The shell breadcrumb is the page label, and the toolbar already says
 * which slice of the list you are looking at.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; view?: string; list?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  const view = params.view === "mine" || params.view === "qa" ? params.view : "all";

  let query = supabase
    .from("vizserve_pms_tasks")
    .select(
      "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, list_id, request_id, resolution",
    )
    // Nearest deadline first; undated work sinks rather than leading the queue.
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (isTaskStatus(params.status)) query = query.eq("status", params.status);
  if (params.list) query = query.eq("list_id", params.list);
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

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));
  const listName = new Map((lists ?? []).map((list) => [list.id, list.name]));

  const rows = (tasks ?? []) as TaskRow[];
  const isFiltered = Boolean(params.status || params.list) || view !== "all";

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

  const columns: Column<TaskRow>[] = [
    {
      key: "task",
      header: "Task",
      className: "max-w-sm whitespace-normal",
      cell: (task) => (
        <>
          <Link href={`/tasks/${task.id}`} className="font-medium hover:underline">
            {task.title}
          </Link>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-muted-foreground">
            {task.list_id ? <span>{listName.get(task.list_id)}</span> : null}
            {/* Where it came from. A manual task has no request and saying so is
                more useful than an empty column. */}
            <span>{task.request_id ? "From a request" : "Added by hand"}</span>
          </div>
        </>
      ),
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
      className: "hidden lg:table-cell text-muted-foreground",
      cell: (task) => (task.qa_assignee_id ? (nameOf.get(task.qa_assignee_id) ?? "—") : "—"),
    },
    {
      key: "start",
      header: "Start",
      className: "hidden lg:table-cell whitespace-nowrap text-muted-foreground",
      cell: (task) => formatDate(task.start_date),
    },
    {
      key: "due",
      header: "Due",
      className: "hidden sm:table-cell whitespace-nowrap",
      cell: (task) => {
        // Overdue only matters on work that is still live. A completed task
        // delivered late is history, not an alarm.
        const late = isOverdue(task.due_date) && !isTerminal(task.status);

        return (
          <>
            <span className={late ? "font-medium text-destructive" : "text-muted-foreground"}>
              {formatDate(task.due_date)}
            </span>
            {/* Never colour alone. */}
            {late ? <span className="ml-1 text-2xs text-destructive">overdue</span> : null}
          </>
        );
      },
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
                    : "Clear the status or list filter to see the rest of the list."
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

                {/* Renders nothing at all for a member — creating work for other
                    people is a Team Leader decision, and the button settles that
                    for itself rather than the page guessing at the role. */}
                {status === INITIAL_TASK_STATUS ? <NewTaskButton trigger="row" /> : null}
              </TaskStatusGroup>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
