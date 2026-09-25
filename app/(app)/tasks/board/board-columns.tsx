"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Link2, ListTree } from "lucide-react";
import Link from "next/link";

import { QueryError } from "@/components/query-error";
import { BoardColumnSkeleton } from "@/components/skeletons";
import {
  TaskCategoryBadge,
  TaskPriorityBadge,
  TaskStatusBadge,
  taskCategoryEdge,
  taskStatusSurface,
} from "@/components/status-badge";
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link";
import { roleAtLeast, type Role } from "@/lib/auth/roles";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import { fetchBoardView } from "@/lib/query/fetchers/task-list";
import { qk } from "@/lib/query/keys";
import { useRefetchOnServerRender } from "@/lib/query/use-refetch-on-server-render";
import { isRichTextEmpty } from "@/lib/rich-text";
import {
  INITIAL_TASK_STATUS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  availableTransitions,
  isTaskOverdue,
  isTerminal,
  taskCategory,
  type TaskPriority,
} from "@/lib/schemas/tasks";
import type { TaskKind, TaskView } from "@/lib/task-scope";
import { cn } from "@/lib/utils";

import { BoardComposer } from "../add-task";
import { SubtaskProgress, TaskRowActions } from "../inline";
import { TaskStatusSelect } from "../status-select";
import { BoardCard, BoardColumn, BoardTaskGroup } from "./board-dnd";

/**
 * P12-08 — the board's columns and cards, read from the query cache.
 *
 * ⚠️ `BoardColumns` FROM `page.tsx`, MOVED, NOT REDESIGNED. Every derivation and
 * every card below is the server component's code over the same reads
 * (`fetchBoardView`), with `AuthContext` replaced by `viewer` — the plain values
 * `page.tsx` computed from it. A drag or a status change now refetches this one
 * entry instead of re-running the whole server board.
 *
 * `FINISHED_PER_COLUMN` lives in the fetcher now, beside the `.limit()` it caps.
 */

const FINISHED_COLUMNS = TASK_STATUSES.filter((status) => isTerminal(status));

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

export type BoardViewer = {
  userId: string;
  role: Role;
  managedDepartmentIds: string[];
  primaryDepartmentId: string | null;
  /** The Admin tick (P8-01c) — which only ever applies to the primary department. */
  isDeptAdmin: boolean;
};

