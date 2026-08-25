import { CalendarDays, Link2, ListTree } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { loadPendingRequests } from "@/lib/pending-requests-server";
import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import {
  TaskCategoryBadge,
  TaskPriorityBadge,
  TaskStatusBadge,
  taskCategoryEdge,
  taskStatusSurface,
} from "@/components/status-badge";
import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate, isOverdue } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskPriority,
  availableTransitions,
  isTerminal,
  taskCategory,
} from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { fetchJoinedTaskIds, fetchJoinedTaskIdSet, mineFilter } from "@/lib/tasks-server";

import { BoardComposer } from "../add-task";
import { SubtaskProgress, TaskRowActions } from "../inline";
import { TaskStatusSelect } from "../status-select";
import { PendingRequestColumn } from "../pending-requests";
import { TaskToolbar } from "../toolbar";
import { BoardCard, BoardColumn, BoardDnd, BoardTaskGroup } from "./board-dnd";

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

/**
 * How many finished cards a terminal column shows before it stops.
 *
 * Small on purpose. These columns answer "what just closed", not "everything we
 * have ever done" — that question belongs to the list view, which has filters,
 * sorting and pagination built for it.
 */
const FINISHED_PER_COLUMN = 12;

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

export default async function TaskBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; kind?: string; list?: string; done?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  /**
   * P7-13 / P7-43 — the tasks this person is on without being named in
   * `assignee_id`. Widens "Mine" and feeds `seat()`. `cache()`d, so the two
   * helpers below are one query between them.
   */
  const joinedTaskIds = await fetchJoinedTaskIds(context.userId);
  const joinedTaskIdSet = await fetchJoinedTaskIdSet(context.userId);

  let query = supabase
    .from("vizserve_pms_tasks")
    .select(
      "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, created_by, request_id, is_personal, priority, output_link, parent_task_id, list_id, resolution",
    )
    .order("due_date", { ascending: true, nullsFirst: false });

  /*
   * ⚠️ EVERY STAGE IS A COLUMN, COMPLETED AND COMPLETED (NO RESPONSE INCLUDED.
   *
   * This file used to say the opposite, and the old reasoning is worth keeping
   * because half of it is still true:
   *
   *   "The board shows live work; a column that accumulates every finished
   *    ticket since launch stops being a board and becomes an archive nobody
   *    scrolls."
   *
   * The archive worry is real. Omitting the columns was the wrong answer to it.
   * A board whose columns are not the status enum is a board that disagrees
   * with the list, the status dropdown and the state machine about what the
   * stages are — and it was reported three times in three different words
   * before the actual complaint surfaced: the stages were missing.
   *
   * The archive problem is solved where it actually lives — in HOW MUCH is
   * fetched, not in whether the column exists. Live work is unbounded because
   * it is naturally bounded; finished work is capped at
   * `FINISHED_PER_COLUMN` and says so when there is more.
   *
   * ⚠️ A cap without a stated limit is a lie about the number. `+ 1` is asked
   * for so truncation is DETECTABLE without a second count query — the same
   * trick the DTR list uses, and for the same reason: a board that quietly
   * shows twenty of forty is a board somebody counts off.
   */
  const BOARD_COLUMNS = TASK_STATUSES;

  query = query.not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)");

  /*
   * ONE LIST, and without this the sidebar and the board were two structures
   * that never met.
   *
   * The project tree links every list to `?list=<id>`, the list view honoured
   * it, and the board did not read the parameter at all — so a list had exactly
   * one shape available to it, and switching to the board silently widened the
   * page to every task in the department while the URL still claimed a list.
   * That is the same "a control that claims a filter it does not apply" trap the
   * `kind` note below records, one parameter along.
   *
   * Now that the Tasks nav group is gone (lib/navigation.ts) and a list is
   * reached only through the tree, this is what makes Board a VIEW of that list
   * rather than a different destination.
   */
  const listId = params.list ?? null;
  if (listId) query = query.eq("list_id", listId);

  // The same three scopes the toolbar offers on both views. The board used to
  // read `mine` and silently ignore `qa`, which is what a control living on only
  // one of the two routes gets you.
  // P7-43 — same rule as the list view, through the same helper.
  if (params.view === "mine") query = query.or(mineFilter(context.userId, joinedTaskIds));
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

  /*
   * P7-26 — the requests that have not been decided yet, as the first column.
   *
   * Awaited on its own rather than joined into the Promise.all below: it is an
   * addition to the board, not part of it, and a failure here must not be able
   * to stop the board rendering. The loader returns [] on its own errors.
   *
   * The board has no status or priority filter to honour, so the only task-only
   * filter it can carry is none — `hasTaskOnlyFilter` stays false.
   */
  const pendingRequests = await loadPendingRequests({
    listId,
    kind,
    scope: params.view === "mine" || params.view === "qa" ? params.view : "all",
  });

  const [{ data: tasks }, { data: people }, { data: openList }, { data: finishedTasks }] =
    await Promise.all([
    query,
    supabase.from("vizserve_pms_users").select("id, full_name, primary_department_id, is_active"),
    // Just the name, and only when there is one to fetch. The board has no list
    // picker to populate — this is purely so the page can say which list you are
    // looking at, now that a board can be a view of one.
    listId
      ? supabase.from("vizserve_pms_lists").select("name").eq("id", listId).maybeSingle()
      : Promise.resolve({ data: null }),
    /*
     * Finished work, as its own bounded read.
     *
     * A SEPARATE QUERY rather than relaxing the filter above, because the two
     * want opposite things. Live work is ordered by due date and unbounded —
     * there is only ever so much of it. Finished work is ordered by RECENCY and
     * capped: what closed this week is worth a glance, what closed in March is
     * what the list view and its filters are for.
     *
     * Carries the same list/scope/kind filters as the board, so the columns
     * agree with the ones beside them.
     */
    (() => {
      let done = supabase
        .from("vizserve_pms_tasks")
        .select(
          "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, created_by, request_id, is_personal, priority, output_link, parent_task_id, list_id, resolution",
        )
        .in("status", ["COMPLETED", "COMPLETED_NO_RESPONSE"])
        .order("updated_at", { ascending: false })
        .limit(FINISHED_PER_COLUMN * 2 + 1);

      if (listId) done = done.eq("list_id", listId);
      if (params.view === "mine") done = done.or(mineFilter(context.userId, joinedTaskIds));
      if (params.view === "qa") done = done.eq("qa_assignee_id", context.userId);
      if (kind === "client") done = done.not("request_id", "is", null);
      if (kind === "internal") done = done.is("request_id", null);
      return done;
    })(),
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
  const parentIds = topLevel.map((task) => task.id);

  const { data: childRows } = parentIds.length
    ? await supabase.from("vizserve_pms_tasks").select("id, parent_task_id, status").in("parent_task_id", parentIds)
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
  /** Who the composer may assign to — P7-14's rule, same as the list's. */
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

  const isAdmin = roleAtLeast(context.role, "admin");
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
      isAssignee:
        task.assignee_id === context.userId || joinedTaskIdSet.has(task.id),
      isQa: task.qa_assignee_id === context.userId,
      leadsDepartment: context.role === "admin" || context.managedDepartmentIds.includes(task.department_id),
      isAdmin,
    };
  }


  /**
   * P7-19 — whether to offer the trash on this row.
   *
   * Mirrors `vizserve_pms_can_delete_task` exactly: internal work only, and only
   * for a lead of the department, whoever created it, or the owner of a personal
   * task. The database is still the authority — this only decides whether to ask.
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
    const leads =
      context.role === "admin" || context.managedDepartmentIds.includes(task.department_id);
    return (
      leads ||
      task.created_by === context.userId ||
      (task.is_personal && task.assignee_id === context.userId)
    );
  }

  const byStatus = new Map<VizservePmsTaskStatus, typeof topLevel>(BOARD_COLUMNS.map((status) => [status, []]));
  for (const task of topLevel) byStatus.get(task.status)?.push(task);

  /*
   * The two finished columns, from their own bounded query.
   *
   * Subtasks are dropped here for the same reason they are above: a board that
   * deals a parent and its ten children as eleven equal cards has stopped
   * saying how much work there is.
   *
   * `truncated` is per column, and it is the reason the query asks for more
   * than it renders: a column that silently shows twelve of forty is a column
   * somebody counts off and then stops trusting.
   */
  const truncated = new Map<VizservePmsTaskStatus, boolean>();
  for (const status of FINISHED_COLUMNS) {
    const all = ((finishedTasks ?? []) as typeof topLevel).filter(
      (task) => task.status === status && !task.parent_task_id,
    );
    truncated.set(status, all.length > FINISHED_PER_COLUMN);
    byStatus.set(status, all.slice(0, FINISHED_PER_COLUMN));
  }

  return (
    <PageShell className="h-[calc(100svh-3.5rem)] min-h-0 gap-3 overflow-hidden">
      {/* No <h1> — the breadcrumb is the page label. Now that a board can be a
          view of ONE list, the crumb has to name it, or two lists' boards are
          the same page with different cards on it and nothing on screen says
          which one you opened. `BreadcrumbLabel` clears itself on unmount, so
          leaving the list takes the name with it.

          The sentence below stays because it is the rule for DRAGGING: internal
          work goes anywhere, client work follows its gates, and a column that
          cannot take the card dims rather than accepting it and springing back
          (P7-20). */}
      {openList ? <BreadcrumbLabel value={openList.name} /> : null}

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <TaskToolbar view="board" />
        <p className="min-w-0 text-xs text-muted-foreground">
          Drag a card by its handle, or use the status control. Internal work goes to any stage; client work follows its gates.
        </p>

      </div>

      {/*
        The sideways scroller. `min-w-0` is what stops a flex item sizing itself
        to its own content and widening the page instead of scrolling; the
        negative margin with matching padding keeps the focus ring on the first
        card from being shaved off by the scroll box's own edge.
      */}
      <BoardDnd>
      {/*
        ⚠️ THE FADE IS AN AFFORDANCE, NOT DECORATION.

        Six live columns at w-64 need roughly 1600px and a laptop with the
        sidebar open has about 1360px, so at least one stage is off the right
        edge on most screens. Reported as "the board doesn't show all stages" —
        which is what a horizontal scroller with no visible edge looks like.

        `relative` on the wrapper and a gradient pinned to the right, above the
        scroller and `pointer-events-none` so it cannot swallow a drag. It is
        drawn unconditionally rather than only when scrollable: knowing whether
        there is overflow needs a client component measuring on resize, and a
        16px wash over the last column's own padding costs nothing when there is
        nothing to scroll to.
      */}
      <div className="relative min-h-0 min-w-0 flex-1">
      <div className="-mx-1 h-full min-h-0 min-w-0 overflow-x-auto overflow-y-hidden px-1 pb-1">
        <div className="flex h-full min-w-max items-stretch gap-3">
          {/* Before every stage, and deliberately not one of them: nothing in
              it has a status yet. It is not a `BoardColumn` either — that is a
              drop target, and approving needs a PIC, a QA reviewer and a list
              that a drag cannot express. Renders nothing for a member. */}
          <PendingRequestColumn requests={pendingRequests} />

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
                          <div className="flex items-start gap-1.5">
                            <Link
                              href={`/tasks/${task.id}`}
                              className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium hover:underline">
                              {task.title}
                            </Link>

                            <TaskRowActions
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
                                resolutionMissing={!task.resolution?.trim()}
                                variant="compact"
                                align="end"
                              />
                            </TaskRowActions>
                          </div>

                          <span className="flex flex-wrap items-center gap-1.5">
                            {/* P7-27 — WHICH KIND OF WORK THIS IS, which the
                                board did not say at all. The list has said it
                                since P7-01 and the board never did, so the same
                                card meant two different things depending on
                                which view you opened it from. Client work is the
                                only category that takes an accent. */}
                            <TaskCategoryBadge
                              category={taskCategory(task)}
                              className="h-5 px-1.5"
                            />
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
                            const childLate = isOverdue(child.due_date);

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
                                  <Link
                                    href={`/tasks/${child.id}`}
                                    className="line-clamp-2 min-w-0 flex-1 text-2xs leading-snug hover:underline">
                                    {child.title}
                                  </Link>

                                  {/* The same hover strip the parent carries, so
                                      a subtask can be renamed, re-flagged and
                                      deleted where it lives. Without it the only
                                      way to rename one was to open it. */}
                                  <TaskRowActions
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
                                      resolutionMissing={!child.resolution?.trim()}
                                      variant="compact"
                                      align="end"
                                    />
                                  </TaskRowActions>
                                </div>

                                {/* Drawn only when there is something to say. A
                                    subtask with no owner, date or priority keeps
                                    the single line it had. */}
                                {childPic || child.due_date || child.priority ? (
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
                                  </span>
                                ) : null}
                              </div>
                            );
                          })}
                        </BoardTaskGroup>
                      );
                    })
                  )}
                </div>

                {/*
                  ⚠️ THE CAP, STATED. A finished column shows the most recent
                  `FINISHED_PER_COLUMN` and no more — and a column that quietly
                  shows twelve of forty is a column somebody counts off once and
                  then stops trusting. The list view is where the rest lives,
                  because it has the filters and the sorting for it.
                */}
                {truncated.get(status) ? (
                  <Link
                    href={`/tasks?status=${status}`}
                    className="block border-t px-2.5 py-2 text-center text-2xs text-muted-foreground hover:text-foreground"
                  >
                    Showing the {FINISHED_PER_COLUMN} most recent — see all in the list
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
        </div>
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent"
      />
      </div>
      </BoardDnd>
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
