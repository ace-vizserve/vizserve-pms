"use client";

import {
  CalendarDays,
  Check,
  ChevronRight,
  Clock,
  Filter,
  FolderInput,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { OvertimeApprovalLinks } from "@/components/overtime-approval-links";
import { TaskStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate, formatDuration, formatWeekday } from "@/lib/dates";
import { isTerminal } from "@/lib/schemas/tasks";
import {
  type CellCommit,
  type DayState,
  type EntryDraft,
  type OvertimeApproval,
  cellCommit,
  clockAt,
  daySummary,
  draftToEntry,
  formatCellDuration,
  overtimeGranted,
  parseCellDuration,
  spanFrom,
  withDuration,
  withEnd,
  withStart,
} from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { searchLoggableTasks } from "./actions";

import { deleteTimeEntry, logTime, updateTimeEntry } from "./actions";
import { CellDetail } from "./cell-detail";
import { ClockSelect, clockLabel, normaliseClock } from "./clock-select";
import { DurationSuggestion } from "./duration-suggestion";

export type PickableTask = {
  id: string;
  title: string;
  status: VizservePmsTaskStatus;
  /** "Department / List", already resolved. Empty when neither is readable. */
  where: string;
};

export type CellEntry = {
  id: string;
  minutes: number;
  note: string | null;
  /** P7-21. `HH:MM` wall-clock on the entry's own day, or null. Both or neither. */
  started_at: string | null;
  ended_at: string | null;
};

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
  taskLists,
  locked,
  overtimeApprovals = {},
}: {
  monday: string;
  days: string[];
  today: string;
  rows: TaskRow[];
  /** The picker's first page — the 20 most recently created, from the server. */
  tasks: PickableTask[];
  /** The List filter's options: lists this person actually has work in. */
  taskLists: { id: string; name: string }[];
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
  /**
   * P7-04 / slice D — `YYYY-MM-DD` → the approved OVERTIME requests for that day.
   *
   * Their minutes raise the eight-hour threshold rather than removing it: a day
   * with two hours approved is fine at ten and still over at eleven. A day with
   * no entry here keeps the plain 480.
   *
   * ⚠️ THE REQUESTS, NOT JUST THEIR TOTAL, and the ids are why. A day marked
   * "OT" is this grid asserting that somebody signed off on those hours, and
   * until the ids arrived there was no way to go and read that signature — see
   * `OvertimeApproval`. The total is derived at the point of use through
   * `overtimeGranted`, so the threshold and the links cannot be built from
   * different rows.
   *
   * Advisory only. The enforced rule is the 1440-minute day trigger, and
   * approved overtime is capped at 960 so `480 + approved` can never exceed it.
   */
  overtimeApprovals?: Record<string, OvertimeApproval[]>;
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
  /**
   * How much overtime was signed off for this day.
   *
   * Derived from the same list the links below read, so the threshold and the
   * approvals a reader can open are always the same set of requests.
   */
  const grantedOn = (day: string) => overtimeGranted(overtimeApprovals[day]);

  function dayBar(day: string) {
    const summary = daySummary(dayTotal(day), grantedOn(day));
    const { state } = summary;

    return {
      state,
      // Scaled against the day's OWN capacity, so an approved eleven-hour day
      // reads as a full bar rather than a 137% overflow that has to be clamped.
      width: `${Math.min(100, summary.percentOfCapacity)}%`,
      fill: state === "over" ? "bg-destructive" : state === "overtime" ? "bg-warning" : "bg-primary grade-primary",
    };
  }

  /**
   * The marker under a day total, in WORDS.
   *
   * State is never conveyed by colour alone here — every status pill in this
   * app carries its label and a bar is no different. A `title` attribute would
   * not do either: it is not an affordance on touch.
   *
   * Returns null for a normal or empty day, so the ordinary week carries no
   * decoration at all.
   */
  function dayNote(day: string): { state: DayState; mark: string; spoken: string } | null {
    const granted = grantedOn(day);
    const { state, capacityMinutes, trackedMinutes, overMinutes } = daySummary(dayTotal(day), granted);

    if (state === "overtime") {
      return {
        state,
        mark: "OT",
        spoken: `${formatDuration(trackedMinutes)} logged, within the ${formatDuration(
          capacityMinutes,
        )} approved for this day.`,
      };
    }

    if (state === "over") {
      return {
        state,
        // THE AMOUNT, ON SCREEN. This used to read "over" and keep the figure
        // in the screen-reader sentence, so a member could see that a day was
        // long and not by how much — which is the number that decides whether
        // to correct the hours or file the overtime. `formatDuration` is terse
        // enough ("1h", "45m") to sit under a total in a narrow column.
        //
        // The word stays alongside it. "+1h" in red would leave the meaning to
        // the colour, and that is not how anything else in this app states a
        // state.
        mark: `over +${formatDuration(overMinutes)}`,
        spoken: `${formatDuration(trackedMinutes)} logged, ${formatDuration(
          overMinutes,
        )} more than the ${formatDuration(capacityMinutes)} ${granted > 0 ? "approved for this day" : "standard day"}.`,
      };
    }

    return null;
  }

  /*
   * WHICH TASKS ARE SHOWING THEIR WORKING.
   *
   * A row's cell holds one number and the entries behind it hold three facts
   * each — how long, when, and what it was. Summing them is right for reading
   * the week and useless for checking it, which is what somebody is doing when
   * they open a row: reconciling a disputed day, or reconstructing their own.
   *
   * Local state, deliberately not remembered between visits like the extra-row
   * list is. Expanding is a question being asked now ("what made up Tuesday's
   * eight hours?"), not a preference about how the week is laid out.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  function toggleExpanded(taskId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(taskId)) next.add(taskId);
      return next;
    });
  }

  // Counted, not inferred from the week total: there is no 40-hour constant in
  // this repo and no working-days-per-week concept, so "the week is over" would
  // mean deciding whether Saturday counts — which nobody has answered. A week
  // is over when a day in it is.
  const daysOver = days.filter((day) => dayNote(day)?.state === "over").length;

  // How much the week ran over in total, summed across the days that did. There
  // is no weekly standard in this repo to be over BY, so this is the only
  // honest weekly figure — the sum of the daily overages, not a week total
  // measured against a 40 nobody has defined.
  const weekOverMinutes = days.reduce((total, day) => total + daySummary(dayTotal(day), grantedOn(day)).overMinutes, 0);

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
            {allRows.map((row) => {
              /*
               * Every entry on the row, in the order the week runs.
               *
               * `days` is already Sunday-first, so the flat list needs no
               * sorting between days — only within one, where two entries on
               * the same day are ordered by when they started. An entry with no
               * times sorts first: it is the older shape, from before a typed
               * duration carried a clock, and it has nothing to sort by.
               */
              const rowEntries = days.flatMap((day) =>
                [...(row.cells[day] ?? [])]
                  .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""))
                  .map((entry) => ({ day, entry })),
              );

              const open = expanded.has(row.taskId);

              return (
                <Fragment key={row.taskId}>
                  <tr className="border-b">
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
                    <th
                      scope="row"
                      className="sticky left-0 z-10 w-[34%] max-w-0 bg-card px-3 py-2 text-left font-normal">
                      <span className="flex items-center gap-1.5">
                        {/* The way into the row's working. A row with nothing on it
                        keeps the space rather than the control, so every title
                        in the column still starts at the same pixel. */}
                        {rowEntries.length > 0 ? (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="-ml-1 shrink-0"
                            aria-expanded={open}
                            onClick={() => toggleExpanded(row.taskId)}>
                            <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
                            <span className="sr-only">
                              {open ? "Hide" : "Show"} the {rowEntries.length} time{" "}
                              {rowEntries.length === 1 ? "entry" : "entries"} on {row.title}
                            </span>
                          </Button>
                        ) : (
                          <span className="-ml-1 w-7 shrink-0" aria-hidden />
                        )}

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

                        {row.finished ? (
                          <span className="shrink-0 text-2xs text-muted-foreground">finished</span>
                        ) : null}

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

                  {/*
                THE WORKING, ONE ROW PER ENTRY.

                Read-only on purpose. Everything here is editable one click away
                in the cell above — and an entry that can be changed from two
                places at once is two places that have to agree about what
                happens when somebody clears it.

                ⚠️ SOLID `bg-muted`, not `bg-muted/40`. The first column is
                sticky, and a translucent fill lets the cells scrolling
                underneath show straight through it — the same trap the footer
                row carries a note about.
              */}
                  {open ? (
                    <tr className="border-b bg-muted">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 bg-muted py-1 pr-3 pl-11 text-left text-2xs font-medium text-muted-foreground">
                        {rowEntries.length} time {rowEntries.length === 1 ? "entry" : "entries"}
                      </th>
                      <td className="bg-muted" colSpan={days.length + 1} />
                    </tr>
                  ) : null}

                  {open
                    ? rowEntries.map(({ day, entry }) => (
                        <EntryRow
                          key={entry.id}
                          entry={entry}
                          taskId={row.taskId}
                          taskTitle={row.title}
                          day={day}
                          days={days}
                          today={today}
                          tasks={pickable}
                          locked={locked}
                        />
                      ))
                    : null}
                </Fragment>
              );
            })}

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
                    taskLists={taskLists}
                    // Search results come from the server and know nothing about
                    // this week, so the exclusion has to travel with them.
                    excludeIds={[...logged, ...extraTaskIds]}
                    today={today}
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

              {days.map((day) => {
                const note = dayNote(day);

                return (
                  <td key={day} className="border-l px-1 py-2 text-center text-sm font-semibold tabular-nums">
                    <span
                      className={
                        note?.state === "over"
                          ? "text-destructive"
                          : note?.state === "overtime"
                            ? "text-warning"
                            : undefined
                      }>
                      {dayTotal(day) > 0 ? formatCellDuration(dayTotal(day)) : "—"}
                    </span>

                    {/* The word, under the number. Colour alone would leave a
                        long day and an approved long day looking identical to
                        anyone who cannot separate amber from red — and those
                        two mean opposite things. */}
                    {note ? (
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 block text-2xs leading-none font-medium",
                          note.state === "over" ? "text-destructive" : "text-warning",
                        )}>
                        {note.mark}
                      </span>
                    ) : null}

                    {/* The same fact as a sentence, for a screen reader. "OT"
                        on its own is not readable out loud. */}
                    {note ? <span className="sr-only">{note.spoken}</span> : null}

                    {/* P8-08 — the approvals behind the marker, each openable.
                        Only on a day the grid has actually flagged: an approved
                        day nobody worked past eight hours needs no explanation,
                        and decorating every ordinary day with a link is how the
                        marker stops meaning anything. */}
                    {note ? <OvertimeApprovalLinks approvals={overtimeApprovals[day]} /> : null}
                  </td>
                );
              })}

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

        {/* Days AND the amount. There is still no weekly standard in this
            codebase to be over BY — `weekOverMinutes` is the sum of the daily
            overages, which is a different and answerable question, and it is
            the figure somebody needs before deciding whether to file an
            overtime request or correct the hours. */}
        {daysOver > 0 ? (
          <>
            <span className="font-medium text-destructive">
              {daysOver === 1 ? "1 day over" : `${daysOver} days over`}
            </span>{" "}
            the standard day by <span className="font-medium text-destructive">{formatDuration(weekOverMinutes)}</span>{" "}
            in total ·{" "}
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
            <span className="font-medium text-foreground">1.5</span> into a cell. A bare number is hours.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * ONE ENTRY, EDITED WHERE IT IS READ.
 *
 * The expanded row started out as a read-only breakdown, on the argument that
 * everything in it was one click away in the cell above. That was true and
 * beside the point: the cell above holds the day's TOTAL, so an eight-hour
 * Tuesday made of three entries cannot be corrected there at all — the cell
 * goes read-only on a split precisely because it cannot choose between them.
 * This row is the only place those three are separately addressable, which
 * makes it the only place they can be separately fixed.
 *
 * The same two-way link as the popover, because it is literally the same
 * functions: `withDuration` / `withStart` / `withEnd` in `lib/schemas`. Type a
 * length and the end moves; move the end and the length is recomputed.
 *
 * SAVED ON CHANGE FOR THE CLOCKS, ON BLUR FOR THE LENGTH. A select has no
 * half-picked state to protect — choosing 4:00 pm is the whole gesture — while
 * a text field does, and `1h 3` on the way to `1h 30m` must not be written.
 */
function EntryRow({
  entry,
  taskId,
  taskTitle,
  day,
  days,
  today,
  tasks,
  locked,
}: {
  entry: CellEntry;
  taskId: string;
  taskTitle: string;
  day: string;
  days: string[];
  today: string;
  /** What "move to task" may offer — the same list the picker uses, which is
      the same list RLS will accept a write against. */
  tasks: PickableTask[];
  locked: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [draft, setDraft] = useState<EntryDraft>(() => ({
    duration: formatCellDuration(entry.minutes),
    note: entry.note ?? "",
    start: normaliseClock(entry.started_at),
    end: normaliseClock(entry.ended_at),
  }));

  /** What the row currently says, as the columns hold it. */
  function saved(): EntryDraft {
    return {
      duration: formatCellDuration(entry.minutes),
      note: entry.note ?? "",
      start: normaliseClock(entry.started_at),
      end: normaliseClock(entry.ended_at),
    };
  }

  function commit(next: EntryDraft) {
    setDraft(next);
    if (locked) return;

    const built = draftToEntry(next);

    if (!built.ok) {
      // Half a pair is somebody mid-edit, not a mistake to interrupt over —
      // the clocks are being changed one at a time and the row waits. A length
      // that does not parse is worth naming, and putting the row back is what
      // stops the grid showing a number the database never accepted.
      if (next.start && next.end) toast.error(built.error);
      else if (parseCellDuration(next.duration) === null) {
        toast.error(built.error);
        setDraft(saved());
      }
      return;
    }

    const current = saved();
    if (
      built.entry.minutes === entry.minutes &&
      built.entry.started_at === (current.start || null) &&
      built.entry.ended_at === (current.end || null) &&
      built.entry.note === entry.note
    ) {
      return;
    }

    startTransition(async () => {
      const result = await updateTimeEntry({
        id: entry.id,
        task_id: taskId,
        work_date: day,
        ...built.entry,
      });

      if (!result.ok) {
        toast.error(result.error);
        setDraft(saved());
        return;
      }

      router.refresh();
    });
  }

  return (
    <tr className={cn("border-b bg-muted", pending && "opacity-60")}>
      <th scope="row" className="sticky left-0 z-10 max-w-0 bg-muted py-1 pr-3 pl-11 text-left font-normal">
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <Clock className="size-3.5 shrink-0 text-foreground-faint" aria-hidden />

          {locked ? (
            /* The record, still readable. An entry logged before a typed
               duration carried a clock has only its length, and a blank here
               would read as a rendering fault rather than a fact. */
            <span className="shrink-0 tabular-nums text-foreground-muted">
              {draft.start && draft.end ? `${clockLabel(draft.start)} – ${clockLabel(draft.end)}` : "No times recorded"}
            </span>
          ) : (
            <>
              <ClockSelect
                label={`Start time on ${formatWeekday(day)}`}
                value={draft.start}
                disabled={pending}
                onChange={(next) => commit(withStart(draft, next))}
              />
              <span className="text-foreground-faint" aria-hidden>
                –
              </span>
              <ClockSelect
                label={`End time on ${formatWeekday(day)}`}
                value={draft.end}
                after={draft.start}
                disabled={pending}
                onChange={(next) => commit(withEnd(draft, next))}
              />
            </>
          )}

          {entry.note ? (
            <span className="truncate text-muted-foreground" title={entry.note}>
              {entry.note}
            </span>
          ) : null}
        </span>
      </th>

      {days.map((column) => (
        <td key={column} className="border-l bg-muted px-1 py-1 text-center">
          {column !== day ? null : locked ? (
            <span className="text-sm tabular-nums text-foreground-muted">{draft.duration}</span>
          ) : (
            /* A raw input, like the cell above it and for the same reason: a
               bordered control per entry per day turns a breakdown into a
               form. It is one of seven columns and only one of them is ever
               filled in. */
            <input
              type="text"
              inputMode="decimal"
              value={draft.duration}
              disabled={pending}
              aria-label={`${taskTitle} — ${formatWeekday(day)} ${formatDate(day)}, ${
                draft.start ? clockLabel(draft.start) : "this entry"
              }`}
              className={cn(
                "h-7 w-full bg-transparent text-center text-sm tabular-nums text-foreground-muted",
                "focus:ring-2 focus:ring-ring focus:outline-none",
              )}
              onChange={(event) => setDraft(withDuration(draft, event.target.value))}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setDraft(saved());
              }}
              onBlur={() => commit(draft)}
            />
          )}
        </td>
      ))}

      <td className="border-l bg-muted px-1 py-1 text-right">
        {locked ? null : (
          <EntryMenu
            entry={entry}
            taskId={taskId}
            taskTitle={taskTitle}
            day={day}
            days={days}
            today={today}
            tasks={tasks}
            pending={pending}
            onChanged={() => router.refresh()}
          />
        )}
      </td>
    </tr>
  );
}

/**
 * THE ACTIONS AN ENTRY HAS, AND ONLY THOSE.
 *
 * ClickUp's row menu offers five. Three of them exist here:
 *
 *   Change date    `work_date` is a column and the week is right there, so the
 *                  days are listed rather than hidden behind a date picker —
 *                  moving an hour off Tuesday almost always means moving it to
 *                  a day already on screen. A FUTURE day is not offered: the
 *                  INSERT policy refuses one in Manila time, and a menu item
 *                  that only ever produces an error is a bug with a label.
 *
 *   Move to task   `task_id` is a column, and the list is the same `pickable`
 *                  the row picker uses — which is the list RLS will accept, so
 *                  the menu cannot offer a write the database will refuse.
 *
 *   Delete entry   already had an action.
 *
 * The two that do not:
 *
 *   Open entry     the cell above IS that, and a second route to the same
 *                  editor is a second thing to keep in step.
 *   Remove from    not expressible. `task_id` is `not null` with no default —
 *   task           "there is deliberately no way to write a row that is not
 *                  attached to real work", per the migration. An entry with no
 *                  task is a deleted entry, which is the item above it.
 */
function EntryMenu({
  entry,
  taskId,
  taskTitle,
  day,
  days,
  today,
  tasks,
  pending,
  onChanged,
}: {
  entry: CellEntry;
  taskId: string;
  taskTitle: string;
  day: string;
  days: string[];
  today: string;
  tasks: PickableTask[];
  pending: boolean;
  onChanged: () => void;
}) {
  const [working, startTransition] = useTransition();

  function move(next: { work_date?: string; task_id?: string }) {
    startTransition(async () => {
      const result = await updateTimeEntry({
        id: entry.id,
        task_id: next.task_id ?? taskId,
        work_date: next.work_date ?? day,
        minutes: entry.minutes,
        // Everything the move is not about travels with it. A note left behind
        // by a change of date is a note nobody rewrites.
        note: entry.note,
        started_at: entry.started_at,
        ended_at: entry.ended_at,
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      onChanged();
    });
  }

  const elsewhere = tasks.filter((task) => task.id !== taskId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-xs" disabled={pending || working} className="shrink-0">
            <MoreHorizontal />
            <span className="sr-only">
              Actions for the {formatCellDuration(entry.minutes)} logged on {taskTitle}, {formatWeekday(day)}{" "}
              {formatDate(day)}
            </span>
          </Button>
        }
      />

      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <CalendarDays />
            Change date
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {days
              .filter((option) => option <= today)
              .map((option) => (
                <DropdownMenuItem key={option} disabled={option === day} onClick={() => move({ work_date: option })}>
                  {formatWeekday(option)} {formatDate(option)}
                  {option === day ? <span className="ml-auto text-2xs text-muted-foreground">now</span> : null}
                </DropdownMenuItem>
              ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={elsewhere.length === 0}>
            <FolderInput />
            Move to task
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 w-64 overflow-y-auto">
            {elsewhere.map((task) => (
              <DropdownMenuItem key={task.id} onClick={() => move({ task_id: task.id })}>
                <span className="min-w-0 flex-1 truncate" title={task.title}>
                  {task.title}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="destructive"
          onClick={() =>
            startTransition(async () => {
              const result = await deleteTimeEntry(entry.id);
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              onChanged();
            })
          }>
          <Trash2 />
          Delete entry
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const inputRef = useRef<HTMLInputElement>(null);

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

  /*
   * SLICE H — the draft, in a ref as well as in state.
   *
   * `flush` below runs from an unmount cleanup and from a `visibilitychange`
   * listener. Neither can read `draft` from the closure it was created in without
   * being recreated on every keystroke, and a listener that re-registers on every
   * keystroke is a listener that misses the keystroke it was registered for. The
   * ref is the copy those two read.
   */
  const draftRef = useRef<string | null>(null);

  /*
   * Everything `flush` needs about the cell, kept current the same way.
   *
   * Read at flush time rather than captured, because a cell can be re-rendered
   * with different entries (somebody else logged against the same task and day)
   * between the keystroke and the tab closing.
   */
  const cellRef = useRef({ taskId, day, entries, total });

  /*
   * Both refs are written in an EFFECT, not during render.
   *
   * Assigning during render is a lint error and a real hazard under concurrent
   * rendering: a render that is thrown away would still have moved the ref, so a
   * flush could write a draft from a render React discarded. The effect runs after
   * every commit, which is before any listener or cleanup can fire.
   */
  useEffect(() => {
    draftRef.current = draft;
    cellRef.current = { taskId, day, entries, total };
  }, [draft, taskId, day, entries, total]);

  /** H — "saved", on the cell, for a moment. See `showSaved`. */
  const [saved, setSaved] = useState(false);

  /**
   * The write itself, with no React state in it.
   *
   * Shared by the ordinary blur path and by `flush`. Keeping it state-free is
   * what makes it safe to call from a cleanup: a `setState` after unmount is a
   * no-op, but a `startTransition` wrapping an await that then calls
   * `router.refresh()` on a torn-down tree is not something to rely on.
   */
  const persist = useCallback(async (plan: CellCommit) => {
    const cell = cellRef.current;

    if (plan.kind === "insert") {
      return logTime({
        task_id: cell.taskId,
        work_date: cell.day,
        minutes: plan.minutes,
        note: null,
        // The hour just typed is the hour just logged: `1h` entered at 3:16
        // marks the entry 3:16 to 4:16, whatever day the cell belongs to. See
        // `clockAt` — the pair says when this went in, not what the day looked
        // like, and both clocks stay editable in the popover.
        ...spanFrom(clockAt(), plan.minutes),
      });
    }

    if (plan.kind === "delete") {
      return deleteTimeEntry(cell.entries[0]!.id);
    }

    if (plan.kind === "update") {
      return updateTimeEntry({
        id: cell.entries[0]!.id,
        task_id: cell.taskId,
        work_date: cell.day,
        minutes: plan.minutes,
        // The note survives a change of length. They answer different questions,
        // and retyping the note to correct the hours is the reason people stop
        // writing notes.
        note: cell.entries[0]!.note,
        // The START survives, and the end moves to match the new length —
        // correcting 1h to 2h says the work ran an hour longer, not that it
        // began an hour earlier. An entry that never had times gets them now,
        // so every duration in the grid ends up carrying a pair either way.
        ...spanFrom(cell.entries[0]!.started_at ?? clockAt(), plan.minutes),
      });
    }

    return { ok: true as const, data: undefined };
  }, []);

  function commit() {
    if (draft === null) return;

    const typed = draft;
    const plan = cellCommit(typed, { total, entryCount: entries.length });

    if (plan.kind === "invalid") {
      // The draft STAYS on an invalid entry, unlike every other branch. Clearing
      // it would replace what somebody typed with the old number and leave the
      // toast explaining a value no longer on screen.
      toast.error(`"${plan.typed}" is not a length of time. Try 1h 30m, 90m or 1.5.`);
      return;
    }

    // Back to showing the server from here on, so a value it rejected or
    // reinterpreted never lingers as though it had been accepted.
    setDraft(null);

    if (plan.kind === "noop") return;

    startTransition(async () => {
      const result = await persist(plan);

      if (!result.ok) {
        // The failure stays LOUD. A refused write is worth interrupting for; a
        // successful one is not, which is the whole shape of this slice.
        toast.error(result.error);
        return;
      }

      // Not a toast. A toast per cell makes filling in a week feel like an alarm
      // going off, and it appears in the corner rather than on the number that
      // changed.
      setSaved(true);

      if (plan.kind === "delete") onEmptied();
      router.refresh();
    });
  }

  /*
   * H — DO NOT LOSE AN UNCOMMITTED DRAFT.
   *
   * Blur is the trigger, so a cell typed into and then abandoned never committed:
   * tab closed, browser navigated, row scrolled off on a phone. This is the part
   * of the slice that was genuinely missing rather than merely quiet.
   *
   * `visibilitychange` covers the phone and the closed tab; the cleanup covers
   * navigation and the row unmounting. Both go through `persist`, which touches
   * no state — by the time the cleanup runs there is nothing left to render into.
   *
   * NOT `beforeunload`. It is unreliable on mobile Safari, it cannot await, and it
   * is the hook that produces "leave site?" dialogues — which would be a prompt
   * on the way out of a page whose whole point is that saving is invisible.
   */
  useEffect(() => {
    function flush() {
      const typed = draftRef.current;
      if (typed === null) return;

      const cell = cellRef.current;
      const plan = cellCommit(typed, {
        total: cell.total,
        entryCount: cell.entries.length,
      });

      // Invalid and noop both drop the draft on the floor, and that is right: a
      // cell abandoned mid-word must not become a write nobody reviewed.
      if (plan.kind === "invalid" || plan.kind === "noop") return;

      draftRef.current = null;
      void persist(plan);
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") flush();
    }

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [persist]);

  /** The tick fades after a beat. Long enough to notice, short enough to ignore. */
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [saved]);

  return (
    <td className={cn("group/cell relative border-l p-0", future && "bg-muted/30", pending && "opacity-60")}>
      {/*
        H — the cell says it saved, on itself.

        Two states, and they are the same mark: `pending` while the write is in
        flight (the cell is already dimmed by the opacity above) and a tick for a
        moment afterwards. Absolutely positioned so it cannot shift the number it
        is about — a grid whose columns jump on save is worse than one that says
        nothing.

        `aria-live="polite"` rather than a visual-only tick. Somebody using a
        screen reader gets the same confirmation, once, without the focus moving.
      */}
      <span aria-live="polite" className="pointer-events-none absolute top-0.5 right-0.5 flex items-center">
        {pending ? (
          <span className="text-2xs text-muted-foreground">···</span>
        ) : saved ? (
          <>
            <Check className="size-3 text-success" aria-hidden />
            <span className="sr-only">Saved</span>
          </>
        ) : null}
      </span>

      <input
        ref={inputRef}
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

      {/* What the cell heard, while it is still being typed into. `draft` and
          not `display`: a cell showing what the server already holds has
          nothing to suggest, and a suggestion sitting under an untouched cell
          would appear on all seven of them at once. */}
      {readOnly ? null : (
        <DurationSuggestion anchor={inputRef} value={draft ?? ""} onAccept={() => inputRef.current?.blur()} />
      )}

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

/** The created-date presets, in the order they read. */
const PRESETS = [
  { value: "all", label: "Any time" },
  { value: "this", label: "This week" },
  { value: "last", label: "Last week" },
  { value: "custom", label: "Custom" },
] as const;

type Preset = (typeof PRESETS)[number]["value"];

/**
 * The sentinel for "no list chosen".
 *
 * A `Select` cannot hold `null` — Base UI needs a string — so the absence has
 * to be spelled. Prefixed and bracketed so it can never collide with a uuid.
 */
const ALL_LISTS = "__all__";

/**
 * The "+ Add task" row.
 *
 * SERVER-BACKED SINCE THE PICKER STOPPED LOADING EVERYTHING. The page hands it
 * the twenty most recently created tasks this person is on; typing a name, or
 * setting a date range or a list, asks the DATABASE instead. So a task from
 * three months ago is one search away rather than absent, and opening the
 * popover does not cost every task somebody has ever been on.
 *
 * ⚠️ IT IS STILL THE SCOPE BOUNDARY AND STILL NEVER FREE TEXT. Whatever comes
 * back — initial list or search result — went through `loadLoggableTasks`,
 * which is `vizserve_pms_is_on_task`: the accountable name, the QA reviewer, or
 * a row in `vizserve_pms_task_assignees`, all equal. No status filter and no
 * date filter unless somebody asks for one, because `vizserve_pms_may_log_time`
 * has no opinion on either and the picker must not be stricter than the insert.
 */
function AddTaskRow({
  tasks,
  taskLists,
  excludeIds,
  today,
  onAdd,
  hasRows,
}: {
  /** The initial twenty. Shown whenever nothing is filtered. */
  tasks: PickableTask[];
  taskLists: { id: string; name: string }[];
  /** Already on this week — filtered out of both the initial list and results. */
  excludeIds: string[];
  /** `YYYY-MM-DD` in app time, from the server. The week presets are built off it. */
  today: string;
  onAdd: (taskId: string) => void;
  hasRows: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState<Preset>("all");
  const [listId, setListId] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [results, setResults] = useState<PickableTask[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);

  /** How many FILTERS are on. The search box is not one — it is visible already. */
  const activeFilters = (preset !== "all" ? 1 : 0) + (listId ? 1 : 0);
  const filtered = Boolean(query.trim() || listId || from || to);

  /*
   * DEBOUNCED, AND THE LAST REPLY WINS.
   *
   * `token` is compared on the way back so a slow answer to "de" cannot
   * overwrite a fast answer to "design" — the classic out-of-order search bug,
   * and the one that makes a picker feel haunted.
   */
  const token = useRef(0);

  useEffect(() => {
    // Nothing asked for: the twenty the server already sent are the answer, so
    // there is nothing to fetch and nothing to reset — `filtered` gates every
    // read of `results`, `searching` and `failed` below, which is why this can
    // leave them alone rather than clearing them from inside an effect.
    if (!open || !filtered) return;

    const mine = ++token.current;

    // `setSearching` lives INSIDE the timer, not beside it: a synchronous
    // setState in an effect body is a second render on every keystroke, for a
    // spinner nobody sees during a 250ms debounce. The first search's gap is
    // covered by `results === null` in the render instead.
    const timer = window.setTimeout(() => {
      setSearching(true);

      void searchLoggableTasks({
        query: query.trim() || null,
        listId,
        from: from || null,
        to: to || null,
      }).then((result) => {
        if (token.current !== mine) return;

        setSearching(false);

        if (!result.ok) {
          // Said, not swallowed. An empty popover after a search reads as "you
          // are on nothing", which is a confident false statement about
          // somebody's own work — the exact failure this picker already had.
          setFailed(true);
          setResults([]);
          return;
        }

        setFailed(false);
        // The status is a `string` on the wire — the column is an enum, but
        // `loadLoggableTasks` is shared with a caller that does not care, so the
        // narrowing happens at the one place that renders a badge from it.
        setResults(
          result.data.tasks.map((task) => ({
            ...task,
            status: task.status as VizservePmsTaskStatus,
          })),
        );
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [open, filtered, query, listId, from, to]);

  /**
   * Monday of the week `offsetWeeks` from today, and the Sunday after it.
   *
   * Built off the server's `today` and read at MIDDAY UTC, the same trick
   * `lib/dates.ts` uses for bare dates: midnight lands on the previous day in
   * any negative offset, and the viewer's own clock is not the business's.
   */
  function weekRange(offsetWeeks: number): { from: string; to: string } {
    const base = new Date(`${today}T12:00:00Z`);
    // Sunday is 0; shift so Monday starts the week, matching the timesheet.
    const shift = (base.getUTCDay() + 6) % 7;
    const monday = new Date(base);
    monday.setUTCDate(base.getUTCDate() - shift + offsetWeeks * 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
  }

  function applyPreset(next: Preset) {
    setPreset(next);

    if (next === "this" || next === "last") {
      const range = weekRange(next === "this" ? 0 : -1);
      setFrom(range.from);
      setTo(range.to);
      return;
    }

    // "all" clears, and so does "custom" — arriving on Custom carrying last
    // week's dates would silently keep a filter the segment no longer names.
    setFrom("");
    setTo("");
  }

  function clearFilters() {
    setPreset("all");
    setListId(null);
    setFrom("");
    setTo("");
  }

  const listItems: Record<string, string> = {
    [ALL_LISTS]: "All lists",
    ...Object.fromEntries(taskLists.map((list) => [list.id, list.name])),
  };

  /*
   * Filtered: whatever the server last returned, and nothing until it does —
   * showing the unfiltered twenty while a search is in flight would answer a
   * question nobody asked. Unfiltered: the twenty, always.
   */
  const shown = (filtered ? (results ?? []) : tasks).filter((task) => !excludeIds.includes(task.id));

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
            {/* ⚠️ "PIC OR QA REVIEWER" WAS WRONG AND WAS THE BUG PEOPLE
                REPORTED. P7-13 made every assignee equal — a join-table row
                confers the same right to log time as being the accountable
                name. This sentence still described the pre-P7-13 rule, so
                somebody who WAS an assignee and found an empty picker was told,
                confidently and falsely, that they had to be made PIC. */}
            You are not on any task yet, so there is nothing to log against. Being an assignee is enough — you do not
            have to be the person it is filed under. Ask your team leader to add you, or{" "}
            <Link href="/tasks" className="font-medium text-primary hover:underline">
              see what is on your queue
            </Link>
            .
          </>
        )}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button size="sm" className="-ml-2">
            <Plus />
            Add task
          </Button>
        }
      />

      <PopoverContent align="start" className="w-112 gap-0 p-0">
        {/*
          `shouldFilter={false}` — cmdk's own fuzzy match is switched OFF, and
          that is the whole change on this screen. Filtering in the browser can
          only ever narrow the twenty rows already here; the search asks the
          database now, so a task outside those twenty is findable at all.
        */}
        <Command shouldFilter={false}>
          {/* Search and filters share a row: the search is the common case and
              stays in the open, the filters are occasional and fold away behind
              their own icon rather than putting four controls above a list of
              five. */}
          <div className="flex items-start gap-1 pr-1">
            <div className="min-w-0 flex-1">
              <CommandInput placeholder="Search tasks by name" value={query} onValueChange={setQuery} />
            </div>

            <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant={activeFilters > 0 ? "outline" : "ghost"}
                    size="icon-sm"
                    // `relative` because the count badge below is absolutely
                    // positioned and the button base is not a positioning
                    // context — without it the badge anchors to the popover.
                    // `size-8` and `mt-1` line it up with CommandInput, which
                    // is `h-8` inside a `p-1` wrapper.
                    className="relative mt-1 size-8 shrink-0"
                    // The count is in the NAME, not only in the badge — an
                    // icon-only control has to say what it is and what state
                    // it is in without being looked at.
                    aria-label={activeFilters > 0 ? `Filters, ${activeFilters} applied` : "Filters"}
                  />
                }>
                <Filter />
                {/* State is never colour alone: the number is the carrier and
                    the tint is the reinforcement. */}
                {activeFilters > 0 ? (
                  <span
                    aria-hidden
                    className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-sm border border-accent-border bg-accent grade-chip text-2xs font-semibold tabular-nums text-accent-foreground">
                    {activeFilters}
                  </span>
                ) : null}
              </PopoverTrigger>

              {/* -----------------------------------------------------------
                  ⚠️ NO BARE `<input>` OR `<select>` — both were here, and both
                  are prohibited (§2). The primitives carry the token wiring,
                  the focus ring, the dark-mode variants and the Base UI
                  keyboard behaviour a native control has none of.

                  A SEGMENTED CONTROL RATHER THAN TOGGLE BUTTONS, because
                  exactly one of these is always in force. That is what a radio
                  group means and what a screen reader announces — and it makes
                  "Any time" a visible off switch, where the buttons needed an
                  undocumented second press to clear.
                  ----------------------------------------------------------- */}
              <PopoverContent align="start" className="w-96 gap-3 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">Filters</span>
                  {activeFilters > 0 ? (
                    <Button variant="ghost" size="xs" onClick={clearFilters}>
                      <X />
                      Clear
                    </Button>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label className="text-2xs tracking-wide text-muted-foreground uppercase">Created</Label>
                  <Segmented
                    aria-label="Filter by when the task was created"
                    value={preset}
                    onValueChange={(value) => applyPreset(value as Preset)}
                    className="w-full">
                    {PRESETS.map((option) => (
                      <SegmentedItem key={option.value} value={option.value} className="flex-1 px-2 py-1">
                        {option.label}
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </div>

                {/* Only under Custom. Shown always, they are two empty controls
                    contradicting the segment above them. */}
                {preset === "custom" ? (
                  <div className="grid grid-cols-2 gap-2">
                    {/*
                      ⚠️ `[&::-webkit-calendar-picker-indicator]:hidden` IS THE
                      POINT OF THESE TWO CLASSES, not decoration. A bare
                      `type="date"` renders the browser's own calendar button
                      inside our field — a control we do not style, do not theme
                      and cannot make dark-mode aware, sitting next to ones we
                      do. Hiding it leaves the field as a field; the date is
                      still typed, and the picker still opens on click in every
                      browser that has one.

                      `DatePicker` is the app's proper date control and is NOT
                      usable here: it opens its own Popover and this is already
                      two deep. `app/(app)/tasks/inline.tsx:InlineDate` hit the
                      same wall and answers it with a bare `Calendar`, which
                      inside a task picker is a month of chrome for one filter.
                    */}
                    <div className="space-y-1.5">
                      <Label htmlFor="task-created-from" className="px-1 text-2xs text-muted-foreground">
                        From
                      </Label>
                      <Input
                        type="date"
                        id="task-created-from"
                        value={from}
                        // Bounded by each other, so a range that runs backwards
                        // cannot be entered at all. `dueReminder`'s sibling
                        // problem: an inverted range matches nothing, and
                        // "nothing" is what an empty result looks like.
                        max={to || undefined}
                        onChange={(event) => setFrom(event.target.value)}
                        className="h-9 w-full appearance-none bg-background text-xs [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="task-created-to" className="px-1 text-2xs text-muted-foreground">
                        To
                      </Label>
                      <Input
                        type="date"
                        id="task-created-to"
                        value={to}
                        min={from || undefined}
                        onChange={(event) => setTo(event.target.value)}
                        className="h-9 w-full appearance-none bg-background text-xs [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                      />
                    </div>
                  </div>
                ) : null}

                {/* Only the lists this person has work in — see
                    `loadLoggableTaskLists`. A filter whose options mostly
                    return nothing reads as broken, not as an empty list.

                    `items` AND the children: Base UI renders the RAW VALUE in
                    `SelectValue` without the map, which would put the literal
                    sentinel on screen. Same fix `tasks/filters.tsx` carries. */}
                {taskLists.length > 0 ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="task-list" className="text-2xs tracking-wide text-muted-foreground uppercase">
                      List
                    </Label>
                    <Select
                      items={listItems}
                      value={listId ?? ALL_LISTS}
                      onValueChange={(value) => setListId(value === ALL_LISTS ? null : value)}>
                      <SelectTrigger id="task-list" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="h-48">
                        <SelectItem value={ALL_LISTS}>All lists</SelectItem>
                        {taskLists.map((list) => (
                          <SelectItem key={list.id} value={list.id}>
                            {list.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </PopoverContent>
            </Popover>
          </div>

          {/* What is in force, under the search rather than inside the popover
              that set it — a filter you cannot see from the list it is
              narrowing is a filter people forget they applied. */}
          {activeFilters > 0 ? (
            <p className="px-2 pt-2 text-2xs text-muted-foreground">
              {preset !== "all"
                ? `Created ${PRESETS.find((option) => option.value === preset)?.label.toLowerCase()}`
                : null}
              {preset !== "all" && listId ? " · " : null}
              {listId ? listItems[listId] : null}
            </p>
          ) : null}

          <CommandList className="p-1">
            {filtered && (searching || results === null) ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">Searching…</p>
            ) : filtered && failed ? (
              <p className="px-2 py-3 text-xs text-foreground">
                That search did not go through. Try again, or clear the filters to see your latest tasks.
              </p>
            ) : shown.length === 0 ? (
              <CommandEmpty>
                {filtered
                  ? "No task you are on matches those filters. Widen the dates, or clear them to see your latest tasks."
                  : "Every task you can log against is already on this week."}
              </CommandEmpty>
            ) : null}

            {/* Two lines per option: the task, then its state and where it
                lives. Several open tasks can share a name across departments,
                and the title alone is not enough to pick between them. */}
            {shown.map((task) => (
              <CommandItem
                key={task.id}
                value={task.id}
                onSelect={() => {
                  onAdd(task.id);
                  setOpen(false);
                }}>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium">{task.title}</span>
                  <span className="flex min-w-0 items-center gap-2">
                    <TaskStatusBadge status={task.status} className="h-5 px-1.5" />
                    {task.where ? <span className="truncate text-xs text-muted-foreground">{task.where}</span> : null}
                  </span>
                </span>
              </CommandItem>
            ))}

            {/* Said once the initial cap is reached rather than silently
                truncating — a list that stops at twenty with no explanation is
                a list people believe is complete. */}
            {!filtered && shown.length >= 20 ? (
              <p className="px-2 py-2 text-2xs text-muted-foreground">
                Your 20 most recent tasks. Search or filter to reach older ones.
              </p>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
