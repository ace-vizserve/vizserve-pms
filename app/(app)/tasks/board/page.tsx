import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, Link2, ListTree } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate, isOverdue } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskPriority,
  isTerminal,
} from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { TaskPriorityBadge, TaskStatusBadge, taskStatusSurface } from "@/components/status-badge";

import { SubtaskProgress, TaskRowActions } from "../inline";
import { NewTaskButton } from "../new-task-button";
import { QuickAddTask } from "../quick-add";
import { TaskStatusSelect } from "../status-select";
import { TaskToolbar } from "../toolbar";

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
 * THE TWO TERMINAL COLUMNS ARE OMITTED, and that is not an oversight. The board
 * shows live work; a column that accumulates every finished ticket since launch
 * stops being a board and becomes an archive nobody scrolls. Finished work is a
 * filter on the list view, which is the right shape for it.
 *
 * THE BOARD OWNS ITS OWN SCROLLING. The page is pinned to the viewport (100svh
 * less the 56px app header) and clips; the column row scrolls sideways inside
 * it, and each column scrolls down inside itself. That is the whole reason for
 * the height arithmetic below — before it, a wide board dragged the DOCUMENT
 * sideways and took the sidebar, the breadcrumb and the theme toggle off-screen
 * with it. The board scrolls; the app around it does not.
 */

const BOARD_COLUMNS = TASK_STATUSES.filter((status) => !isTerminal(status));

