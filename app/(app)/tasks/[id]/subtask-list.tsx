import Link from "next/link";

import { TaskPriorityBadge, TaskStatusGlyph } from "@/components/status-badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, isOverdue } from "@/lib/dates";
import { isTerminal, type TaskPriority, type TaskStatus } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { AddSubtask, SubtaskProgress } from "../inline";
import type { Assignable } from "../task-composer";

/**
 * P7-28 — the children, on the page you work on.
 *
 * THE DETAIL PAGE HAS NEVER HAD ONE. The list has drawn a progress bar from
 * these since K5 and the board has shown a count, so the one screen you open to
 * actually do the task was the one screen that could not tell you it had four
 * of them — or let you add one.
 *
 * The bar is `SubtaskProgress`, the same component the list row uses, so the
 * two cannot disagree about what "3/5" means. Adding one is `AddSubtask`, which
 * opens the same composer the foot of a list group opens with `parent_task_id`
 * set — no second "make a task" form, and no new server action.
 */
export type Subtask = {
  id: string;
  title: string;
  status: TaskStatus;
  due_date: string | null;
  assignee_id: string | null;
  priority: TaskPriority | null;
};

export function SubtaskList({
  parentId,
  subtasks,
  nameOf,
  assignable,
  canAdd,
}: {
  parentId: string;
  subtasks: Subtask[];
  nameOf: Map<string, string>;
  assignable: Assignable[];
  /** A finished task takes no new children, and neither does somebody else's. */
  canAdd: boolean;
}) {
  const done = subtasks.filter((subtask) => isTerminal(subtask.status)).length;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Subtasks</CardTitle>
        <CardAction className="flex items-center gap-2">
          {/* Renders nothing at zero, by its own rule — a permanent 0/0 is the
              same lie as a permanent zero on a dashboard tile. */}
          <SubtaskProgress done={done} total={subtasks.length} />
          {canAdd ? <AddSubtask parentId={parentId} assignable={assignable} /> : null}
        </CardAction>
      </CardHeader>

      <CardContent>
        {subtasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {canAdd
              ? "Nothing broken out yet. Add one to split this into steps that can be finished separately."
              : "Nothing broken out yet."}
          </p>
        ) : (
          <ul className="-my-1">
            {subtasks.map((subtask) => {
              const late = isOverdue(subtask.due_date) && !isTerminal(subtask.status);

              return (
                <li key={subtask.id} className="border-b py-1.5 last:border-0">
                  <div className="flex items-center gap-2">
                    <TaskStatusGlyph status={subtask.status} />

                    <Link
                      href={`/tasks/${subtask.id}`}
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm hover:underline",
                        // A finished child stays readable but stops competing
                        // with the ones that still need doing.
                        isTerminal(subtask.status) ? "text-muted-foreground" : null,
                      )}
                      title={subtask.title}>
                      {subtask.title}
                    </Link>

                    <TaskPriorityBadge priority={subtask.priority} />

                    {subtask.due_date ? (
                      <span
                        className={cn(
                          "shrink-0 text-2xs whitespace-nowrap",
                          late ? "font-medium text-destructive" : "text-muted-foreground",
                        )}>
                        {formatDate(subtask.due_date)}
                        {late ? " · overdue" : null}
                      </span>
                    ) : null}

                    {subtask.assignee_id ? (
                      <span className="hidden shrink-0 text-2xs whitespace-nowrap text-muted-foreground sm:inline">
                        {nameOf.get(subtask.assignee_id) ?? "Someone no longer active"}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
