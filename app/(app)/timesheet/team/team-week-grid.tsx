"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Clock, Undo2 } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { OvertimeApprovalLinks } from "@/components/overtime-approval-links";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Chip, TaskStatusBadge } from "@/components/status-badge";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate, formatDuration, formatWeekday } from "@/lib/dates";
import {
  TIMESHEET_WEEK_LABELS,
  type OvertimeApproval,
  type PunchComparison,
  type TimesheetWeekStatus,
  daySummary,
  formatCellDuration,
  overtimeGranted,
  punchComparison,
} from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { decideTimesheetWeek } from "../actions";

/** One time entry, as a reviewer reads it: how long, when in the day, what for. */
export type TeamEntry = {
  id: string;
  minutes: number;
  note: string | null;
  /** `HH:MM` wall clock on the entry's own day, or null. Both or neither. */
  started_at: string | null;
  ended_at: string | null;
};

export type TeamTaskRow = {
  taskId: string;
  /** The placeholder when the embed came back null — see the page. Never blank. */
  title: string;
  /** Null when the task has left this lead's scope. The hours are unaffected. */
  status: VizservePmsTaskStatus | null;
  /**
   * P8-08 — "Marketing / Campaigns / Client QA", or as much of it as resolved.
   *
   * Empty for a task this reviewer can no longer see, and empty is rendered as
   * nothing at all. Two lists called "Client QA" in two departments produced two
   * rows that read identically before this line existed.
   */
  where: string;
  /** `YYYY-MM-DD` → the entries logged against this task that day. */
  cells: Record<string, TeamEntry[]>;
};

export type TeamRow = {
  userId: string;
  name: string;
  /** `YYYY-MM-DD` → minutes logged. */
  cells: Record<string, number>;
  /**
   * `YYYY-MM-DD` → the approved OVERTIME requests covering that day.
   *
   * ⚠️ THE REQUESTS, NOT THEIR TOTAL. `overtimeGranted` sums them for the
   * threshold; the ids are what let a reviewer open the signature behind a day
   * marked "OT". A day this lead may not read the request for arrives absent,
   * not empty-with-minutes — see the page.
   */
  overtime: Record<string, OvertimeApproval[]>;
  /** Days this person was on approved leave. */
  leaveDays: string[];
  /** P8-07 — what the hours went to, alphabetical by task. */
  tasks: TeamTaskRow[];
  /**
   * P8-07 — `YYYY-MM-DD` → punched minutes LESS THE UNPAID BREAK, null for a
   * shift never closed.
   *
   * ⚠️ AN ABSENT KEY IS "NOBODY PUNCHED", WHICH IS NOT ZERO.
   * ⚠️ NOT THE RAW SPAN BETWEEN THE TWO CLOCKS. `breakAdjustedPunches` takes the
   * break off on the server, because a logged minute is working time and the
   * span between punches is not — see the page. Anything that puts a raw span in
   * here makes every ordinary 08:00-17:00 week look like an hour a day of
   * unlogged time.
   */
  punched: Record<string, number | null>;
  /**
   * P8-07 — false when this person's unpaid break could not be worked out, so
   * their punched hours cannot be made comparable with their logged ones.
   *
   * ⚠️ NOT THE SAME AS AN EMPTY PUNCH RECORD. `punched` arrives empty in that
   * case, and rendering it as "no punch" would accuse somebody of never clocking
   * in on the strength of a settings row that failed to load.
   */
  punchesComparable: boolean;
  weekId: string | null;
  status: TimesheetWeekStatus | null;
  submittedMinutes: number | null;
  decisionReason: string | null;
};

function taskTotal(task: TeamTaskRow, days: string[]): number {
  return days.reduce(
    (total, day) => total + (task.cells[day] ?? []).reduce((cell, entry) => cell + entry.minutes, 0),
    0,
  );
}

