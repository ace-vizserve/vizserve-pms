"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Chip } from "@/components/status-badge";
import { STANDARD_DAY_MINUTES, formatDate, formatDuration, formatWeekday } from "@/lib/dates";
import {
  TIMESHEET_WEEK_LABELS,
  type TimesheetWeekStatus,
  dayState,
  formatCellDuration,
} from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { decideTimesheetWeek } from "../actions";

export type TeamRow = {
  userId: string;
  name: string;
  /** `YYYY-MM-DD` → minutes logged. */
  cells: Record<string, number>;
  /** `YYYY-MM-DD` → approved overtime minutes. */
  overtime: Record<string, number>;
  /** Days this person was on approved leave. */
  leaveDays: string[];
  weekId: string | null;
  status: TimesheetWeekStatus | null;
  submittedMinutes: number | null;
  decisionReason: string | null;
};

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
 */
export function TeamWeekGrid({
  monday,
  days,
  today,
  rows,
}: {
  monday: string;
  days: string[];
  today: string;
  rows: TeamRow[];
}) {
  const dayTotal = (day: string) => rows.reduce((total, row) => total + (row.cells[day] ?? 0), 0);
  const rowTotal = (row: TeamRow) =>
    days.reduce((total, day) => total + (row.cells[day] ?? 0), 0);
  const weekTotal = days.reduce((total, day) => total + dayTotal(day), 0);

  const awaiting = rows.filter((row) => row.status === "SUBMITTED").length;

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
            person&rsquo;s submission status
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

              return (
                <tr key={row.userId} className="border-b last:border-b-0">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 w-[22%] max-w-0 bg-card px-3 py-2 text-left font-normal"
                  >
                    <span className="block truncate font-medium" title={row.name}>
                      {row.name}
                    </span>
                  </th>

                  {days.map((day) => {
                    const minutes = row.cells[day] ?? 0;
                    const granted = row.overtime[day] ?? 0;
                    const state = dayState(minutes, granted);
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
                                {state === "over" ? "over" : "OT"}
                              </span>
                            ) : null}
                            {state === "over" || state === "overtime" ? (
                              <span className="sr-only">
                                {formatDuration(minutes)} logged,{" "}
                                {state === "over"
                                  ? `${formatDuration(
                                      minutes - STANDARD_DAY_MINUTES - granted,
                                    )} over the approved day.`
                                  : "within the overtime approved for this day."}
                              </span>
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
                    {rowTotal(row) > 0 ? formatCellDuration(rowTotal(row)) : "—"}
                  </td>

                  <td className="border-l px-3 py-2">
                    <WeekDecision row={row} loggedMinutes={rowTotal(row)} />
                  </td>
                </tr>
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
      <span className="text-2xs text-muted-foreground">
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
