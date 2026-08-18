import type { Metadata } from "next";
import Link from "next/link";
import { List } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { formatDate, isOverdue } from "@/lib/dates";
import { TASK_STATUS_LABELS, TASK_STATUSES, isTerminal } from "@/lib/schemas/tasks";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Board" };

/**
 * P3-04 — the board.
 *
 * The list view is the requirement and this is the optional companion, so it is
 * built as a second READ of the same data rather than as a second system: same
 * RLS, same ordering, no drag-and-drop.
 *
 * Dragging is deliberately absent. A card dragged between columns is a status
 * transition, and half of those need a comment or a resolution first (P3-06/07)
 * — so a drag would either pop a modal, which is worse than a button, or
 * silently fail against the state machine, which is worse still. Cards link to
 * the task, where the legal moves are shown with their names.
 *
 * The two terminal columns are omitted. A board that accumulates every finished
 * ticket since launch stops being a board; finished work is a filter on the list
 * view, which is the right shape for it.
 */

const BOARD_COLUMNS = TASK_STATUSES.filter((status) => !isTerminal(status));

export default async function TaskBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("vizserve_pms_tasks")
    .select("id, title, status, due_date, assignee_id")
    .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)")
    .order("due_date", { ascending: true, nullsFirst: false });

  if (params.view === "mine") query = query.eq("assignee_id", context.userId);

  const [{ data: tasks }, { data: people }] = await Promise.all([
    query,
    supabase.from("vizserve_pms_users").select("id, full_name"),
  ]);

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));

  const byStatus = new Map(BOARD_COLUMNS.map((status) => [status, [] as typeof tasks]));
  for (const task of tasks ?? []) {
    byStatus.get(task.status)?.push(task);
  }

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb reads "Tasks / Board". The sentence stays: it
          is why there is no dragging, which is the first thing anyone tries. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Live work by stage. Open a card to move it — the steps available depend on where it is and
          whether you are the PIC or the reviewer.
        </p>
        <Link href="/tasks" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <List />
          List view
        </Link>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max gap-3">
          {BOARD_COLUMNS.map((status) => {
            const column = byStatus.get(status) ?? [];

            return (
              <div key={status} className="w-64 shrink-0 rounded-xl bg-muted/30 ring-1 ring-foreground/10">
                <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
                  <h2 className="text-xs font-semibold">{TASK_STATUS_LABELS[status]}</h2>
                  <span className="text-2xs tabular-nums text-muted-foreground">
                    {column.length}
                  </span>
                </div>

                <div className="space-y-2 p-2">
                  {column.length === 0 ? (
                    <p className="px-1 py-3 text-center text-2xs text-muted-foreground">Empty</p>
                  ) : (
                    column.map((task) => {
                      const late = isOverdue(task.due_date);

                      return (
                        <Link
                          key={task.id}
                          href={`/tasks/${task.id}`}
                          className="block rounded-lg bg-background p-2.5 text-sm ring-1 ring-foreground/10 transition-shadow hover:ring-primary/40"
                        >
                          <span className="line-clamp-2 font-medium">{task.title}</span>
                          <span className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
                            <span className="truncate">
                              {task.assignee_id
                                ? nameOf.get(task.assignee_id) ?? "—"
                                : "Unassigned"}
                            </span>
                            <span
                              className={late ? "shrink-0 font-medium text-destructive" : "shrink-0"}
                            >
                              {/* Never colour alone — "overdue" is spelled out. */}
                              {formatDate(task.due_date)}
                              {late ? " · overdue" : null}
                            </span>
                          </span>
                        </Link>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}