/**
 * The team's week — the transpose of the member's grid.
 *
 * READ-ONLY, AND THAT IS ENFORCED RATHER THAN INTENDED. The write policies on
 * `vizserve_pms_timesheet_entries` are owner-only (`20260817090000:173/181/190`),
 * so a lead physically cannot edit a member's hours — there is no input here
 * because there is no write to make, not because the UI is withholding one. An
 * editor that is also a report produces a report nobody trusts.
 *
 * `dayState` and `formatCellDuration` come from the member's page unchanged, so
 * a long Tuesday reads identically to the person who logged it and to the lead
 * approving it. That is the reason they were extracted.
 *
 * P8-07 — EVERY PERSON ROW OPENS. Hours per day and nothing about what they went
 * to is a rubber stamp with a table around it, and until now there was no screen
 * anywhere in this app where a reviewer could see somebody else's per-task
 * breakdown. Expanding mirrors the member's own grid: tasks down the side, the
 * same seven days across, the same durations in the same format — so a lead and
 * the person they are reviewing are looking at one shape, not two.
 */
export function TeamWeekGrid({
  monday,
  days,
  today,
  rows,
  punchesLoaded = true,
}: {
  monday: string;
  days: string[];
  today: string;
  rows: TeamRow[];
  /**
   * P8-07 — false when the DTR read failed.
   *
   * ⚠️ NOT THE SAME AS AN EMPTY PUNCH RECORD, and conflating the two is the
   * failure this flag exists to stop: a dead query would otherwise print "no
   * punch" across everybody's week, which accuses fourteen people of something
   * on the strength of a network error.
   */
  punchesLoaded?: boolean;
}) {
  const dayTotal = (day: string) => rows.reduce((total, row) => total + (row.cells[day] ?? 0), 0);
  const rowTotal = (row: TeamRow) => days.reduce((total, day) => total + (row.cells[day] ?? 0), 0);
  const weekTotal = days.reduce((total, day) => total + dayTotal(day), 0);

  const awaiting = rows.filter((row) => row.status === "SUBMITTED").length;

  /*
   * WHICH PEOPLE ARE SHOWING THEIR WORKING.
   *
   * ⚠️ LOCAL STATE, NEVER THE URL. `components/data-table.tsx:276-281` settles
   * the same question for its own `getSubRows` and the reasoning carries here
   * unchanged: sorting changes which rows exist and has to reach the server,
   * whereas opening a person changes only what this reviewer is looking at right
   * now. In the query string every collapse becomes a navigation, and a week
   * pasted into a chat would arrive carrying somebody else's reading position.
   *
   * A Set of user ids rather than a boolean per row, so two people can be open
   * side by side — which is what comparing them means.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  function toggleExpanded(userId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card grade-surface p-8 text-center shadow-raised-lg">
        <p className="text-sm font-medium">Nothing logged in your department this week.</p>
        {/* Two ways to be empty and they are not the same: nobody has filled
            anything in yet, or this lead leads nobody. Saying both beats a bare
            "no data". */}
        <p className="mt-1 text-xs text-muted-foreground">
          Nobody has entered hours for {formatDate(monday)} yet — or nobody is assigned to a
          department you lead.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
      {awaiting > 0 ? (
        <p className="border-b bg-accent px-3 py-2 text-xs font-medium text-accent-foreground">
          {awaiting === 1 ? "1 week is" : `${awaiting} weeks are`} waiting on your decision.
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-232 border-collapse text-sm">
          <caption className="sr-only">
            Hours logged per person per day for the week beginning {formatDate(monday)}, with each
            person&rsquo;s submission status. Open a person to see the tasks behind their hours and
            the hours they punched on the DTR.
          </caption>

          <thead>
            <tr className="border-b">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground"
              >
                Person
              </th>

              {days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className={cn(
                    "px-1 py-2 text-center text-xs font-medium",
                    day === today ? "text-foreground" : "text-muted-foreground",
                    day > today && "text-foreground-faint",
                  )}
                >
                  {formatWeekday(day)}
                  <span className="mt-0.5 block text-2xs font-normal">
                    {Number(day.slice(8, 10))}
                  </span>
                </th>
              ))}

              <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-muted-foreground">
                Total
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                Week
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const leave = new Set(row.leaveDays);
              const open = expanded.has(row.userId);
              const logged = rowTotal(row);

              // Both records, side by side, computed once for the person row's
              // sentence and the punched row's cells so the two cannot drift.
              const punches = punchComparison({ days, punched: row.punched, logged: row.cells });

              return (
                <Fragment key={row.userId}>
                  <tr className="border-b">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 w-[22%] max-w-0 bg-card px-3 py-2 text-left font-normal"
                    >
                      <span className="flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="-ml-1 shrink-0"
                          aria-expanded={open}
                          onClick={() => toggleExpanded(row.userId)}
                        >
                          <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
                          {/* Offered on every person, including one with no
                              tasks: "punched all week, logged nothing" is a
                              breakdown worth opening, and it lives behind this
                              same control. */}
                          <span className="sr-only">
                            {open ? "Hide" : "Show"} what {row.name} logged this week
                          </span>
                        </Button>

                        <span className="block min-w-0 flex-1 truncate font-medium" title={row.name}>
                          {row.name}
                        </span>
                      </span>
                    </th>

                    {days.map((day) => {
                      const minutes = row.cells[day] ?? 0;
                      const approvals = row.overtime[day];
                      const granted = overtimeGranted(approvals);
                      // The same function the member's own grid reads, so the two
                      // views cannot drift into disagreeing about a day — which is
                      // the exact disagreement a lead would have to arbitrate.
                      const { state, capacityMinutes, overMinutes } = daySummary(minutes, granted);
                      const onLeave = leave.has(day);

                      return (
                        <td
                          key={day}
                          className={cn(
                            "border-l px-1 py-2 text-center text-sm tabular-nums",
                            day > today && "bg-muted/30",
                          )}
                        >
                          {minutes > 0 ? (
                            <>
                              <span
                                className={cn(
                                  state === "over" && "font-semibold text-destructive",
                                  state === "overtime" && "font-semibold text-warning",
                                )}
                              >
                                {formatCellDuration(minutes)}
                              </span>
                              {/* The word, not just the colour — the same rule the
                                  member's own grid follows. */}
                              {state === "over" || state === "overtime" ? (
                                <span
                                  aria-hidden
                                  className={cn(
                                    "mt-0.5 block text-2xs leading-none font-medium",
                                    state === "over" ? "text-destructive" : "text-warning",
                                  )}
                                >
                                  {/* The amount on screen, not only in the spoken
                                      sentence. A lead deciding whether to send a
                                      week back needs to see how far over it is,
                                      and "over" alone made them open the member's
                                      own grid to find out. */}
                                  {state === "over" ? `over +${formatDuration(overMinutes)}` : "OT"}
                                </span>
                              ) : null}
                              {state === "over" || state === "overtime" ? (
                                <span className="sr-only">
                                  {formatDuration(minutes)} logged,{" "}
                                  {state === "over"
                                    ? `${formatDuration(overMinutes)} more than the ${formatDuration(
                                        capacityMinutes,
                                      )} ${granted > 0 ? "approved for this day" : "standard day"}.`
                                    : `within the ${formatDuration(
                                        capacityMinutes,
                                      )} approved for this day.`}
                                </span>
                              ) : null}

                              {/* P8-08 — who signed off on this day, and for how
                                  long. A lead deciding whether to send a week
                                  back needs the approval itself, not the fact
                                  that one exists; without it the only way to
                                  check was to go and search the queue.

                                  Only on a flagged day, and only for approvals
                                  that came back from the policy-scoped read — so
                                  a lead is never offered a link to somebody
                                  else's request that `/approvals/[id]` would
                                  refuse them. */}
                              {state === "over" || state === "overtime" ? (
                                <OvertimeApprovalLinks approvals={approvals} />
                              ) : null}
                            </>
                          ) : onLeave ? (
                            // An empty cell on a day somebody was away is not a
                            // gap to chase. No reason and no leave type — the
                            // calendar function does not return either, on
                            // purpose.
                            <span className="text-2xs text-muted-foreground">on leave</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      );
                    })}

                    <td className="border-l px-2 py-2 text-right text-sm font-medium tabular-nums">
                      {logged > 0 ? formatCellDuration(logged) : "—"}
                    </td>

                    <td className="border-l px-3 py-2">
                      <div className="space-y-1.5">
                        <WeekDecision row={row} loggedMinutes={logged} />
                        <PunchedVsLogged
                          name={row.name}
                          punches={punches}
                          punchesLoaded={punchesLoaded}
                          comparable={row.punchesComparable}
                        />
                      </div>
                    </td>
                  </tr>

                  {open ? (
                    <PunchedRow
                      days={days}
                      punched={row.punched}
                      logged={row.cells}
                      punches={punches}
                      punchesLoaded={punchesLoaded}
                      comparable={row.punchesComparable}
                    />
                  ) : null}

                  {open
                    ? row.tasks.map((task) => (
                        <Fragment key={task.taskId}>
                          <TaskRow task={task} days={days} />

                          {/*
                            ONE LINE PER ENTRY, WHERE THE ENTRY HAS SOMETHING THE
                            TASK ROW CANNOT SAY.

                            The migration allows several entries per task per day
                            precisely BECAUSE the notes differ — "an hour before
                            lunch and two after is two facts with two notes" — and
                            summing them is right for reading and useless for
                            checking, which is what a reviewer is doing here. An
                            entry carrying neither a note nor a clock, alone in
                            its cell, is fully described by the number above it,
                            so it gets no line: the point is the working, not a
                            second copy of the same figure.
                          */}
                          {detailEntries(task, days).map(({ day, entry }) => (
                            <EntryLine key={entry.id} day={day} days={days} entry={entry} />
                          ))}
                        </Fragment>
                      ))
                    : null}

                  {open && row.tasks.length === 0 ? (
                    <tr className="border-b bg-muted">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 bg-muted py-1.5 pr-3 pl-11 text-left text-2xs font-normal text-muted-foreground"
                      >
                        No time logged against any task this week.
                      </th>
                      <td className="bg-muted" colSpan={days.length + 2} />
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>

          <tfoot>
            <tr className="border-t bg-muted">
              <th
                scope="row"
                className="sticky left-0 z-10 bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground"
              >
                Total
              </th>

              {days.map((day) => (
                <td
                  key={day}
                  className="border-l px-1 py-2 text-center text-sm font-semibold tabular-nums"
                >
                  {dayTotal(day) > 0 ? formatCellDuration(dayTotal(day)) : "—"}
                </td>
              ))}

              <td className="border-l px-2 py-2 text-right text-sm font-semibold tabular-nums">
                {weekTotal > 0 ? formatCellDuration(weekTotal) : "—"}
              </td>
              <td className="border-l" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/**
 * The entries under a task that the task row cannot account for on its own.
 *
 * A note, a pair of clock times, or a cell holding more than one entry. Ordered
 * the way the week runs, then by when in the day the entry started — an entry
 * with no times sorts first, because it is the older shape from before a typed
 * duration carried a clock and it has nothing to sort by.
 */
function detailEntries(task: TeamTaskRow, days: string[]) {
  return days.flatMap((day) => {
    const cell = task.cells[day] ?? [];
    const split = cell.length > 1;

    return [...cell]
      .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""))
      .filter((entry) => split || entry.note || entry.started_at)
      .map((entry) => ({ day, entry }));
  });
}

/**
 * One task, across the same seven days as the person above it.
 *
 * ⚠️ SOLID `bg-muted`, not `bg-muted/40`. The first column is sticky, and a
 * translucent fill lets the cells scrolling underneath show straight through it
 * — the member's grid carries the same warning for the same reason.
 */
function TaskRow({ task, days }: { task: TeamTaskRow; days: string[] }) {
  const total = taskTotal(task, days);

  /*
   * ⚠️ A NULL STATUS IS THE NULL EMBED — the page sets both from the same
   * `entry.vizserve_pms_tasks` — and that is what decides whether the title may
   * be a link. A task this reviewer can no longer read must keep its hours and
   * its placeholder and must NOT be offered as a link to a page `/tasks/[id]`
   * would refuse them, which is a 404 dressed up as an affordance.
   */
  const visible = task.status !== null;

  return (
    <tr className="border-b bg-muted">
      <th
        scope="row"
        className="sticky left-0 z-10 max-w-0 bg-muted py-1.5 pr-3 pl-11 text-left font-normal"
      >
        {/* P8-08 — the way OUT of the review. A reviewer could see that "Client
            QA" took seven hours and had no way to look at it; the house
            treatment for a task title is a link to the task, the same as
            `/tasks` and every dashboard row. */}
        {visible ? (
          <Link
            href={`/tasks/${task.taskId}`}
            className="block truncate text-xs font-medium hover:underline"
            title={task.title}
          >
            {task.title}
          </Link>
        ) : (
          <span className="block truncate text-xs font-medium" title={task.title}>
            {task.title}
          </span>
        )}

        {/* Where the hours sat. Two lists called "Client QA" in two departments
            read identically without it, and a lead reviewing a week cannot ask
            about work they cannot locate.

            ONE MUTED LINE THAT TRUNCATES. The grid is seven day columns wide
            before it is readable; a breadcrumb that wrapped would push every day
            on the row down a line, and `max-w-0` on the cell above is what makes
            `truncate` do anything at all. The full path stays in the tooltip. */}
        {task.where ? (
          <span className="block truncate text-2xs text-muted-foreground" title={task.where}>
            {task.where}
          </span>
        ) : null}

        {task.status ? (
          <TaskStatusBadge status={task.status} className="mt-0.5 h-5 px-1.5" />
        ) : (
          /*
           * THE HOURS ARE STILL HERE AND THE ROW STILL COUNTS. The LEFT embed on
           * the page exists so a task reassigned away — or deleted — cannot take
           * somebody's week with it; dropping the row here would reintroduce
           * exactly that bug one layer up. Said in words, not left blank, so it
           * reads as a fact rather than a rendering fault.
           */
          <span className="mt-0.5 block text-2xs text-muted-foreground">
            Task no longer visible to you — the hours still count
          </span>
        )}
      </th>

      {days.map((day) => {
        const minutes = (task.cells[day] ?? []).reduce((cell, entry) => cell + entry.minutes, 0);

        return (
          <td
            key={day}
            className="border-l bg-muted px-1 py-1.5 text-center text-xs tabular-nums text-foreground-muted"
          >
            {minutes > 0 ? formatCellDuration(minutes) : ""}
          </td>
        );
      })}

      <td className="border-l bg-muted px-2 py-1.5 text-right text-xs font-medium tabular-nums">
        {total > 0 ? formatCellDuration(total) : ""}
      </td>
      <td className="border-l bg-muted" />
    </tr>
  );
}

/** One entry: when in the day, what it was for, and its minutes under its own day. */
function EntryLine({ day, days, entry }: { day: string; days: string[]; entry: TeamEntry }) {
  return (
    <tr className="border-b bg-muted">
      <th
        scope="row"
        className="sticky left-0 z-10 max-w-0 bg-muted py-1 pr-3 pl-16 text-left font-normal"
      >
        <span className="flex min-w-0 items-center gap-2 text-2xs">
          <Clock className="size-3 shrink-0 text-foreground-faint" aria-hidden />

          {/* An entry logged before a typed duration carried a clock has only its
              length. A blank here would read as a rendering fault rather than a
              fact about an older row. */}
          <span className="shrink-0 tabular-nums text-foreground-muted">
            {entry.started_at && entry.ended_at
              ? `${entry.started_at} – ${entry.ended_at}`
              : "No times recorded"}
          </span>

          {entry.note ? (
            <span className="truncate text-muted-foreground" title={entry.note}>
              {entry.note}
            </span>
          ) : null}
        </span>
      </th>

      {days.map((column) => (
        <td
          key={column}
          className="border-l bg-muted px-1 py-1 text-center text-2xs tabular-nums text-foreground-muted"
        >
          {column === day ? formatCellDuration(entry.minutes) : ""}
        </td>
      ))}

      <td className="border-l bg-muted" />
      <td className="border-l bg-muted" />
    </tr>
  );
}

/**
 * P8-07 — the DTR's punched hours, on the row under the timesheet's logged ones.
 *
 * ⚠️ THE TWO RECORDS ARE PRESENTED, NOT RECONCILED. The DTR owns "when somebody
 * was at work" and the timesheet owns "where the day went" (`p6_01:15-19`,
 * `p7_21:12-24`). They are separate tables with no relation between them on
 * purpose. This row shows both figures and names the difference; it says nothing
 * about which is authoritative, and a gap is a question for a lead to ask, not a
 * fault the screen has detected. Nothing is coloured as wrong for that reason.
 *
 * ⚠️ THE BREAK IS ALREADY OFF THESE FIGURES, AND THE LABEL SAYS SO. Comparing a
 * raw punch-to-punch span against logged working time puts an hour a day between
 * them on a completely ordinary week — see `breakAdjustedPunches`. What is on
 * this row is the span less the unpaid break, which is the same kind of number
 * as the logged hours above it.
 *
 * ⚠️ MISSING IS NOT ZERO. A day with no DTR row means nobody punched, which is a
 * different statement from punching and working nothing — it renders as "no
 * punch", never as a duration.
 */
function PunchedRow({
  days,
  punched,
  logged,
  punches,
  punchesLoaded,
  comparable,
}: {
  days: string[];
  /** Break already deducted on the server — see above. Null is a shift never closed. */
  punched: Record<string, number | null>;
  logged: Record<string, number>;
  punches: PunchComparison;
  punchesLoaded: boolean;
  /** False when this person's break is unknown, so no figure here is comparable. */
  comparable: boolean;
}) {
  return (
    <tr className="border-b bg-muted">
      <th
        scope="row"
        className="sticky left-0 z-10 max-w-0 bg-muted py-1.5 pr-3 pl-11 text-left font-normal"
      >
        {/* The label names the arithmetic. "Punched (DTR)" described the raw span
            and this is no longer that — a lead reading a figure an hour short of
            the clock deserves to be told why in the row header rather than left
            to work it out. */}
        <span className="block truncate text-xs font-medium">Punched less break (DTR)</span>
        <span className="mt-0.5 block text-2xs text-muted-foreground">
          Time between punches with the unpaid break taken off, so it compares like with like.
          Neither record is the other&rsquo;s source.
        </span>
      </th>

      {days.map((day) => {
        const has = day in punched;
        const minutes = punched[day] ?? null;
        const loggedToday = logged[day] ?? 0;
        const gap = minutes === null ? null : minutes - loggedToday;

        return (
          <td
            key={day}
            className="border-l bg-muted px-1 py-1.5 text-center text-xs tabular-nums text-foreground-muted"
          >
            {!punchesLoaded ? (
              <span className="text-2xs text-muted-foreground">not loaded</span>
            ) : !comparable ? (
              // NOT "no punch": these punches may be perfectly complete. What is
              // missing is the break that would make them comparable.
              <span className="text-2xs text-muted-foreground">not compared</span>
            ) : !has ? (
              // The distinction the whole comparison rests on: nobody punched,
              // which is not the same as punching nothing.
              <span className="text-2xs text-muted-foreground">no punch</span>
            ) : minutes === null ? (
              <>
                <span className="text-2xs text-muted-foreground">no punch out</span>
                <span className="sr-only">
                  Punched in on {formatWeekday(day)} and never out, so the length of that day is
                  unknown.
                </span>
              </>
            ) : (
              <>
                {formatCellDuration(minutes)}
                {gap !== null && gap !== 0 ? (
                  <>
                    <span aria-hidden className="mt-0.5 block text-2xs leading-none">
                      {formatDuration(Math.abs(gap))} {gap > 0 ? "more" : "less"}
                    </span>
                    <span className="sr-only">
                      {formatDuration(minutes)} punched on {formatWeekday(day)} once the break is
                      taken off, {formatDuration(Math.abs(gap))}{" "}
                      {gap > 0 ? "more than" : "less than"} the {formatDuration(loggedToday)} logged.
                    </span>
                  </>
                ) : null}
              </>
            )}
          </td>
        );
      })}

      {/*
        THE WEEK TOTAL, AND WHETHER IT IS A TOTAL AT ALL.

        `punchedMinutes` skips every day that was never punched out, so on an
        incomplete week it is a FLOOR wearing the shape of a total. Printed bare
        it invites a lead to subtract it from the logged figure in their head and
        arrive at a gap that does not exist. The number stays — it is true as far
        as it goes — and the marker says how far that is.
      */}
      <td className="border-l bg-muted px-2 py-1.5 text-right text-xs font-medium tabular-nums">
        {punchesLoaded && comparable && punches.punchedMinutes !== null ? (
          <>
            {formatCellDuration(punches.punchedMinutes)}
            {!punches.complete ? (
              <>
                {/* The word, never the shape alone — the rule every status in
                    this app follows. */}
                <span aria-hidden className="mt-0.5 block text-2xs leading-none font-normal">
                  part week
                </span>
                <span className="sr-only">
                  {" "}
                  at least, rather than the week&rsquo;s total — {describePunchGaps(punches)}.
                </span>
              </>
            ) : null}
          </>
        ) : null}
      </td>
      <td className="border-l bg-muted" />
    </tr>
  );
}

/**
 * Why a punched week is a floor rather than a total — "2 days never punched
 * out", "1 day logged with no punch", or both.
 *
 * One function because the same phrase is needed in two places that must not
 * drift: the week-total cell's spoken caveat, and the summary in the decision
 * column. Only ever called where `complete` is false, so it never returns "".
 */
function describePunchGaps({ openDays, unpunchedDays }: PunchComparison): string {
  return [
    openDays > 0 ? `${openDays} day${openDays === 1 ? "" : "s"} never punched out` : null,
    unpunchedDays > 0
      ? `${unpunchedDays} day${unpunchedDays === 1 ? "" : "s"} logged with no punch`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The week in one sentence: punched, logged, and the difference.
 *
 * Sits in the decision column because that is where the lead is looking when
 * they decide. Deliberately NOT styled as a warning — see `PunchedRow`: the gap
 * is a question, and the screen has no basis for calling either figure wrong.
 *
 * ⚠️ THE GAP IS ONLY STATED WHEN IT IS KNOWN, which is the whole reason
 * `complete` exists. One forgotten punch-out drops that day out of the punched
 * total while the timesheet keeps every minute of it, so the difference renders
 * as "4h less on the clock than on the timesheet" — an accusation of
 * over-logging manufactured entirely out of a missing click. The per-day figures
 * stay, because each of those is still exactly true.
 */
function PunchedVsLogged({
  name,
  punches,
  punchesLoaded,
  comparable,
}: {
  name: string;
  punches: PunchComparison;
  punchesLoaded: boolean;
  comparable: boolean;
}) {
  if (!punchesLoaded) {
    return (
      <p className="text-2xs text-muted-foreground">
        Punched hours unavailable — the DTR could not be read.
      </p>
    );
  }

  if (!comparable) {
    // The punched span includes the unpaid break and a logged minute does not,
    // so without a break there is no arithmetic to do. Saying which figure is
    // missing beats a silent row that looks like nobody ever clocked in.
    return (
      <p className="text-2xs text-muted-foreground">
        Punched hours not compared — {name}&rsquo;s unpaid break could not be worked out, so the two
        records are not the same kind of figure.
      </p>
    );
  }

  const { punchedMinutes, loggedMinutes, gapMinutes, complete } = punches;

  return (
    <div className="space-y-0.5">
      <p className="text-2xs text-muted-foreground">
        Punched{" "}
        <span className="tabular-nums text-foreground-muted">
          {punchedMinutes === null ? "nothing this week" : formatCellDuration(punchedMinutes)}
        </span>{" "}
        less break · logged{" "}
        <span className="tabular-nums text-foreground-muted">
          {formatCellDuration(loggedMinutes)}
        </span>
      </p>

      {!complete ? (
        /* A floor rather than a total, so the difference is not a fact yet. The
           reason is named: a lead can act on "Tuesday was never punched out" and
           can do nothing whatever with a number that is quietly wrong. */
        <p className="text-2xs text-muted-foreground">
          The two cannot be compared this week — {describePunchGaps(punches)}. The days above are
          still exact.
        </p>
      ) : gapMinutes !== null && gapMinutes !== 0 ? (
        <p className="text-2xs text-foreground-muted">
          {formatDuration(Math.abs(gapMinutes))} {gapMinutes > 0 ? "more" : "less"} on the clock than
          on the timesheet, once the unpaid break is taken off.
          <span className="sr-only"> This is {name}&rsquo;s week.</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * One person's submission status, and the two things a lead can do about it.
 *
 * Approve and send back, and pointedly NOT reject — `vizserve_pms_decide_timesheet_week`
 * refuses `'rejected'`, because there is no meaningful terminal rejection of
 * hours somebody worked. A week with a wrong Tuesday needs fixing and
 * resubmitting; that is what returning means.
 */
function WeekDecision({ row, loggedMinutes }: { row: TeamRow; loggedMinutes: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");

  function decide(input: { decision: "approved" } | { decision: "returned"; reason: string }) {
    if (!row.weekId) return;

    startTransition(async () => {
      const result = await decideTimesheetWeek(row.weekId!, input);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(
        input.decision === "approved" ? `${row.name}'s week approved.` : `Sent back to ${row.name}.`,
      );
      setReturning(false);
      setReason("");
      router.refresh();
    });
  }

  if (!row.status) {
    return (
      <span className="block text-2xs text-muted-foreground">
        {loggedMinutes > 0 ? "Not handed in" : "Nothing to hand in"}
      </span>
    );
  }

  const tone =
    row.status === "APPROVED" ? "success" : row.status === "RETURNED" ? "warning" : "info";

  return (
    <div className="space-y-1.5">
      <Chip tone={tone} label={TIMESHEET_WEEK_LABELS[row.status]} />

      {/* What they attested to, when it is not what the grid now shows. The
          reviewer sees LIVE entries; `submitted_minutes` is the figure the
          person signed off. Saying so beats silently showing a different
          number from the one they submitted. */}
      {row.submittedMinutes !== null && row.submittedMinutes !== loggedMinutes ? (
        <p className="text-2xs text-warning">
          Submitted as {formatCellDuration(row.submittedMinutes)}; now{" "}
          {formatCellDuration(loggedMinutes)}.
        </p>
      ) : null}

      {row.status === "RETURNED" && row.decisionReason ? (
        <p className="text-2xs text-muted-foreground">Sent back: {row.decisionReason}</p>
      ) : null}

      {row.status === "SUBMITTED" ? (
        returning ? (
          <div className="space-y-1.5">
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              placeholder="What needs fixing?"
              aria-label={`Why ${row.name}'s week is going back`}
              className="text-xs"
            />
            <div className="flex gap-1.5">
              {/* The engine enforces the reason on `returned` too; disabling
                  here just saves the round trip. */}
              <Button
                size="sm"
                variant="outline"
                loading={pending}
                disabled={reason.trim().length < 5}
                onClick={() => decide({ decision: "returned", reason: reason.trim() })}
              >
                Send back
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setReturning(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <Button size="sm" loading={pending} onClick={() => decide({ decision: "approved" })}>
              <Check />
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => setReturning(true)}>
              <Undo2 />
              Send back
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}