/** `Amier Bautista` → `AB`. Two letters, because three is a monogram. */
function initials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export default async function TaskBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; kind?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("vizserve_pms_tasks")
    .select(
      "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, request_id, is_personal, priority, output_link, parent_task_id, resolution",
    )
    .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)")
    .order("due_date", { ascending: true, nullsFirst: false });

  // The same three scopes the toolbar offers on both views. The board used to
  // read `mine` and silently ignore `qa`, which is what a control living on only
  // one of the two routes gets you.
  if (params.view === "mine") query = query.eq("assignee_id", context.userId);
  if (params.view === "qa") {
    query = query.eq("qa_assignee_id", context.userId).in("status", ["FOR_QA", "QA_IN_PROGRESS"]);
  }

  /*
   * The client/internal split, which the toolbar has been CARRYING here since it
   * was built and the board ignored.
   *
   * `VIEWS` in toolbar.tsx lists `kind` among the parameters that survive the
   * switch from list to board, so a filtered list produced a URL saying
   * `?kind=internal` on a board that showed everything — a control that claims a
   * filter it does not apply, which is trap 4's shape in the UI rather than in
   * SQL. Same one-column test as the list, and the same one `taskCategory` uses.
   */
  const kind = params.kind === "internal" || params.kind === "client" ? params.kind : "all";
  if (kind === "client") query = query.not("request_id", "is", null);
  if (kind === "internal") query = query.is("request_id", null);

  const [{ data: tasks }, { data: people }] = await Promise.all([
    query,
    supabase.from("vizserve_pms_users").select("id, full_name"),
  ]);

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));

  /**
   * Subtasks are counted on their parent, not dealt as their own cards (P7-09).
   *
   * A board that lists a parent and its ten children as eleven equal cards is a
   * board that has stopped saying anything about how much work there is. The
   * count is derived from the SAME rows the board already fetched, so a subtask
   * the policy hides is a subtask this does not claim exists.
   */
  const subtaskCount = new Map<string, number>();
  for (const task of tasks ?? []) {
    if (!task.parent_task_id) continue;
    subtaskCount.set(task.parent_task_id, (subtaskCount.get(task.parent_task_id) ?? 0) + 1);
  }

  const topLevel = (tasks ?? []).filter((task) => !task.parent_task_id);

  /*
   * K5 — PROGRESS, and the board cannot derive it the way the list does.
   *
   * The board excludes the two terminal statuses by design (a column that
   * accumulates every finished ticket since launch is an archive nobody
   * scrolls), so a finished subtask is not in `tasks` at all — counting done
   * children from these rows would report 0/3 on a task whose three subtasks are
   * all complete. Hence a separate query, unfiltered by status.
   */
  const parentIds = topLevel.map((task) => task.id);

  const { data: childRows } = parentIds.length
    ? await supabase
        .from("vizserve_pms_tasks")
        .select("id, parent_task_id, status")
        .in("parent_task_id", parentIds)
    : { data: [] };

  const progress = new Map<string, { done: number; total: number }>();
  for (const child of childRows ?? []) {
    if (!child.parent_task_id) continue;
    const entry = progress.get(child.parent_task_id) ?? { done: 0, total: 0 };
    entry.total += 1;
    // Both terminal statuses count as done. They are deliberately distinct, but
    // "the work is finished" is true of each and that is all a bar asks.
    if (isTerminal(child.status)) entry.done += 1;
    progress.set(child.parent_task_id, entry);
  }

  /**
   * Which seat the reader is in, per task — for the status control on the card.
   *
   * Not an authorization decision: `vizserve_pms_transition_task` re-checks all
   * of it. It only decides which moves are worth offering.
   */
  const isAdmin = roleAtLeast(context.role, "admin");
  function seat(task: { assignee_id: string | null; qa_assignee_id: string | null; department_id: string }) {
    return {
      isPic: task.assignee_id === context.userId,
      isQa: task.qa_assignee_id === context.userId,
      leadsDepartment:
        context.role === "admin" || context.managedDepartmentIds.includes(task.department_id),
      isAdmin,
    };
  }

  const byStatus = new Map<VizservePmsTaskStatus, typeof topLevel>(
    BOARD_COLUMNS.map((status) => [status, []]),
  );
  for (const task of topLevel) byStatus.get(task.status)?.push(task);

  return (
    <PageShell className="h-[calc(100svh-3.5rem)] min-h-0 gap-3 overflow-hidden">
      {/* No <h1> — the breadcrumb reads "Tasks / Board". The sentence stays: it
          is why there is no dragging, which is the first thing anyone tries. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <TaskToolbar view="board" />
        <p className="min-w-0 text-xs text-muted-foreground">
          Hover a card to move, rename or add to it. Internal work goes to any stage; client work
          follows its gates.
        </p>
      </div>

      {/*
        The sideways scroller. `min-w-0` is what stops a flex item sizing itself
        to its own content and widening the page instead of scrolling; the
        negative margin with matching padding keeps the focus ring on the first
        card from being shaved off by the scroll box's own edge.
      */}
      <div className="-mx-1 min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-1 pb-1">
        <div className="flex h-full min-w-max items-stretch gap-3">
          {BOARD_COLUMNS.map((status) => {
            const column = byStatus.get(status) ?? [];

            return (
              <section
                key={status}
                // The LABEL, never the enum — a screen reader announcing
                // "FOR_CLIENT_APPROVAL column" is reading a database value out
                // loud (§6).
                aria-label={`${TASK_STATUS_LABELS[status]} column`}
                className={cn(
                  // FLAT, per the elevation rule: a column is a place, not a
                  // control. Its fill and hairline tell it apart, and the cards
                  // inside are the only things carrying a lift.
                  "flex h-full w-72 shrink-0 flex-col rounded-lg border",
                  // The wash is the status' own tone, thinned so a white card
                  // still reads as raised on it. It comes from status-badge.tsx
                  // because that file is the only place a status is allowed to
                  // become a colour.
                  taskStatusSurface(status),
                )}
              >
                {/*
                  The status chip IS the column heading — same component, same
                  tone map as every other status in the app, so a column and a
                  card badge cannot drift into disagreeing about what colour
                  "For QA" is. It takes the stage glyph rather than the dot and
                  sets in caps, because a heading and an inline note should not
                  read as the same object.
                */}
                <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2.5">
                  <TaskStatusBadge status={status} icon className="uppercase tracking-[0.03em]" />
                  <span className="font-mono text-2xs font-semibold tabular-nums text-muted-foreground">
                    {column.length}
                  </span>
                </div>

                {/*
                  Each column scrolls on its own. `min-h-0` is the flex escape
                  hatch again: without it the list refuses to shrink below its
                  content and the overflow never engages.
                */}
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {column.length === 0 ? (
                    <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                      {status === INITIAL_TASK_STATUS
                        ? "Nothing waiting to be picked up."
                        : "Nothing here yet. Work reaches this stage from the one before it."}
                    </p>
                  ) : (
                    column.map((task) => {
                      const late = isOverdue(task.due_date);
                      const subtasks = subtaskCount.get(task.id) ?? 0;
                      const bars = progress.get(task.id);
                      const pic = task.assignee_id ? nameOf.get(task.assignee_id) : null;
                      const qa = task.qa_assignee_id ? nameOf.get(task.qa_assignee_id) : null;

                      return (
                        /*
                          A DIV, not a Link, and the title carries the href.

                          K3 put a status control, a rename and a subtask add on
                          this card, and an interactive control inside an anchor
                          is invalid HTML that swallows its own clicks: the
                          anchor wins and the popover never opens. So the
                          whole-card link is gone and the title is the
                          affordance.
                        */
                        <div
                          key={task.id}
                          className="group/task flex flex-col gap-2.5 rounded-md border bg-card grade-surface p-2.5 shadow-raised transition-all hover:border-primary/50 hover:shadow-raised-lg"
                        >
                          <div className="flex items-start gap-1.5">
                            <Link
                              href={`/tasks/${task.id}`}
                              className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium hover:underline"
                            >
                              {task.title}
                            </Link>

                            <TaskRowActions
                              taskId={task.id}
                              title={task.title}
                              priority={task.priority as TaskPriority | null}
                            >
                              {/* The glyph, not the chip: this card sits IN the
                                  column whose heading is its status. */}
                              <TaskStatusSelect
                                taskId={task.id}
                                status={task.status}
                                viewer={seat(task)}
                                task={task}
                                resolutionMissing={!task.resolution?.trim()}
                                variant="compact"
                                align="end"
                              />
                            </TaskRowActions>
                          </div>

                          <span className="flex flex-wrap items-center gap-1.5">
                            {/* Renders nothing when unranked, which is most
                                tasks: a mark carried by everything marks
                                nothing. Read-only here, because the hover
                                strip's flag is where it changes and one field
                                does not get two controls on one card. */}
                            <TaskPriorityBadge
                              priority={task.priority as TaskPriority | null}
                              className="h-5 px-1.5"
                            />

                            {/* PIC and QA, in that order. The second assignee is
                                the thing this product turns on, so a board that
                                showed only the PIC would be hiding half of who
                                is on the hook. */}
                            {pic ? <Avatar name={pic} title={`PIC ${pic}`} /> : null}
                            {qa ? <Avatar name={qa} title={`QA ${qa}`} tone="qa" /> : null}
                            {!pic && !qa ? (
                              <span className="text-2xs text-muted-foreground">Unassigned</span>
                            ) : null}

                            {task.due_date ? (
                              <span
                                className={cn(
                                  // A bordered chip rather than loose text, so
                                  // the date reads as one object beside the
                                  // avatars instead of a second line of prose.
                                  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs tabular-nums",
                                  late
                                    ? "border-destructive-border bg-destructive-subtle font-semibold text-destructive"
                                    : "border-border bg-muted text-muted-foreground",
                                )}
                              >
                                <CalendarDays className="size-3.5 shrink-0" aria-hidden />
                                {task.start_date
                                  ? `${formatDate(task.start_date)} – ${formatDate(task.due_date)}`
                                  : formatDate(task.due_date)}
                                {/* Never colour alone. */}
                                {late ? " · overdue" : null}
                              </span>
                            ) : null}

                            {task.output_link ? (
                              <Link2
                                className="size-3.5 text-foreground-faint"
                                aria-label="Has an output link"
                              />
                            ) : null}
                          </span>

                          {/* Its own line under a rule, as on the reference
                              board: a subtask count is about the task's shape,
                              not about who or when. */}
                          {/*
                            THE COUNT AND THE RATIO COME FROM DIFFERENT QUERIES,
                            deliberately. `subtasks` counts the children still
                            live on this board; `bars` counts every child,
                            including the finished ones the board excludes by
                            design. The ratio needs the second, so it is
                            preferred — the count is the fallback for a parent
                            whose children the policy did not return.
                          */}
                          {bars ? (
                            <span className="inline-flex items-center gap-1.5 border-t pt-2 text-2xs text-muted-foreground">
                              <ListTree className="size-3.5 shrink-0" aria-hidden />
                              <SubtaskProgress done={bars.done} total={bars.total} />
                            </span>
                          ) : subtasks > 0 ? (
                            <span className="inline-flex items-center gap-1.5 border-t pt-2 text-2xs text-muted-foreground">
                              <ListTree className="size-3.5 shrink-0" aria-hidden />
                              {subtasks} {subtasks === 1 ? "subtask" : "subtasks"}
                            </span>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Renders nothing at all for a member — creating work for other
                    people is a Team Leader decision, and the button settles that
                    for itself rather than the board guessing at the role. */}
                {/*
                  Only the first column, and that is a database constraint rather
                  than a layout choice: `status` is not a writable column and both
                  create functions open every task at OPEN, so an add control
                  under Ongoing would promise a stage it cannot produce. See
                  `quickAddTask`.
                */}
                {status === INITIAL_TASK_STATUS ? (
                  <>
                    <QuickAddTask shape="column" />
                    <NewTaskButton trigger="column" />
                  </>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}

/**
 * A monogram tile, not a photo. There are no avatars in this system and
 * inventing a placeholder face for a colleague is worse than two letters.
 *
 * Round, because an avatar is one of the two things `--radius-pill` still
 * exists for. `title` carries the whole name and the role, because the initials
 * alone are ambiguous the moment two people share them.
 */
function Avatar({
  name,
  title,
  tone = "pic",
}: {
  name: string;
  title: string;
  tone?: "pic" | "qa";
}) {
  return (
    <span
      title={title}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold grade-chip shadow-raised",
        tone === "qa"
          ? "border-info-border bg-info-subtle text-info"
          : "border-accent-border bg-accent text-accent-foreground",
      )}
    >
      {initials(name)}
      <span className="sr-only">{title}</span>
    </span>
  );
}
