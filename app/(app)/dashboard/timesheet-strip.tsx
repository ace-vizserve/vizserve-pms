import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { formatWeekRange } from "@/lib/dates";
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
 * NO NEW ARITHMETIC. `formatCellDuration` comes from the same module the grid
 * uses, and the week's target arrives already computed by `loadScheduledWeek` —
 * the function `/timesheet` calls. A dashboard that computes hours its own way is
 * how two screens start disagreeing about the same week, and this one did: it
 * rendered `STANDARD_DAY_MINUTES * 5` and told everybody they owed 40 hours.
 *
 * ⚠️ THERE IS NO WEEKLY CONSTANT IN THIS REPO AND THERE MUST NOT BE ONE.
 * `lib/dates.ts:417-419` says why — a 40-hour constant means deciding whether
 * Saturday counts, and nobody has answered that. The honest per-person figure is
 * `(scheduled day) x (working days - approved leave)`, which is what P8-05
 * computes and what `vizserve_pms_submit_timesheet_week` enforces. Anything that
 * reintroduces a multiplication by five here is a regression, not a shortcut.
 */
export function TimesheetStrip({
  weekStart,
  status,
  minutes,
  scheduledWeekMinutes,
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
  /**
   * P8-05 — what this person's week was supposed to come to, or NULL.
   *
   * ⚠️ NULL IS A REAL ANSWER AND ITS RENDERING IS "SAY NOTHING". It arrives for
   * somebody with no recorded schedule, for a week that expected nothing of them
   * (all holiday, all approved leave), and for a week where one of the four reads
   * behind the figure failed. In every one of those cases the logged total stands
   * alone: falling back to a number would be asserting a target derived from a
   * value nobody read, which is exactly how the 40 got here.
   */
  scheduledWeekMinutes: number | null;
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
          {/* Against THIS PERSON'S week when one could be worked out — 22h means
              nothing until you know whether the week is half over. Stated as a
              comparison and NOT as a progress bar: a bar implies a quota, and
              hours logged is a record of what happened.

              A bare total when it could not: no schedule recorded, a week that
              expected nothing, or a read that failed. Silence is the only honest
              rendering of "we do not know", and the shortfall check still runs
              on /timesheet and again in the database at submit time. */}
          {scheduledWeekMinutes !== null ? (
            <>
              {" of "}
              {formatCellDuration(scheduledWeekMinutes)}
            </>
          ) : null}
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
