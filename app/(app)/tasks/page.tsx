import type { Metadata } from "next";
import Link from "next/link";

import { requireAuthContext } from "@/lib/auth/authorization";
import { formatDate, isOverdue } from "@/lib/dates";
import { isTerminal } from "@/lib/schemas/tasks";
import { TaskStatusBadge, isTaskStatus } from "@/components/status-badge";
import { createClient } from "@/utils/supabase/server";

import { TaskFilters } from "./filters";
import { NewTaskButton } from "./new-task-button";

export const metadata: Metadata = { title: "Tasks" };

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

  const [{ data: tasks }, { data: people }, { data: lists }] = await Promise.all([
    query,
    supabase.from("vizserve_pms_users").select("id, full_name"),
    supabase.from("vizserve_pms_lists").select("id, name").eq("is_active", true).order("name"),
  ]);

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));
  const listName = new Map((lists ?? []).map((list) => [list.id, list.name]));

  const heading =
    view === "mine" ? "My tasks" : view === "qa" ? "Waiting on my QA" : "Tasks";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Work created from an approved request, or added by hand. A task moves through set
            stages — the server refuses any step that is not one of them.
          </p>
        </div>
        <NewTaskButton />
      </div>

      <TaskFilters lists={lists ?? []} />

      {!tasks || tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm font-medium">Nothing here</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            {view === "qa"
              ? "No work is waiting on your review."
              : view === "mine"
                ? "You have no tasks assigned to you."
                : "Tasks appear once a Team Leader approves a request, or when one is added by hand."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Task</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">PIC</th>
                <th className="px-4 py-2.5 text-left font-medium">QA</th>
                <th className="px-4 py-2.5 text-left font-medium">Due</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                // Overdue only matters on work that is still live. A completed
                // task delivered late is history, not an alarm.
                const late = isOverdue(task.due_date) && !isTerminal(task.status);

                return (
                  <tr key={task.id} className="border-t align-top hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`/tasks/${task.id}`} className="font-medium hover:underline">
                        {task.title}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-muted-foreground">
                        {task.list_id ? <span>{listName.get(task.list_id)}</span> : null}
                        {/* Where it came from. A manual task has no request and
                            saying so is more useful than an empty column. */}
                        <span>{task.request_id ? "From a request" : "Added by hand"}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <TaskStatusBadge status={task.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {task.assignee_id ? nameOf.get(task.assignee_id) ?? "—" : "Unassigned"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {task.qa_assignee_id ? nameOf.get(task.qa_assignee_id) ?? "—" : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={late ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {formatDate(task.due_date)}
                      </span>
                      {late ? (
                        // Never colour alone.
                        <span className="ml-1 text-2xs text-destructive">overdue</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
