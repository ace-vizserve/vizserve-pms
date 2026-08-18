"use client";

import { useTransition } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import {
  TIMESHEET_WEEK_LABELS,
  type TimesheetWeekStatus,
  formatCellDuration,
  isWeekLocked,
} from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { submitTimesheetWeek } from "./actions";

export type WeekState = {
  status: TimesheetWeekStatus;
  submittedAt: string | null;
  decisionReason: string | null;
} | null;

/**
 * P7-05 — handing a week in.
 *
 * The server side of this shipped without a way to reach it: the RPC, the lock
 * and the policies existed, and the only screen that logs time had no submit
 * button. This is that button.
 *
 * `null` is the draft state and is deliberately not a status value — the absence
 * of a row IS "not submitted" (see the migration). So the chip has four states
 * from three enum members, and the fourth is the one you see most.
 *
 * THE LOCK IS THE POINT. A submitted or approved week is read-only in the
 * database, not merely in the UI — every entry policy calls
 * `vizserve_pms_timesheet_week_locked`. This bar says so in words, because a
 * grid that silently refuses to accept a keystroke is worse than one that
 * explains why.
 */
export function WeekStatusBar({
  weekStart,
  week,
  weekTotalMinutes,
}: {
  weekStart: string;
  week: WeekState;
  weekTotalMinutes: number;
}) {
  const [pending, start] = useTransition();

  const status = week?.status ?? null;
  const locked = isWeekLocked(status);

  // Not a status value — see above.
  const label = status ? TIMESHEET_WEEK_LABELS[status] : "Not submitted";

  const tone = !status
    ? "border-border bg-muted text-foreground-muted"
    : status === "APPROVED"
      ? "border-success-border bg-success-subtle text-success"
      : status === "RETURNED"
        ? "border-warning-border bg-warning-subtle text-warning"
        : "border-accent-border bg-accent text-accent-foreground";

  function submit() {
    start(async () => {
      const result = await submitTimesheetWeek({ week_start: weekStart });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Week sent to your department lead.");
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      {/* Same chip shape as every status in the app — fill, hairline, dot. */}
      <span
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-2 rounded-md border grade-chip px-2.5 text-2xs font-semibold whitespace-nowrap",
          tone,
        )}
      >
        <span aria-hidden className="size-1.25 shrink-0 rounded-full bg-current" />
        {label}
      </span>

      <div className="min-w-0 flex-1">
        {status === "RETURNED" && week?.decisionReason ? (
          <p className="text-sm text-foreground-muted">
            <span className="font-medium text-foreground">Sent back:</span>{" "}
            {week.decisionReason}
          </p>
        ) : locked ? (
          <p className="text-sm text-foreground-muted">
            Locked — {formatCellDuration(weekTotalMinutes)} handed in
            {week?.submittedAt ? ` on ${formatDateTime(week.submittedAt)}` : null}. Ask your
            lead to send it back if something needs fixing.
          </p>
        ) : (
          <p className="text-sm text-foreground-muted">
            {weekTotalMinutes > 0
              ? `${formatCellDuration(weekTotalMinutes)} logged. Submitting locks the week until your lead decides.`
              : "Nothing logged yet. A week with no hours has nothing to hand in."}
          </p>
        )}
      </div>

      {/* Hidden rather than disabled once locked: there is no second submission
          to make, so a greyed button would only invite the question. */}
      {locked ? null : (
        <Button onClick={submit} loading={pending} disabled={weekTotalMinutes <= 0}>
          <Send />
          {status === "RETURNED" ? "Resubmit week" : "Submit for approval"}
        </Button>
      )}
    </div>
  );
}
