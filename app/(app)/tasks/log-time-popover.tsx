"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { DatePicker } from "@/components/ui/date-picker";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDate, formatWeekday, startOfWeek } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import type { TimesheetReadClient } from "@/lib/query/fetchers/timesheet";
import { qk } from "@/lib/query/keys";
import { read } from "@/lib/query/read";
import { useRowArmed } from "@/lib/row-arm";
import {
  formatCellDuration,
  isWeekLocked,
  lastEncodableDay,
  type TimesheetWeekStatus,
} from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { EntryForm, EntryRow } from "../timesheet/cell-detail";
import type { CellEntry } from "../timesheet/week-grid";

/**
 * The Time tracked cell, as a way to log time.
 *
 * The timesheet's own form and entry rows (`cell-detail.tsx`), plus the two
 * things a task row needs that a grid cell does not: a date picker, because a
 * task row has no day of its own, and every entry the VIEWER has on the task,
 * any day, because there is no grid around it to show them.
 *
 * ⚠️ ONE READ (`qk.taskEntries`): the entries and which of the viewer's weeks
 * are handed in. That covers the list, which rows are read-only, and whether the
 * picked day can take a new entry. Writes go through `useEntryWrite` with the
 * picked day's `qk.week(...)`, so an hour logged here patches /timesheet if it is
 * cached and rolls back the same way when the database refuses it.
 *
 * The popover closes after a save and the list is reread on the next open, so
 * an insert never needs patching into it.
 *
 * The cell face stays the all-people total from
 * `vizserve_pms_task_tracked_minutes` (P7-15).
 */