export function BoardColumns({
  viewer,
  listId,
  kind,
  scope,
  today,
  serverRenderedAt,
}: {
  viewer: BoardViewer;
  listId: string | null;
  kind: TaskKind;
  scope: TaskView;
  today: string;
  serverRenderedAt: number;
}) {
  useRefetchOnServerRender(serverRenderedAt, [qk.tasks()]);

  const query = useQuery({
    queryKey: qk.taskBoardView({ list: listId ?? undefined, view: scope, kind }),
    queryFn: () =>
      fetchBoardView(browserClient(), { listId, view: scope, kind, userId: viewer.userId }, FINISHED_COLUMNS),
  });

  if (query.isError) {
    return (
      <div className="w-96 shrink-0">
        <QueryError what="the board" message={query.error.message} />
      </div>
    );
  }

  if (query.isPending) {
    return (
      <>
        <span role="status" aria-busy="true" className="sr-only">
          Loading the board…
        </span>
        <BoardColumnSkeleton />
      </>
    );
  }

  const data = query.data;
  const tasks = data.tasks;
  const people = data.people;
  const joinedTaskIdSet = new Set(data.joinedTaskIds);
  const BOARD_COLUMNS = TASK_STATUSES;

  /** `canAdminDepartment`, from the values `page.tsx` handed over. */
  function administers(departmentId: string | null): boolean {
    if (roleAtLeast(viewer.role, "owner")) return true;
    if (!departmentId) return false;
    return viewer.isDeptAdmin && viewer.primaryDepartmentId === departmentId;
  }

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
   * P7-09. The subtasks the board can actually render, bucketed by parent.
   *
   * Only the ones in `tasks` — the board excludes the two terminal statuses, so
   * a FINISHED subtask is not here at all. That is the behaviour the list has
   * too: a subtask leaves its parent's nest when it is done. The COUNT on the
   * button still comes from `subtaskCount`, which is unfiltered, so a parent
   * reads "10 subtasks" and unfolds the seven that are still outstanding.
   */
  const childrenByParent = new Map<string, typeof topLevel>();
  for (const task of tasks ?? []) {
    if (!task.parent_task_id) continue;
    const bucket = childrenByParent.get(task.parent_task_id) ?? [];
    bucket.push(task);
    childrenByParent.set(task.parent_task_id, bucket);
  }

  /*
   * K5 — PROGRESS, and the board cannot derive it the way the list does.
   *
   * The board excludes the two terminal statuses by design (a column that
   * accumulates every finished ticket since launch is an archive nobody
   * scrolls), so a finished subtask is not in `tasks` at all — counting done
   * children from these rows would report 0/3 on a task whose three subtasks are
   * all complete. Hence a separate query, unfiltered by status.
   */
  const childRows = data.childRows;

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
  /** Who the composer may assign to — P7-14's rule, same as the list's. */
  const assignableScope = new Set(
    [viewer.primaryDepartmentId, ...viewer.managedDepartmentIds].filter((id): id is string => Boolean(id)),
  );

  const assignable = (people ?? [])
    .filter(
      (person) =>
        person.is_active &&
        person.id !== viewer.userId &&
        person.primary_department_id !== null &&
        (roleAtLeast(viewer.role, "owner") || assignableScope.has(person.primary_department_id)),
    )
    .map((person) => ({ id: person.id, full_name: person.full_name }));

  const isAdmin = roleAtLeast(viewer.role, "owner");
  function seat(task: {
    id: string;
    assignee_id: string | null;
    qa_assignee_id: string | null;
    department_id: string;
  }) {
    return {
      // Mirrors vizserve_pms_transition_task's v_is_pic: the column OR the
      // join table. See lib/tasks-server.ts for why this is not the column
      // alone.
      isAssignee: task.assignee_id === viewer.userId || joinedTaskIdSet.has(task.id),
      isQa: task.qa_assignee_id === viewer.userId,
      leadsDepartment: roleAtLeast(viewer.role, "owner") || viewer.managedDepartmentIds.includes(task.department_id),
      // P11-05. Mirrors `v_in_dept` — see `lib/schemas/tasks.ts`.
      inDepartment: viewer.primaryDepartmentId === task.department_id,
      isAdmin,
    };
  }

  /**
   * P7-19 — whether to offer the trash on this row.
   *
   * Mirrors `vizserve_pms_can_delete_task` exactly: internal work only, and only
   * for a lead of the department, A DEPARTMENT ADMIN OF IT (P8-01c), whoever
   * created it, or the owner of a personal task. The database is still the
   * authority — this only decides whether to ask, so nobody is offered a control
   * that can only answer no.
   */
  function canDelete(task: {
    request_id: string | null;
    department_id: string;
    created_by: string | null;
    is_personal: boolean;
    assignee_id: string | null;
  }) {
    if (task.request_id !== null) return false;
    // The lead test inline rather than through `seat()`, which also wants a
    // `qa_assignee_id` that has nothing to do with deleting.
    const leads = roleAtLeast(viewer.role, "owner") || viewer.managedDepartmentIds.includes(task.department_id);
    return (
      leads ||
      // P8-01c. Beside the lead test, never folded into it: leading a department
      // carries approval authority and the tick carries none.
      administers(task.department_id) ||
      task.created_by === viewer.userId ||
      (task.is_personal && task.assignee_id === viewer.userId)
    );
  }

  const byStatus = new Map<VizservePmsTaskStatus, typeof topLevel>(BOARD_COLUMNS.map((status) => [status, []]));
  for (const task of topLevel) byStatus.get(task.status)?.push(task);

  /*
   * The two finished columns, each from its own bounded query.
   *
   * Subtasks are excluded in the query, not here: a board that deals a parent
   * and its ten children as eleven equal cards has stopped saying how much work
   * there is, and the COUNT has to describe the same set the cards do.
   *
   * ⚠️ THE HEADING IS THE EXACT COUNT, NOT `column.length`. That is the whole
   * point of this pair of reads — a column drawing twelve of a hundred and
   * seventy-one must say a hundred and seventy-one, or it disagrees with the
   * list view about the same stage and there is no way to tell which is lying.
   */
  const totals = new Map<VizservePmsTaskStatus, number>();

  FINISHED_COLUMNS.forEach((status, index) => {
    const result = data.finished[index];
    const rows = (result?.data ?? []) as typeof topLevel;

    byStatus.set(status, rows);
    // `count` is null only if the read failed; the rows in hand are then the
    // most honest number available.
    totals.set(status, result?.count ?? rows.length);
  });

  /**
   * What the heading says.
   *
   * Live columns are unbounded, so the rows in hand ARE the total. Finished
   * columns are capped, so they carry a count of their own.
   */
  const totalOf = (status: VizservePmsTaskStatus) => totals.get(status) ?? (byStatus.get(status) ?? []).length;

  return (
    <>
      {BOARD_COLUMNS.map((status) => {
        const column = byStatus.get(status) ?? [];

        return (
          <BoardColumn
            key={status}
            status={status}
            // The LABEL, never the enum — a screen reader announcing
            // "FOR_CLIENT_APPROVAL column" is reading a database value out
            // loud (§6).
            aria-label={`${TASK_STATUS_LABELS[status]} column`}
            className={cn(
              // FLAT, per the elevation rule: a column is a place, not a
              // control. Its fill and hairline tell it apart, and the cards
              // inside are the only things carrying a lift.
              "flex h-full w-64 shrink-0 flex-col rounded-lg border",
              // The wash is the status' own tone, thinned so a white card
              // still reads as raised on it. It comes from status-badge.tsx
              // because that file is the only place a status is allowed to
              // become a colour.
              taskStatusSurface(status),
            )}>
            {/*
              The status chip IS the column heading — same component, same
              tone map as every other status in the app, so a column and a
              card badge cannot drift into disagreeing about what colour
              "For QA" is. It takes the stage glyph rather than the dot and
              sets in caps, because a heading and an inline note should not
              read as the same object.
            */}
            <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2.5">
              <TaskStatusBadge status={status} icon solid className="uppercase tracking-[0.03em]" />
              <span className="font-mono text-2xs font-semibold tabular-nums text-muted-foreground">
                {totalOf(status)}
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
                    : isTerminal(status)
                      ? // A finished column is empty because nothing has
                        // finished, not because work has not reached it —
                        // "work reaches this stage from the one before" is
                        // true of the pipeline and false of an archive.
                        "Nothing finished this way yet."
                      : "Nothing here yet. Work reaches this stage from the one before it."}
                </p>
              ) : (
                column.map((task) => {
                  /*
                   * ⚠️ THE STATUS IS PART OF THIS QUESTION, and on THIS screen
                   * more than any other. The board is the one place that
                   * renders the finished columns (`FINISHED_COLUMNS`, and the
                   * separate query that fills them), so a bare date comparison
                   * marked every task completed after its due date `· overdue`
                   * in the Completed column, for good. `isTaskOverdue` carries
                   * the terminal check so it cannot be left out again.
                   */
                  const late = isTaskOverdue(task, today);
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
                    <BoardTaskGroup
                      key={task.id}
                      count={subtasks}
                      label={task.title}
                      parent={
                        <BoardCard
                          taskId={task.id}
                          title={task.title}
                          status={task.status}
                          // P7-20. The SAME function the status dropdown uses,
                          // which mirrors `vizserve_pms_transition_task`. The
                          // board does not get an opinion of its own about what
                          // is legal — that would be a fourth copy of the rules.
                          allowed={availableTransitions(task.status, seat(task), task).map(
                            (transition) => transition.to,
                          )}
                          className={cn(
                            "group/task flex flex-col gap-2.5 rounded-md border bg-card grade-surface p-2.5 pl-5 shadow-raised transition-all hover:border-primary/50 hover:shadow-raised-lg",
                            // P7-27. Client work carries an accented edge, so a
                            // column of cards says which ones have somebody
                            // outside waiting without anybody reading a word.
                            taskCategoryEdge(taskCategory(task)),
                          )}>
                          {/* ONE ROW, ONE JOB — the whole card width for the
                          name. P12-18 took the action strip out of here: it is
                          always visible now, and a permanently visible strip
                          cannot float over the title the way a hover-revealed
                          one could. It sits at the foot of the card instead. */}
                          <div className="flex items-start gap-1.5">
                            {/* See the note in tasks-table: a board column is the
                            same problem, one card at a time. */}
                            <HoverPrefetchLink
                              href={`/tasks/${task.id}`}
                              // Full title, wrapped — never clamped, and never cut
                              // mid-word: `wrap-break-word` rather than `wrap-anywhere`,
                              // for the reason spelled out in tasks-table. A card is a
                              // fixed width, so a word too long for one line still
                              // breaks rather than running out of the card.
                              className="min-w-0 flex-1 text-sm leading-snug font-medium wrap-break-word hover:underline">
                              {task.title}
                            </HoverPrefetchLink>

                          </div>

                          <span className="flex flex-wrap items-center gap-1.5">
                            {/* P7-27 — WHICH KIND OF WORK THIS IS, which the
                            board did not say at all. The list has said it
                            since P7-01 and the board never did, so the same
                            card meant two different things depending on
                            which view you opened it from. Client work is the
                            only category that takes an accent. */}
                            <TaskCategoryBadge category={taskCategory(task)} className="h-5 px-1.5" />
                            {/* Renders nothing when unranked, which is most
                            tasks: a mark carried by everything marks
                            nothing. Read-only here, because the hover
                            strip's flag is where it changes and one field
                            does not get two controls on one card. */}
                            <TaskPriorityBadge priority={task.priority as TaskPriority | null} className="h-5 px-1.5" />

                            {/* PIC and QA, in that order. The second assignee is
                            the thing this product turns on, so a board that
                            showed only the PIC would be hiding half of who
                            is on the hook. */}
                            {pic ? <Avatar name={pic} title={`PIC ${pic}`} /> : null}
                            {qa ? <Avatar name={qa} title={`QA ${qa}`} tone="qa" /> : null}
                            {!pic && !qa ? <span className="text-2xs text-muted-foreground">Unassigned</span> : null}

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
                                )}>
                                <CalendarDays className="size-3.5 shrink-0" aria-hidden />
                                {task.start_date
                                  ? `${formatDate(task.start_date)} – ${formatDate(task.due_date)}`
                                  : formatDate(task.due_date)}
                                {/* Never colour alone. */}
                                {late ? " · overdue" : null}
                              </span>
                            ) : null}

                            {task.output_link ? (
                              <Link2 className="size-3.5 text-foreground-faint" aria-label="Has an output link" />
                            ) : null}

                            {/*
                              P12-18 — THE CONTROLS, AFTER THE FACTS, AND IN THE
                              FLOW.

                              They used to float in the card's top corner, over
                              the title, revealed on hover — because five icon
                              buttons is ~110px held whether visible or not, and
                              on a ~196px card in the title row that left the
                              name about 100px and broke its longest word:
                              "Phase 2 Implementatio / n".

                              Always visible, floating stops being available:
                              a strip that never fades cannot sit on top of the
                              text it sits on top of. So it lands here, at the
                              end of the line that already carries the badges,
                              the avatars and the date — `ml-auto` puts it hard
                              right, and on a narrow card it simply wraps onto a
                              line of its own. The title keeps the full width it
                              was given, which was the point of floating it in
                              the first place.
                            */}
                            <TaskRowActions
                              className="ml-auto"
                              taskId={task.id}
                              title={task.title}
                              priority={task.priority as TaskPriority | null}
                              assignable={assignable}
                              deletable={canDelete(task)}>
                              {/* The glyph, not the chip: this card sits IN the
                              column whose heading is its status. */}
                              <TaskStatusSelect
                                taskId={task.id}
                                status={task.status}
                                viewer={seat(task)}
                                task={task}
                                resolutionMissing={isRichTextEmpty(task.resolution)}
                                variant="compact"
                                align="end"
                              />
                            </TaskRowActions>
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
                        </BoardCard>
                      }>
                      {(childrenByParent.get(task.id) ?? []).map((child) => {
                        const childPic = child.assignee_id ? nameOf.get(child.assignee_id) : null;
                        // Guarded here, not left to the query that fills
                        // `childrenByParent`. It excludes terminal statuses
                        // today; a correctness rule should not depend on a
                        // filter three hundred lines away staying that way.
                        const childLate = isTaskOverdue(child, today);

                        return (
                          /*
                            A SUBTASK CARD, and deliberately not a `BoardCard`.
                            No drag handle: its stage follows the work it
                            belongs to, and dragging one into another column
                            is the exact move the nesting exists to prevent.
                            It keeps its status control, because finishing one
                            is a real thing to do — and finishing it is what
                            takes it out of here.

                            ⚠️ IT USED TO BE A TITLE AND A GLYPH, which made a
                            subtask read as a label rather than as work. It is
                            a task: it has an owner, a date and a priority
                            exactly as its parent does, and the one view that
                            folds it under its parent was the only one showing
                            none of them.

                            The second line is the parent's, minus the two
                            things a child cannot say differently. No category
                            badge — a subtask carries no `request_id` of its
                            own, so it would read "Internal" directly beneath
                            a parent marked "Client". No QA avatar — this is
                            always internal work, which needs no reviewer
                            (P7-13a).
                          */
                          <div
                            key={child.id}
                            className="group/task flex flex-col gap-1.5 rounded-md border bg-card px-2 py-1.5 shadow-raised">
                            <div className="flex items-start gap-1.5">
                              <HoverPrefetchLink
                                href={`/tasks/${child.id}`}
                                // Same rule as the parent card above.
                                className="min-w-0 flex-1 text-2xs leading-snug wrap-break-word hover:underline">
                                {child.title}
                              </HoverPrefetchLink>
                            </div>

                            {/* ⚠️ ALWAYS DRAWN NOW, where it used to appear only
                                when the subtask had an owner, a date or a
                                priority to show. The action strip is on this
                                line since P12-18 — the parent card's note says
                                why it left the title row — and a strip that
                                renders only when the task happens to carry a
                                date is a rename button that comes and goes. */}
                            <span className="flex flex-wrap items-center gap-1.5">
                              <TaskPriorityBadge
                                priority={child.priority as TaskPriority | null}
                                className="h-4.5 px-1"
                              />
                              {childPic ? <Avatar name={childPic} title={`PIC ${childPic}`} /> : null}
                              {child.due_date ? (
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded-sm border px-1 py-0.5 text-2xs tabular-nums",
                                    childLate
                                      ? "border-destructive-border bg-destructive-subtle font-semibold text-destructive"
                                      : "border-border bg-muted text-muted-foreground",
                                  )}>
                                  <CalendarDays className="size-3 shrink-0" aria-hidden />
                                  {child.start_date
                                    ? `${formatDate(child.start_date)} – ${formatDate(child.due_date)}`
                                    : formatDate(child.due_date)}
                                  {/* Never colour alone. */}
                                  {childLate ? " · overdue" : null}
                                </span>
                              ) : null}

                              {/* So a subtask can be renamed, re-flagged and
                                  deleted where it lives. Without it the only
                                  way to rename one was to open it. */}
                              <TaskRowActions
                                className="ml-auto"
                                taskId={child.id}
                                title={child.title}
                                priority={child.priority as TaskPriority | null}
                                assignable={assignable}
                                deletable={canDelete(child)}>
                                <TaskStatusSelect
                                  taskId={child.id}
                                  status={child.status}
                                  viewer={seat(child)}
                                  task={child}
                                  resolutionMissing={isRichTextEmpty(child.resolution)}
                                  variant="compact"
                                  align="end"
                                />
                              </TaskRowActions>
                            </span>
                          </div>
                        );
                      })}
                    </BoardTaskGroup>
                  );
                })
              )}
            </div>

            {/*
              ⚠️ THE CAP, STATED, IN BOTH NUMBERS. A finished column draws the
              most recent `FINISHED_PER_COLUMN` and no more, and a column that
              quietly shows twelve of a hundred and seventy-one is one somebody
              counts off once and then stops trusting. The heading already
              carries the true total; this says which part of it is on screen.

              Driven off the exact count rather than off whether the fetch
              overflowed — the old test compared two columns’ shared budget and
              stayed false exactly when it mattered most.
            */}
            {totalOf(status) > column.length ? (
              <Link
                href={`/tasks?list=${column[0].list_id}&status=${status}`}
                className="block border-t px-2.5 py-2 text-center text-2xs text-muted-foreground hover:text-foreground">
                Showing the {column.length} most recent of {totalOf(status)} — see all in the list
              </Link>
            ) : null}

            {/* Renders nothing at all for a member — creating work for other
                people is a Team Leader decision, and the button settles that
                for itself rather than the board guessing at the role. */}
            {/*
              EVERY column but one, reversed from first-only on 19 Aug — this
              is the board's half of the same change. A card dragged between
              columns is still not a thing (see the note at the top of this
              file), but typing a task straight into the column it belongs in
              is, and for internal work the move it implies is always legal.

              `FOR_CLIENT_APPROVAL` is dropped: a task with no client that
              landed there could never be finished or moved back.

              ⚠️ THE TWO TERMINAL COLUMNS ARE DROPPED TOO, and that note used
              to read "they are not drawn on this board at all". They are
              now. Typing a new task straight into Completed would be
              creating work that is already over — the composer creates at
              the status of its column, and there is no honest reading of
              that one.
            */}
            {status === "FOR_CLIENT_APPROVAL" || isTerminal(status) ? null : (
              <>
                <BoardComposer status={status} assignable={assignable} />
              </>
            )}
          </BoardColumn>
        );
      })}
    </>
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
function Avatar({ name, title, tone = "pic" }: { name: string; title: string; tone?: "pic" | "qa" }) {
  return (
    <span
      title={title}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold grade-chip shadow-raised",
        tone === "qa"
          ? "border-info-border bg-info-subtle text-info"
          : "border-accent-border bg-accent text-accent-foreground",
      )}>
      {initials(name)}
      <span className="sr-only">{title}</span>
    </span>
  );
}
