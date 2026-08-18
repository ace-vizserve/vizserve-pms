import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { formatWeekRange } from "@/lib/dates";
import { STANDARD_DAY_MINUTES } from "@/lib/dates";
import {
  TIMESHEET_WEEK_LABELS,
  type TimesheetWeekStatus,
  formatCellDuration,
} from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

/**
 * I3 — the timesheet strip.
 *
 * One band, above the fold, reading whichever of FOUR states applies to this
 * week — and there are four from three enum members because the absence of a
 * week row IS the draft state (see `p7_05`). "Not submitted" is the one people
 * see most and the one that is not a value.
 *
 * `RETURNED` OUTRANKS EVERYTHING ELSE ON THE PAGE, with the lead's reason quoted
 * inline. It is the only state in the app where a named person has stopped and is
 * waiting on this user, and until now you found out by navigating to /timesheet
 * and reading the bar.
 *
 * NO NEW ARITHMETIC. `formatCellDuration` and `STANDARD_DAY_MINUTES` come from
 * the same modules the grid uses. A dashboard that computes hours its own way is
 * how two screens start disagreeing about the same week — and this one would be
 * the copy without the day-state rules.
 */
export function TimesheetStrip({
  weekStart,
  status,
  minutes,
  decisionReason,
  /**
   * A PREVIOUS week with entries and no week row.
   *
   * This is the nag that replaces a lead chasing people in Teams, and it is most
   * of the reason the module was built. Null when last week was handed in, or
   * when there was nothing in it to hand in — an empty week is not a missing one,
   * and slice C refuses to submit one anyway.
   */
  lastWeekUnsubmitted,
}: {
  weekStart: string;
  status: TimesheetWeekStatus | null;
  minutes: number;
  decisionReason: string | null;
  lastWeekUnsubmitted: string | null;
}) {
  const label = status ? TIMESHEET_WEEK_LABELS[status] : "Not submitted";

  const tone = !status
    ? "border-border bg-muted"
    : status === "APPROVED"
      ? "border-success-border bg-success-subtle"
      : status === "RETURNED"
        ? "border-warning-border bg-warning-subtle"
        : "border-accent-border bg-accent";

  /** Five working days. The comparison, not a target — see below. */
  const standardWeek = STANDARD_DAY_MINUTES * 5;

  return (
    <section
      className={cn("space-y-2 rounded-lg border p-3 grade-surface shadow-raised", tone)}
      aria-label="This week's timesheet"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />

        <span className="text-sm font-semibold">{formatWeekRange(weekStart)}</span>

        {/* The state in words, always. A tinted band with no label is colour
            carrying state on its own. */}
        <span className="text-xs font-medium">{label}</span>

        <span className="text-xs tabular-nums text-muted-foreground">
          {formatCellDuration(minutes)}
          {/* Against the standard week rather than as a bare number — 22h means
              nothing until you know whether the week is half over. It is stated
              as a comparison and NOT as a progress bar: a bar implies a target,
              and hours logged is a record of what happened, not a quota. */}
          {" of "}
          {formatCellDuration(standardWeek)}
        </span>

        <Link
          href="/timesheet"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto")}
        >
          {/* The action matches the state. "Submit" is not offered from here —
              the grid's own bar owns that, because submitting a week you cannot
              see the contents of is not a thing to make easy. */}
          {status === "RETURNED" ? "Fix and resubmit" : "Open my timesheet"}
          <ArrowRight className="size-3.5" />
        </Link>
      </div>

      {/* The lead's reason, quoted. A returned week with the reason on another
          screen is a week somebody resubmits unchanged. */}
      {status === "RETURNED" && decisionReason ? (
        <p className="flex items-start gap-2 border-t border-current/15 pt-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Returned to you: <span className="font-medium">{decisionReason}</span>
          </span>
        </p>
      ) : null}

      {lastWeekUnsubmitted ? (
        <p className="flex items-start gap-2 border-t border-current/15 pt-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            {formatWeekRange(lastWeekUnsubmitted)} was never handed in.{" "}
            <Link href={`/timesheet?week=${lastWeekUnsubmitted}`} className="underline">
              Open it
            </Link>
          </span>
        </p>
      ) : null}
    </section>
  );
}
