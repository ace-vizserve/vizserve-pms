"use client";

import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { TaskStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { STANDARD_DAY_MINUTES, formatDate, formatDuration, formatWeekday } from "@/lib/dates";
import { isTerminal } from "@/lib/schemas/tasks";
import { dayState, formatCellDuration, parseCellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { deleteTimeEntry, logTime, updateTimeEntry } from "./actions";
import { CellDetail } from "./cell-detail";

export type PickableTask = {
  id: string;
  title: string;
  status: VizservePmsTaskStatus;
  where: string;
};

export type CellEntry = { id: string; minutes: number; note: string | null };

export type TaskRow = {
  taskId: string;
  title: string;
  /**
   * Null when the task has left this person's scope — the hours stay, the name
   * of the work does not. Same reason `title` falls back to a placeholder.
   */
  status: VizservePmsTaskStatus | null;
  /** `Department / List`, or empty when neither is set or visible. */
  where: string;
  /** Finished tasks keep their rows. An hour spent is still an hour spent. */
  finished: boolean;
  /** `YYYY-MM-DD` → what was logged against this task that day. */
  cells: Record<string, CellEntry[]>;
};

function sum(entries: CellEntry[] | undefined): number {
  return (entries ?? []).reduce((total, entry) => total + entry.minutes, 0);
}

// ---------------------------------------------------------------------------
// Rows added to a week but not yet logged against, kept in sessionStorage.
//
// They are not in the database on purpose: an empty row is not a fact, and
// storing one would mean a table and a migration to remember that somebody once
// opened a dropdown. A reload is as long as it needs to survive.
//
// Read through `useSyncExternalStore` rather than an effect — sessionStorage is
// an external store, and this is the API for one. The snapshots are cached per
// key because `getSnapshot` must return the SAME array between notifications or
// React re-renders forever.
// ---------------------------------------------------------------------------

const NO_ROWS: string[] = [];
const rowCache = new Map<string, string[]>();
const rowListeners = new Set<() => void>();

function subscribeToRows(onChange: () => void) {
  rowListeners.add(onChange);
  return () => {
    rowListeners.delete(onChange);
  };
}

function readRows(key: string): string[] {
  const cached = rowCache.get(key);
  if (cached) return cached;

  let rows: string[] = NO_ROWS;

  try {
    const stored = window.sessionStorage.getItem(key);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (Array.isArray(parsed)) rows = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    // A corrupt key, private mode, an embedded webview. The week still reads;
    // only the empty rows are lost, and they are the cheapest thing here.
  }

  rowCache.set(key, rows);
  return rows;
}

function writeRows(key: string, rows: string[]) {
  rowCache.set(key, rows);

  try {
    window.sessionStorage.setItem(key, JSON.stringify(rows));
  } catch {
    // Quota or a blocked store. The cache above still holds it for this visit.
  }

  for (const onChange of rowListeners) onChange();
}

/**
 * P6-02 / P6-03 — the week, as a grid.
 *
 * Tasks down the side, days across the top, a duration in the cell. The shape is
 * ClickUp's on purpose: this app is replacing ClickUp for the same people, and
 * the week grid is the one part of it they already know how to use. ClickUp is
 * now a FEATURE reference and nothing else — there is no sync, no import, and
 * nothing here reads from it.
 *
 * The rule underneath is unchanged and is not negotiable: every cell belongs to
 * a task, because `task_id` is NOT NULL and the INSERT policy calls
 * `vizserve_pms_may_log_time`. The grid has no row that is not a task, and the
 * "+ Add task" picker offers only tasks the policy would accept — a row you
 * cannot legitimately fill is a row that should not appear.
 */
export function WeekGrid({
  monday,
  days,
  today,
  rows,
  tasks,
  locked,
}: {
  monday: string;
  days: string[];
  today: string;
  rows: TaskRow[];
  tasks: PickableTask[];
  /**
   * P7-05 — the week has been handed in and the database will refuse every
   * write against it (`vizserve_pms_timesheet_week_locked`, called by all three
   * entry policies).
   *
   * This prop does not enforce anything; it stops the grid OFFERING what the
   * policies already refuse. Without it every keystroke in a submitted week
   * travels to the server to be rejected, and a refused UPDATE or DELETE comes
   * back as success with zero rows — so the number would simply spring back to
   * its old value with no explanation. `WeekStatusBar` says why in words; this
   * is the same fact expressed as an absence of controls.
   */
  locked: boolean;
}) {
  // The week is in the key, so navigating to another week reads that week's
  // rows rather than carrying this week's across.
  const storageKey = `vizserve-pms:timesheet-rows:${monday}`;
  const extraTaskIds = useSyncExternalStore(
    subscribeToRows,
    () => readRows(storageKey),
    // The server has no sessionStorage. A constant here is what makes the first
    // paint and the hydrated render agree instead of mismatching.
    () => NO_ROWS,
  );

  const remember = useCallback((next: string[]) => writeRows(storageKey, next), [storageKey]);

  const logged = new Set(rows.map((row) => row.taskId));
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const extraRows: TaskRow[] = extraTaskIds
    .filter((id) => !logged.has(id))
    .map((id) => byId.get(id))
    .filter((task): task is PickableTask => Boolean(task))
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      where: task.where,
      // Derived, not hardcoded false. The picker offers finished tasks now — a
      // Friday task logged on Monday — so a row added from it can be finished
      // the moment it appears.
      finished: isTerminal(task.status),
      cells: {},
    }));

  // Sorted as one list rather than logged-rows-then-added-rows. An added row put
  // at the bottom would leap into alphabetical position the moment its first
  // cell was filled — under the cursor that filled it, because that is when the
  // server starts returning it.
  const allRows = [...rows, ...extraRows].sort((a, b) => a.title.localeCompare(b.title));
  const pickable = tasks.filter((task) => !logged.has(task.id) && !extraTaskIds.includes(task.id));

  const dayTotal = (day: string) => allRows.reduce((total, row) => total + sum(row.cells[day]), 0);
  const rowTotal = (row: TaskRow) => days.reduce((total, day) => total + sum(row.cells[day]), 0);
  const weekTotal = days.reduce((total, day) => total + dayTotal(day), 0);

  /**
   * Clearing the last entry on a row would otherwise make the row vanish under
   * the cursor that just emptied it — the server stops returning it. Keeping it
   * as an empty row means a mistyped 8 can be retyped where it was typed.
   */
  const keepRow = useCallback(
    (taskId: string) => {
      if (extraTaskIds.includes(taskId)) return;
      remember([...extraTaskIds, taskId]);
    },
    [extraTaskIds, remember],
  );

  /**
   * The day bar, scaled against the standard eight-hour day.
   *
   * An earlier version scaled against the busiest day of the week, on the
   * assumption that no expected-hours figure existed. `STANDARD_DAY_MINUTES`
   * does exist (P7-06), so the bar can mean something absolute: how full the
   * day is, not merely how it compares with Tuesday.
   *
   * `dayState` colours it, and it is the same function the lead's view uses —
   * extracted precisely so a member's week and a lead's team week cannot
   * disagree about what counts as a long day. Advisory, never enforcement.
   */
  function dayBar(day: string) {
    const total = dayTotal(day);
    const state = dayState(total);

    return {
      state,
      width: `${Math.min(100, Math.round((total / STANDARD_DAY_MINUTES) * 100))}%`,
      fill: state === "over" ? "bg-destructive" : state === "overtime" ? "bg-warning" : "bg-primary grade-primary",
    };
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
      {/* The grid is 8 columns wide before it is readable, so it scrolls inside
          its own box rather than pushing the page sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-232 border-collapse text-sm">
          <caption className="sr-only">
            Time logged per task per day, for the week beginning {formatDate(monday)}
          </caption>

          <thead>
            <tr className="border-b">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                Task
              </th>

              {days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className={cn(
                    "w-[8%] border-l px-2 py-2 text-left align-bottom text-xs font-medium",
                    day === today ? "text-foreground" : "text-muted-foreground",
                  )}>
                  <span className="block whitespace-nowrap">
                    {formatWeekday(day)}
                    <span className="font-normal"> {day.slice(8)}</span>
                    {day === today ? <span className="font-normal text-primary"> · today</span> : null}
                  </span>

                  {/* The day total belongs in the header, where the week is read.
                      It stays in the footer too — that row is what a screen
                      reader lands on after the figures, and it is the one a
                      printed timesheet needs. */}
                  <span className="mt-1 block text-sm font-semibold tabular-nums text-foreground">
                    {dayTotal(day) > 0 ? formatCellDuration(dayTotal(day)) : "—"}
                  </span>

                  {/* How full the day is against the standard eight hours, and
                      `dayState` decides the colour. Hidden from assistive tech
                      because the figure above already states it — but the
                      colour is NOT the only carrier: a long day is spelled out
                      in the footer note.

                      Only once the week has something in it. Seven empty
                      grooves above seven em-dashes is the screen shouting that
                      it is empty, which it has already said. */}
                  {weekTotal > 0 ? (
                    <span className="mt-1 block h-1 rounded-full bg-track" aria-hidden>
                      <span
                        className={cn("block h-full rounded-full", dayBar(day).fill)}
                        style={{ width: dayBar(day).width }}
                      />
                    </span>
                  ) : null}
                </th>
              ))}

              <th
                scope="col"
                className="w-[10%] border-l px-2 py-2 text-right align-bottom text-xs font-medium text-muted-foreground">
                <span className="block">Total</span>
                <span className="mt-1 block text-sm font-semibold tabular-nums text-foreground">
                  {weekTotal > 0 ? formatCellDuration(weekTotal) : "—"}
                </span>
                {/* Keeps this cell the same height as the day columns, which
                    carry a bar. Dropped with them on an empty week. */}
                {weekTotal > 0 ? <span className="mt-1 block h-1" aria-hidden /> : null}
              </th>
            </tr>
          </thead>

          <tbody>
            {allRows.map((row) => (
              <tr key={row.taskId} className="border-b last:border-b-0">
                {/*
                  `max-w-0` is what makes a table cell truncate at all; the
                  percentage is what stops it eating the week.

                  This carried `w-full`, which claims every pixel the fixed day
                  columns leave. That was survivable while the page was capped at
                  1440px — once PageShell went full width it took ~830px on a
                  1600px screen and crushed the seven days into 77px each.
                  Percentages hold the proportions at any width; the table's
                  `min-w` is still the floor before it scrolls.
                */}
                <th scope="row" className="sticky left-0 z-10 w-[34%] max-w-0 bg-card px-3 py-2 text-left font-normal">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" title={row.title}>
                        {row.title}
                      </span>

                      {/* The second line: what state the work is in and where it
                          lives. Both come from the task, so both go quiet when
                          the task has left this person's scope — the hours are
                          still theirs, the context is not. */}
                      {row.status || row.where ? (
                        <span className="mt-0.5 flex min-w-0 items-center gap-2">
                          {row.status ? <TaskStatusBadge status={row.status} className="h-5 px-1.5" /> : null}
                          {row.where ? (
                            <span className="truncate text-xs text-muted-foreground" title={row.where}>
                              {row.where}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>

                    {row.finished ? <span className="shrink-0 text-2xs text-muted-foreground">finished</span> : null}

                    {/* Only a row with nothing on it can be taken off the week.
                        Removing a row with hours on it would have to mean
                        deleting them, and a close button is not consent.

                        Gone once the week is locked: an empty row in a handed-in
                        week cannot be filled, so taking it off is the only thing
                        left to do with it — and it is a change to a week that is
                        no longer this person's to change. */}
                    {rowTotal(row) === 0 && !locked ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0"
                        onClick={() => remember(extraTaskIds.filter((id) => id !== row.taskId))}>
                        <X />
                        <span className="sr-only">Take {row.title} off this week</span>
                      </Button>
                    ) : null}
                  </span>
                </th>

                {days.map((day) => (
                  <TimeCell
                    key={day}
                    taskId={row.taskId}
                    taskTitle={row.title}
                    day={day}
                    entries={row.cells[day] ?? []}
                    future={day > today}
                    locked={locked}
                    onEmptied={() => keepRow(row.taskId)}
                  />
                ))}

                <td className="border-l px-2 py-1.5 text-right text-sm font-medium tabular-nums">
                  {rowTotal(row) > 0 ? formatCellDuration(rowTotal(row)) : "—"}
                </td>
              </tr>
            ))}

            {/* Dropped entirely once the week is locked, rather than disabled.
                Adding a row to a handed-in week can only ever produce an empty
                row nothing may be typed into — the picker would be offering a
                dead end, and the row it leaves behind is a control that looks
                like it failed. */}
            {locked ? null : (
              <tr className="border-b last:border-b-0">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left">
                  <AddTaskRow
                    tasks={pickable}
                    onAdd={(taskId) => remember([...extraTaskIds, taskId])}
                    hasRows={allRows.length > 0}
                  />
                </th>
                <td colSpan={days.length + 1} />
              </tr>
            )}
          </tbody>

          <tfoot>
            {/* Solid `bg-muted`, not `bg-muted/40`. The first cell is sticky, and
                a translucent background lets the cells scrolling underneath show
                straight through it. */}
            <tr className="border-t bg-muted">
              <th
                scope="row"
                className="sticky left-0 z-10 bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                Total
              </th>

              {days.map((day) => (
                <td key={day} className="border-l px-1 py-2 text-center text-sm font-semibold tabular-nums">
                  {dayTotal(day) > 0 ? formatCellDuration(dayTotal(day)) : "—"}
                </td>
              ))}

              <td className="border-l px-2 py-2 text-right text-sm font-semibold tabular-nums">
                {weekTotal > 0 ? formatCellDuration(weekTotal) : "—"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        {weekTotal > 0 ? (
          <>
            <span className="font-medium text-foreground">{formatDuration(weekTotal)}</span> this week ·{" "}
          </>
        ) : null}
        {/* The typing hint is instructions for a thing that can no longer be
            done. A locked week keeps the total and drops the lesson — the bar
            above already says why, and repeating it here would say it twice in
            two voices. */}
        {locked ? (
          "Handed in. The hours are read-only until your lead decides."
        ) : (
          <>
            Type <span className="font-medium text-foreground">1h 30m</span>,{" "}
            <span className="font-medium text-foreground">90m</span> or{" "}
            <span className="font-medium text-foreground">1.5</span> into a cell. A bare number is
            hours.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * One task, one day.
 *
 * Typing is the whole interaction — no dialogue, no save button. The cell resets
 * to whatever the server returns rather than keeping what was typed, so the
 * reading it was given (`1.5` → `1h 30m`) is visible immediately in the place it
 * was entered.
 *
 * A cell holding more than one entry is read-only and opens `CellDetail`. Two
 * entries exist because their notes differ, and there is no honest way to apply
 * one new number to both.
 */
function TimeCell({
  taskId,
  taskTitle,
  day,
  entries,
  future,
  locked,
  onEmptied,
}: {
  taskId: string;
  taskTitle: string;
  day: string;
  entries: CellEntry[];
  future: boolean;
  locked: boolean;
  onEmptied: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const total = sum(entries);
  const split = entries.length > 1;

  // Three reasons a cell cannot be typed into, and they are not the same reason:
  // the day has not happened, the cell holds entries the grid cannot choose
  // between, or the whole week has been handed in. Only the third is new; all
  // three end in the same place, which is why they are one flag here and three
  // different explanations everywhere else.
  const readOnly = future || split || locked;

  // `draft === null` means "show the server". Everything written here goes back
  // to null on commit, so a value the server rejected or reinterpreted never
  // lingers on screen as though it had been accepted.
  const display = draft ?? (total > 0 ? formatCellDuration(total) : "");

  function commit() {
    if (draft === null) return;

    const typed = draft;
    setDraft(null);

    const minutes = parseCellDuration(typed);

    if (minutes === null) {
      toast.error(`"${typed}" is not a length of time. Try 1h 30m, 90m or 1.5.`);
      return;
    }

    if (minutes === total) return;
    if (entries.length === 0 && minutes === 0) return;

    startTransition(async () => {
      const result =
        entries.length === 0
          ? await logTime({ task_id: taskId, work_date: day, minutes, note: null })
          : minutes === 0
            ? await deleteTimeEntry(entries[0].id)
            : await updateTimeEntry({
                id: entries[0].id,
                task_id: taskId,
                work_date: day,
                minutes,
                // The note survives a change of length. They answer different
                // questions, and retyping the note to correct the hours is the
                // reason people stop writing notes.
                note: entries[0].note,
              });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      if (minutes === 0) onEmptied();
      router.refresh();
    });
  }

  return (
    <td className={cn("group/cell relative border-l p-0", future && "bg-muted/30", pending && "opacity-60")}>
      <input
        type="text"
        inputMode="decimal"
        value={display}
        readOnly={readOnly}
        disabled={pending}
        aria-label={`${taskTitle} — ${formatWeekday(day)} ${formatDate(day)}`}
        // A raw input rather than the Input component: seven of those per row
        // is seven borders and a lot of height, and a grid cell should read as
        // part of the table until it is being typed into.
        className={cn(
          "h-9 w-full bg-transparent text-center text-sm tabular-nums",
          "focus:ring-2 focus:ring-ring focus:outline-none",
          readOnly ? "cursor-default" : "cursor-text",
          total === 0 && "text-muted-foreground",
        )}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => !readOnly && event.currentTarget.select()}
        onClick={() => split && setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(null);
        }}
        onBlur={commit}
      />

      {/* A day that has not happened cannot be logged — the INSERT policy says
          so in Manila time, and offering the control anyway just produces an
          error people read as a bug.

          A LOCKED week still opens, because the notes are the reason to open it
          and reading a handed-in week is the whole point of handing it in. It
          opens read-only — `CellDetail` is a full editor otherwise, and leaving
          it editable here would make the lock a matter of which control you
          happened to reach for. */}
      {future ? null : (
        <CellDetail
          open={open}
          onOpenChange={setOpen}
          locked={locked}
          taskId={taskId}
          taskTitle={taskTitle}
          day={day}
          entries={entries}
        />
      )}
    </td>
  );
}

/** The "+ Add task" row. The picker is the scope boundary, so it is never free text. */
function AddTaskRow({
  tasks,
  onAdd,
  hasRows,
}: {
  tasks: PickableTask[];
  onAdd: (taskId: string) => void;
  hasRows: boolean;
}) {
  const [open, setOpen] = useState(false);

  const items: Record<string, string> = Object.fromEntries(tasks.map((task) => [task.id, task.title]));

  // Two ways to be empty, two different next steps — a dead end that only says
  // "nothing here" is the thing the design system calls out.
  if (tasks.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {hasRows ? (
          <>
            Every task you can log against is already on this week. Take one off to re-add it, or{" "}
            <Link href="/tasks" className="font-medium text-primary hover:underline">
              open your tasks
            </Link>
            .
          </>
        ) : (
          <>
            You are not the PIC or the QA reviewer on any task, so there is nothing to log against yet. Ask your team
            leader to assign you, or{" "}
            <Link href="/tasks" className="font-medium text-primary hover:underline">
              see what is on your queue
            </Link>
            .
          </>
        )}
      </span>
    );
  }

  if (!open) {
    return (
      <Button size="sm" className="-ml-2" onClick={() => setOpen(true)}>
        <Plus />
        Add task
      </Button>
    );
  }

  return (
    <Select
      items={items}
      value={null}
      onValueChange={(value) => {
        if (!value) return;
        onAdd(value);
        setOpen(false);
      }}>
      <SelectTrigger className="h-9 w-full" autoFocus>
        <SelectValue placeholder="Which task?" />
      </SelectTrigger>
      <SelectContent>
        {/* Two lines per option, as in the picker the team already uses: the
            task, then its state and where it lives. Several open tasks can share
            a name across departments, and the title alone is not enough to pick
            between them. `items` above still maps id → title, because the
            TRIGGER shows one line. */}
        {tasks.map((task) => (
          <SelectItem key={task.id} value={task.id}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-medium">{task.title}</span>
              <span className="flex min-w-0 items-center gap-2">
                <TaskStatusBadge status={task.status} className="h-5 px-1.5" />
                {task.where ? <span className="truncate text-xs text-muted-foreground">{task.where}</span> : null}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
