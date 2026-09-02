"use client";

import { ChevronRight, CornerDownRight, ListTree } from "lucide-react";
import Link from "next/link";

import { createContext, useContext } from "react";

import { DataTable, type Column } from "@/components/data-table";
import {
  DataTableColumns,
  useColumnVisibility,
  type HideableColumn,
} from "@/components/data-table-columns";
import {
  TaskCategoryBadge,
  TaskStatusGlyph,
  taskCategoryEdge,
} from "@/components/status-badge";
import { roleAtLeast } from "@/lib/auth/roles";
import type {
  VizservePmsTaskStatus,
  VizservePmsUserRole,
} from "@/lib/database.types";
import { formatDate, isOverdue } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  isTerminal,
  taskCategory,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/schemas/tasks";
import { formatCellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";
import { GroupComposer } from "./add-task";
import { AssigneePicker } from "./assignees";
import type { TaskComment } from "./comment-thread";
import {
  InlineDate,
  InlineEstimate,
  InlinePriority,
  SubtaskProgress,
  TaskRowActions,
} from "./inline";
import { LatestCommentCell } from "./latest-comment-cell";
import { TaskSelectAll, TaskSelectCheckbox } from "./task-selection";
import { TaskStatusSelect } from "./status-select";

/**
 * P7-64 - the task list's columns, in a client component.
 *
 * `cell` is a function and a function cannot cross the RSC boundary, so when
 * `DataTable` moved onto `@tanstack/react-table` this had to come with it. It
 * was the largest of the eight extractions: the columns closed over eight
 * lookup Maps and two helpers that read the signed-in user.
 *
 * A `Map` is not serialisable either, so the page hands over plain objects and
 * `get` below reads them. `viewer` carries only the three fields `canDelete`
 * and `seat` actually needed - the whole auth context never crosses the wire.
 *
 * P7-65 - `urlSort` IS SET, and it works BECAUSE the sort is server-side. The
 * list is grouped into eight `bare` tables; a browser-side sort would reorder
 * each independently and mean nothing across them. Driving `?sort=` instead
 * re-runs the query, which orders the rows before they are split, so every
 * group moves together. The headers and the toolbar Select write the same
 * param and cannot disagree.
 */

/** A Map's `.get` over the plain object that replaced it. */
function get<T>(
  record: Record<string, T>,
  key: string | null | undefined,
): T | undefined {
  return key ? record[key] : undefined;
}

export type TaskRow = {
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
  /** P7-19. Whoever filed it — a member may delete a task they created. */
  created_by: string | null;
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

/**
 * A row as the table renders it — a task plus how deep it sits.
 *
 * P7-09. Only two levels exist (`parent_task_id` is one level by trigger), so
 * this is 0 or 1 and never a tree.
 */
export type ListRow = TaskRow & {
  depth: 0 | 1;
  /** Present only on a parent that actually has children — see `page.tsx`. */
  subRows?: ListRow[];
};

export type Viewer = {
  userId: string;
  role: VizservePmsUserRole;
  managedDepartmentIds: string[];
};

export type TaskLookups = {
  nameOf: Record<string, string>;
  listName: Record<string, string>;
  threads: Record<string, TaskComment[]>;
  progress: Record<string, { done: number; total: number }>;
  extraAssignees: Record<string, { id: string; full_name: string }[]>;
  closedOn: Record<string, string>;
  tracked: Record<string, number>;
  byDepartment: Record<string, { id: string; full_name: string }[]>;
};


/**
 * P7-66 — ONE COLUMNS MENU ABOVE EIGHT TABLES.
 *
 * `/tasks` renders a `bare` table per status group, so the usual arrangement —
 * each table owning its own `useColumnVisibility` — would give eight
 * independent settings: hiding "Time tracked" under Ongoing would leave it on
 * under For QA, which reads as the control not working. The state has to live
 * above the groups, so it lives here.
 *
 * ⚠️ THE MENU'S LIST IS STATIC, and deliberately. The real columns are built
 * per group from lookups the page header does not have, so rebuilding them just
 * to populate a dropdown would mean passing every lookup twice. The menu needs
 * only a key and a label, and the keys are asserted against the real columns by
 * `tests/unit/task-columns.test.ts`.
 */
const TASK_MENU_COLUMNS: HideableColumn[] = [
  { key: "progress", header: "Progress", hideable: true },
  { key: "assignee", header: "Assignee", hideable: true },
  { key: "start", header: "Start date", hideable: true },
  { key: "closed", header: "Date closed", hideable: true },
  { key: "estimate", header: "Time estimate", hideable: true },
  { key: "tracked", header: "Time tracked", hideable: true },
  { key: "comment", header: "Latest comment", hideable: true },
];

type TaskColumnState = ReturnType<typeof useColumnVisibility>;

const TaskColumnsContext = createContext<TaskColumnState | null>(null);

export function TaskColumnsProvider({ children }: { children: React.ReactNode }) {
  const state = useColumnVisibility("tasks", TASK_MENU_COLUMNS);

  return <TaskColumnsContext.Provider value={state}>{children}</TaskColumnsContext.Provider>;
}

/** The control itself, for the toolbar row above the groups. */
export function TaskColumnsMenu() {
  const state = useContext(TaskColumnsContext);
  if (!state) return null;

  return (
    <DataTableColumns
      columns={TASK_MENU_COLUMNS}
      visibility={state.visibility}
      onVisibilityChange={state.onVisibilityChange}
    />
  );
}

export function TaskGroupTable({
  group,
  status,
  viewer,
  lookups,
  assignable,
}: {
  group: ListRow[];
  status: TaskStatus;
  viewer: Viewer;
  lookups: TaskLookups;
  assignable: { id: string; full_name: string }[];
}) {
  /* Null outside the provider — the board and any future caller render a group
     table without the page chrome, and a missing menu must not be a crash. */
  const columnState = useContext(TaskColumnsContext);
  const isAdmin = roleAtLeast(viewer.role, "owner");
  /**
   * P7-19 — whether to offer the trash on this row.
   *
   * Mirrors `vizserve_pms_can_delete_task`: internal work only, and only for a
   * lead of the department, whoever created it, or the owner of a personal task.
   * The database is still the authority — this only decides whether to ask, so
   * nobody is offered a control that can only answer no.
   */
  function canDelete(task: TaskRow) {
    if (task.request_id !== null) return false;
    const leads =
      roleAtLeast(viewer.role, "owner") ||
      viewer.managedDepartmentIds.includes(task.department_id);
    return (
      leads ||
      task.created_by === viewer.userId ||
      (task.is_personal && task.assignee_id === viewer.userId)
    );
  }

  /**
   * Where the viewer sits on a task.
   *
   * `isAssignee` MIRRORS `vizserve_pms_transition_task`'s `v_is_pic`, which is
   * `assignee_id = actor OR a row in vizserve_pms_task_assignees`. It used to be
   * the column alone, and that was the same defect as the timesheet picker: a
   * second assignee could be handed work, and be fully able to edit and move it
   * as far as the database was concerned, while every control on this page was
   * hidden from them because one comparison disagreed.
   *
   * It is named `isAssignee` rather than `isPic` because on an INTERNAL task
   * there is no person in charge (P7-43) — everyone on it is an equal assignee,
   * and a field called `isPic` would be claiming a rank the data no longer has.
   * On a CLIENT task the accountable name still exists; it is simply not what
   * this flag is asking about.
   */
  function seat(task: TaskRow) {
    return {
      isAssignee:
        task.assignee_id === viewer.userId ||
        (get(lookups.extraAssignees, task.id) ?? []).some(
          (person) => person.id === viewer.userId,
        ),
      isQa: task.qa_assignee_id === viewer.userId,
      leadsDepartment:
        roleAtLeast(viewer.role, "owner") ||
        viewer.managedDepartmentIds.includes(task.department_id),
      isAdmin,
    };
  }

  /*
   * Flattened, because a parent carries its children in `subRows` now and the
   * select-all in the header has to mean "everything at this stage", not
   * "everything currently expanded".
   */
  const deletableInGroup = group
    .flatMap((task) => [task, ...(task.subRows ?? [])])
    .filter(canDelete)
    .map((task) => ({ id: task.id, title: task.title }));

  const columns: Column<ListRow>[] = [
    {
      /*
       * P7-19 — the selection column.
       *
       * A checkbox ONLY where the row can actually be deleted, on the same rule
       * as the per-row trash: `canDelete` mirrors
       * `vizserve_pms_can_delete_task`, so client-backed work and a colleague's
       * tasks have nothing to tick. The cell is not merely disabled — a
       * disabled checkbox on two thirds of the rows reads as the feature being
       * broken rather than as the row being out of scope.
       */
      key: "select",
      /* Every deletable row in this group. Built from `group` rather than the
         rendered rows so a collapsed parent's children still count — they are
         selected, merely not on screen. */
      header: <TaskSelectAll rows={deletableInGroup} />,
      className: "w-8 pr-0",
      cell: (task) =>
        canDelete(task) ? (
          <TaskSelectCheckbox taskId={task.id} title={task.title} />
        ) : null,
    },
    {
      key: "task",
      pin: "left",
      sortKey: "title",
      header: "Task",
      className: "max-w-sm whitespace-normal",
      cell: (task, _index, controls) => {
        const isChild = task.depth === 1;
        const childCount = task.subRows?.length ?? 0;

        return (
          // `group/task` is what the hover strip keys off. Named, because the
          // status group above is a group too and an unnamed one would make the
          // whole panel's hover reveal every row's actions at once.
          //
          // P7-09. A subtask is INDENTED rather than labelled. The old row said
          // "⊢ subtask" in the meta line underneath and sat flush with its
          // parent, which reads as two tasks that happen to mention each other.
          // The indent is the relationship — it is how every reference draws it,
          // and it survives a screenshot where a word in a meta row does not.
          <div className={cn("group/task", isChild && "pl-6")}>
            <span className="flex min-w-0 items-center gap-2">
              {/* The elbow. Decoration only — the row's meaning is carried by
                  the indent and by the parent link in the meta line, so this is
                  hidden from a screen reader rather than read out as a glyph.
                  `--foreground-faint` is legal here for exactly that reason:
                  it is 3.44:1 and NON-TEXT ONLY (§1.1). */}
              {isChild ? (
                <CornerDownRight
                  aria-hidden
                  className="-ml-4 size-3.5 shrink-0 text-foreground-faint"
                />
              ) : null}

              {/*
                P7-65 — COLLAPSE A PARENT.

                Only on a row that actually has children: `getCanExpand()` is
                true for an empty `subRows`, so the count is what decides, and a
                chevron opening onto nothing never renders.

                The count is IN THE LABEL, not beside it as a badge. This
                control's whole job when collapsed is to say how much is hidden,
                and a screen reader gets that from the same string the sighted
                reader gets from the number.
              */}
              {controls.canExpand && childCount > 0 ? (
                <button
                  type="button"
                  onClick={controls.toggleExpanded}
                  aria-expanded={controls.isExpanded}
                  className="-ml-1 flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm text-2xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "size-3.5 transition-transform",
                      controls.isExpanded && "rotate-90",
                    )}
                  />
                  <span className="tabular-nums">{childCount}</span>
                  <span className="sr-only">
                    {controls.isExpanded ? "Hide" : "Show"} {childCount}{" "}
                    {childCount === 1 ? "subtask" : "subtasks"} of {task.title}
                  </span>
                </button>
              ) : null}

              {/*
                The stage, always visible and BEFORE the title — the shape the
                reference uses. It is not the hover strip's status control: that
                one moves the task and disappears when there is nowhere legal to
                move to, which is exactly when a reader still needs to know where
                the task is. See the note on `TaskStatusGlyph`.
              */}
              <TaskStatusGlyph status={task.status} />

              <Link
                href={`/tasks/${task.id}`}
                className={cn(
                  "truncate hover:underline",
                  // A subtask is a smaller thing than its parent and should not
                  // compete with it for the eye.
                  isChild ? "text-sm font-normal" : "font-medium",
                )}
              >
                {task.title}
              </Link>

              {/* Renders nothing when unranked, which is most tasks. A "None"
                  chip on every row would mark everything, and a mark carried by
                  everything marks nothing. */}
              <InlinePriority taskId={task.id} value={task.priority} />

              <TaskRowActions
                taskId={task.id}
                title={task.title}
                priority={task.priority}
                assignable={assignable}
                deletable={canDelete(task)}
              >
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
              {task.list_id ? (
                <span>{get(lookups.listName, task.list_id)}</span>
              ) : null}
              {/* P7-01. THREE categories, not two. "Added by hand" used to cover
                  both work a lead assigned you and work you made for yourself —
                  and those finish differently: an assigned task goes through
                  review, a personal one you close yourself.

                  ⚠️ P7-27 — THIS WAS A PLAIN `<span>` in a row of plain spans,
                  the same muted grey as the list name beside it. So the single
                  most consequential fact about a row — whether finishing it
                  needs a client's sign-off or just your own — read as the least
                  consequential thing on it. It is a chip now, and client work is
                  the only category that gets an accent. */}
              <TaskCategoryBadge
                category={taskCategory(task)}
                className="px-1.5 py-0"
              />
              {/* A subtask says so. Without it the list shows two rows that look
                  like peers when one is part of the other. */}
              {/*
                P7-09. Only when the row is NOT already sitting under its parent.
                Once it is indented, the indent says "subtask" and a word saying
                it again is a word people stop reading. This survives for the two
                cases where the indent cannot: a subtask whose parent is filtered
                off screen, and a finished one that has left the nest for its own
                terminal group.
              */}
              {task.parent_task_id && task.depth === 0 ? (
                <Link
                  href={`/tasks/${task.parent_task_id}`}
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  <ListTree className="size-3" aria-hidden />
                  subtask
                </Link>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      /*
       * K5 — PROGRESS, from the subtasks and nowhere else.
       *
       * A task with no children renders NOTHING rather than 0%: "no subtasks"
       * and "no subtasks done" are different facts, and a permanent 0% is the
       * same lie as a permanent zero on a dashboard tile.
       */
      key: "progress",
      hideable: true,
      header: "Progress",
      className: "hidden lg:table-cell",
      cell: (task) => {
        const bars = get(lookups.progress, task.id);
        return bars ? (
          <SubtaskProgress done={bars.done} total={bars.total} />
        ) : null;
      },
    },
    {
      key: "assignee",
      hideable: true,
      header: "Assignee",
      className: "hidden md:table-cell text-muted-foreground",
      cell: (task) => (
        <AssigneePicker
          taskId={task.id}
          pic={
            task.assignee_id
              ? {
                  id: task.assignee_id,
                  full_name: get(lookups.nameOf, task.assignee_id) ?? "—",
                }
              : null
          }
          // P7-13. The join table is the whole reason this is fetched: a row
          // showing one name on a task three people are working on makes the
          // second and third invisible.
          others={(get(lookups.extraAssignees, task.id) ?? []).filter(
            (person) => person.id !== task.assignee_id,
          )}
          // Scoped to the TASK'S department, not the viewer's — the join table's
          // own function refuses anybody outside it, so offering a wider list
          // would only produce an error after the click.
          candidates={get(lookups.byDepartment, task.department_id) ?? []}
          canEdit={
            seat(task).isAssignee ||
            seat(task).isQa ||
            seat(task).leadsDepartment
          }
          // P7-43. A client task has a person in charge; an internal one does
          // not, and `request_id` is the same test `taskCategory` uses.
          showPic={task.request_id !== null}
        />
      ),
    },
    {
      key: "priority",
      sortKey: "priority",
      header: "Priority",
      className: "hidden lg:table-cell",
      // Its own column now, and editable in place. It used to sit beside the
      // title, which read well at one glance and badly at twenty — a column is
      // what makes "what is urgent" answerable by scanning down.
      cell: (task) => <InlinePriority taskId={task.id} value={task.priority} />,
    },
    {
      key: "start",
      hideable: true,
      sortKey: "start",
      header: "Start date",
      className: "hidden xl:table-cell whitespace-nowrap",
      cell: (task) => (
        <InlineDate
          taskId={task.id}
          field="start_date"
          value={task.start_date}
          label="Start"
        />
      ),
    },
    {
      key: "due",
      sortKey: "due",
      header: "Due date",
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
      /*
       * Read from `vizserve_pms_task_status_history`, never from a column.
       *
       * A `completed_at` column can disagree with the trail; the trail cannot
       * disagree with itself. It is also correctly EMPTY on a task that was
       * closed and then reopened — which internal work can be (P7-06) — because
       * what the column asks is "when was this closed", and a live task has no
       * answer to that.
       */
      key: "closed",
      hideable: true,
      header: "Date closed",
      className:
        "hidden 2xl:table-cell whitespace-nowrap text-muted-foreground",
      cell: (task) => {
        const closed = isTerminal(task.status)
          ? get(lookups.closedOn, task.id)
          : null;
        return closed ? (
          formatDate(closed.slice(0, 10))
        ) : (
          <span className="text-foreground-faint">—</span>
        );
      },
    },
    {
      key: "estimate",
      hideable: true,
      sortKey: "estimate",
      header: "Time estimate",
      className: "hidden xl:table-cell whitespace-nowrap",
      align: "end",
      cell: (task) => (
        <InlineEstimate taskId={task.id} minutes={task.estimate_minutes} />
      ),
    },
    {
      /*
       * P7-15 — TIME TRACKED CANNOT BE A PLAIN SUM, and this is the trap.
       *
       * The entries policy is owner-or-their-lead, so summing that table
       * client-side shows each viewer only their own hours and calls it the task
       * total. Two people on one task would read two different figures. The
       * rollup is `SECURITY DEFINER` for exactly that reason.
       */
      key: "tracked",
      hideable: true,
      header: "Time tracked",
      className: "hidden xl:table-cell whitespace-nowrap",
      align: "end",
      cell: (task) => {
        const minutes = get(lookups.tracked, task.id) ?? 0;
        const over =
          task.estimate_minutes !== null && minutes > task.estimate_minutes;

        if (minutes === 0)
          return <span className="text-foreground-faint">—</span>;

        return (
          <span
            className={cn(
              "tabular-nums",
              over ? "font-medium text-warning" : "text-muted-foreground",
            )}
            title={
              over
                ? `Over the estimate — ${formatCellDuration(minutes)} against ${formatCellDuration(task.estimate_minutes!)}`
                : `${formatCellDuration(minutes)} logged`
            }
          >
            {formatCellDuration(minutes)}
            {/* Never colour alone. */}
            {over ? <span className="ml-0.5 text-2xs">over</span> : null}
          </span>
        );
      },
    },
    {
      key: "comment",
      hideable: true,
      header: "Latest comment",
      // Last, and the widest thing in the row. It is the only cell that is a
      // control rather than a value, so it sits where the eye finishes.
      className: "hidden 2xl:table-cell",
      cell: (task) => (
        <LatestCommentCell
          taskId={task.id}
          taskTitle={task.title}
          comments={get(lookups.threads, task.id) ?? []}
          viewerId={viewer.userId}
        />
      ),
    },
  ];

  return (
    <DataTable
      bare
      columns={columns}
      rows={group}
      getRowKey={(task) => task.id}
      getSubRows={(task) => task.subRows}
      columnVisibility={columnState?.visibility}
      onColumnVisibilityChange={columnState?.onVisibilityChange}
      /* The server orders the query BEFORE it is split into stages, so a header
         click reorders all eight group tables together. */
      urlSort
      /* What the server orders by when the URL says nothing. Display only — it
         puts the arrow on the right column instead of leaving every header
         neutral, and it is the same pair `page.tsx` builds its query from. */
      defaultSort={{ key: "due", dir: "asc" }}
      /* P7-27. The accented left edge on client work, so a column of rows says
         which ones have somebody outside waiting without anybody reading a
         word. Empty string for the other two - an accent on every row is not an
         accent. */
      rowClassName={(task) => taskCategoryEdge(taskCategory(task))}
      empty={
        <p className="px-3.5 py-4 text-xs text-muted-foreground">
          {status === INITIAL_TASK_STATUS
            ? "Nothing waiting to be picked up."
            : "Nothing at this stage. Work reaches it from the stage before."}
        </p>
      }
      appendRow={
        status === "FOR_CLIENT_APPROVAL" ? null : (
          <GroupComposer
            status={status}
            assignable={assignable}
            columnCount={columns.length}
          />
        )
      }
    />
  );
}