export function LogTimePopover({
  taskId,
  taskTitle,
  userId,
  today,
  children,
  className,
  label,
}: {
  taskId: string;
  taskTitle: string;
  userId: string;
  /** Server's today, from `TaskLookups`. */
  today: string;
  /** The cell face — the tracked total, or a dash. */
  children: React.ReactNode;
  className?: string;
  label: string;
}) {
  const armed = useRowArmed();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  /*
   * Started when the pointer rests on the cell, not on every armed row — a
   * list of two hundred rows must not fetch two hundred times. It has usually
   * landed by the click, so the popover opens at its full height rather than
   * growing under the pointer.
   */
  function prefetch() {
    void queryClient.prefetchQuery(taskEntriesQuery(userId, taskId));
  }

  const trigger = {
    "data-arm-slot": "log-time",
    "aria-label": label,
    className,
    onPointerEnter: prefetch,
    onFocus: prefetch,
  };

  // P12 — an unarmed row draws the trigger alone. See `lib/row-arm.tsx`.
  if (!armed) {
    return (
      <button type="button" {...trigger}>
        {children}
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger {...trigger}>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-max min-w-88">
        {/* Mounted with the popup, so every opening starts on today with a
            blank form. */}
        <LogTimeBody
          taskId={taskId}
          taskTitle={taskTitle}
          userId={userId}
          today={today}
          onSaved={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function LogTimeBody({
  taskId,
  taskTitle,
  userId,
  today,
  onSaved,
}: {
  taskId: string;
  taskTitle: string;
  userId: string;
  today: string;
  onSaved: () => void;
}) {
  const [day, setDay] = useState(today);
  /** The entry loaded into the form, or null for a new one. */
  const [editing, setEditing] = useState<TaskEntry | null>(null);
  /** Bumped by Cancel — remounting the form on its key is the reset. */
  const [nonce, setNonce] = useState(0);
  const [listOpen, setListOpen] = useState(true);

  const query = useQuery(taskEntriesQuery(userId, taskId));

  if (query.isError) {
    return (
      <p className="text-xs text-destructive">
        Could not read your timesheet: {query.error.message}
      </p>
    );
  }

  const entries = query.data?.entries ?? [];
  const weekOf = (date: string) => startOfWeek(date) ?? date;
  const monday = weekOf(day);
  const weekKey = qk.week(userId, monday);
  const dayLocked = query.data?.lockedWeeks.includes(monday) ?? false;
  const total = entries.reduce((sum, entry) => sum + entry.minutes, 0);

  function pick(entry: TaskEntry) {
    if (editing?.id === entry.id) {
      setEditing(null);
      return;
    }
    setEditing(entry);
    setDay(entry.work_date);
  }

  const dateControl = (
    <DatePicker
      value={day}
      clearable={false}
      // P7-76 — nothing past the end of this week; the policy refuses it.
      max={lastEncodableDay(today)}
      onChange={(next) => next && setDay(next)}
      className="w-auto shrink-0"
    />
  );

  return (
    <>
      <PopoverHeader>
        <PopoverTitle className="truncate text-sm">{taskTitle}</PopoverTitle>
      </PopoverHeader>

      {/* ⚠️ THE HEADER ROW IS ALWAYS DRAWN, loading or not, at one fixed
          height. A header that arrived with the data would push the form down
          under the pointer. */}
      <div className="flex flex-col gap-1">
        <button
          type="button"
          aria-expanded={listOpen}
          disabled={query.isPending || entries.length === 0}
          onClick={() => setListOpen(!listOpen)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground",
            "enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}>
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              listOpen && "rotate-90",
              entries.length === 0 && "invisible",
            )}
          />
          {query.isPending ? (
            "Loading your entries…"
          ) : entries.length === 0 ? (
            "You have not logged time on this task yet"
          ) : (
            <>
              Your entries · {entries.length} ·{" "}
              <span className="tabular-nums">{formatCellDuration(total)}</span>
            </>
          )}
        </button>

        {listOpen && entries.length > 0 ? (
          <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id}>
                {/* A handed-in week is shown, never offered: no edit, no bin.
                    The database refuses those writes regardless. */}
                <EntryRow
                  entry={entry}
                  date={entry.work_date}
                  locked={query.data!.lockedWeeks.includes(weekOf(entry.work_date))}
                  weekKey={qk.week(userId, weekOf(entry.work_date))}
                  selected={editing?.id === entry.id}
                  onEdit={() => pick(entry)}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {dayLocked ? (
        <div className="flex flex-col gap-2 border-t pt-2">
          {dateControl}
          <p className="text-2xs text-muted-foreground">
            {formatWeekday(day)}, {formatDate(day)} is in a handed-in week — read-only until your
            lead decides.
          </p>
        </div>
      ) : (
        <EntryForm
          key={`${editing?.id ?? "new"}-${nonce}`}
          entry={editing}
          taskId={taskId}
          day={day}
          weekKey={weekKey}
          canCancel={editing !== null}
          dateControl={dateControl}
          onSaved={onSaved}
          onDone={() => {
            setEditing(null);
            setNonce((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

type TaskEntry = CellEntry & { work_date: string };

type TaskEntries = {
  /** Newest first. */
  entries: TaskEntry[];
  /** Mondays of the viewer's submitted or approved weeks. */
  lockedWeeks: string[];
};

function taskEntriesQuery(userId: string, taskId: string) {
  return {
    queryKey: qk.taskEntries(userId, taskId),
    queryFn: () => fetchTaskEntries(browserClient(), { userId, taskId }),
  };
}

/**
 * The viewer's entries on one task, and their handed-in weeks.
 *
 * `user_id` narrows a policy that would also return the viewer's team's rows —
 * this list is "yours", the same as the timesheet grid. Capped: a task somebody
 * has logged against daily for a year still opens a popover, not a page.
 */
async function fetchTaskEntries(
  client: TimesheetReadClient,
  params: { userId: string; taskId: string },
): Promise<TaskEntries> {
  const [entries, weeks] = await Promise.all([
    read<TaskEntry[]>(
      client
        .from("vizserve_pms_timesheet_entries")
        .select("id, work_date, minutes, note, started_at, ended_at")
        .eq("user_id", params.userId)
        .eq("task_id", params.taskId)
        .order("work_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(200),
    ),
    read<{ week_start: string; status: TimesheetWeekStatus }[]>(
      client
        .from("vizserve_pms_timesheet_weeks")
        .select("week_start, status")
        .eq("user_id", params.userId),
    ),
  ]);

  return {
    entries,
    lockedWeeks: weeks.filter((week) => isWeekLocked(week.status)).map((week) => week.week_start),
  };
}
