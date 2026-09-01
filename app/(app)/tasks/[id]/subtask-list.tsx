import Link from "next/link";

import { TaskPriorityBadge, TaskStatusGlyph } from "@/components/status-badge";
import { formatDate, isOverdue } from "@/lib/dates";
import { isTerminal, type TaskPriority, type TaskStatus } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { SubtaskProgress } from "../inline";

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

/**
 * P7-56 — A SECTION, NOT A CARD.
 *
 * It was a panel of its own with its own header and a bare `+` glyph in the
 * slot where the card below it put a labelled "Upload" button. The task detail
 * is one surface now (`task-surface.tsx`), so this is a heading and a list on
 * it, and ADDING one moved to that surface's action list at the foot of the
 * page — where every other "do a thing to this task" now lives, in one
 * treatment instead of three.
 */
export function SubtaskList({
  subtasks,
  nameOf,
  canAdd,
}: {
  subtasks: Subtask[];
  nameOf: Map<string, string>;
  /**
   * Only decides the EMPTY-STATE COPY now — whether to explain what a subtask
   * is for, or simply say there are none. The control itself is the surface's.
   */
  canAdd: boolean;
}) {
  const done = subtasks.filter((subtask) => isTerminal(subtask.status)).length;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-foreground">Subtasks</h3>
        {/* Renders nothing at zero, by its own rule — a permanent 0/0 is the
            same lie as a permanent zero on a dashboard tile. */}
        <SubtaskProgress done={done} total={subtasks.length} />
      </div>

      <div>
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
      </div>
    </section>
  );
}
