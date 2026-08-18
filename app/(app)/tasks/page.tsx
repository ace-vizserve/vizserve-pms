import type { Metadata } from "next";
import Link from "next/link";
import { LayoutGrid, ListChecks } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate, isOverdue } from "@/lib/dates";
import { isTerminal } from "@/lib/schemas/tasks";
import { TaskStatusBadge, isTaskStatus } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";
import { createClient } from "@/utils/supabase/server";

import { TaskFilters } from "./filters";
import { NewTaskButton } from "./new-task-button";

export const metadata: Metadata = { title: "Tasks" };

type TaskRow = {
  id: string;
  title: string;
  status: VizservePmsTaskStatus;
  due_date: string | null;
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
 * No <h1>. The shell breadcrumb is the page label, and the view tabs already say
 * which slice of the list you are looking at — a heading that repeated "Waiting
 * on my QA" would be a second, staler copy of the same fact.
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
      "id, title, status, due_date, assignee_id, qa_assignee_id, department_id, list_id, request_id, resolution",
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

  const [{ data: tasks, error: tasksError }, { data: people }, { data: lists }] = await Promise.all([
    query,
    supabase.from("vizserve_pms_users").select("id, full_name"),
    supabase.from("vizserve_pms_lists").select("id, name").eq("is_active", true).order("name"),
  ]);

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));
  const listName = new Map((lists ?? []).map((list) => [list.id, list.name]));

  const rows = (tasks ?? []) as TaskRow[];
  const isFiltered = Boolean(params.status || params.list) || view !== "all";

  const columns: Column<TaskRow>[] = [
    {
      key: "task",
      header: "Task",
      className: "max-w-sm",
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
      key: "status",
      header: "Status",
      cell: (task) => <TaskStatusBadge status={task.status} />,
    },
    {
      key: "pic",
      header: "PIC",
      className: "hidden md:table-cell text-muted-foreground",
      cell: (task) => (task.assignee_id ? nameOf.get(task.assignee_id) ?? "—" : "Unassigned"),
    },
    {
      key: "qa",
      header: "QA",
      className: "hidden lg:table-cell text-muted-foreground",
      cell: (task) => (task.qa_assignee_id ? nameOf.get(task.qa_assignee_id) ?? "—" : "—"),
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href="/tasks/board" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <LayoutGrid />
          Board view
        </Link>
        <NewTaskButton />
      </div>

      <TaskFilters lists={lists ?? []} />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(task) => task.id}
        empty={
          /* Three messages now, because there are three ways of arriving here
             and only two of them are somebody's fault: a filter that is too
             narrow needs loosening, an empty list needs explaining, and a
             failed query needs saying out loud rather than being dressed up as
             either of the others. */
          tasksError ? (
            <QueryError what="tasks" message={tasksError.message} />
          ) : isFiltered ? (
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
          )
        }
      />
    </PageShell>
  );
}
