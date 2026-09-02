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
  scheduledWeek = null,
  weekHasEnded = false,
}: {
  weekStart: string;
  week: WeekState;
  weekTotalMinutes: number;
  /**
   * P8-05. What this week was supposed to come to, or null when this person is
   * exempt — no schedule recorded, a schedule that computes to nothing, or a
   * week that expected nothing of them. Null renders NOTHING: "0 expected" is a
   * claim about somebody's week that nothing here has grounds to make.
   */
  scheduledWeek?: { expectedDays: number; minimumMinutes: number } | null;
  /**
   * P8-05. Whether the week being shown has finished.
   *
   * ⚠️ IT CHOOSES WHICH SENTENCE IS SAID, AND NEVER WHETHER ONE IS. That is the
   * correction: this flag used to suppress the schedule line outright on the
   * current week, on the reasoning that the minimum covers all five working days
   * and somebody with 8h logged on Tuesday would be told they were "32h short"
   * every day of every week. The reasoning is right and the accusation is gone.
   * The SILENCE was wrong — `vizserve_pms_submit_timesheet_week` refuses only a
   * FUTURE week and applies the full minimum to the current one, so submitting
   * on Thursday with 32h logged met the database's refusal with no prior warning:
   * exactly the surprise this bar exists to prevent. Submitting on Friday
   * afternoon is ordinary and still works.
   *
   * So both weeks say something, and they say different things:
   *
   *   ended    → the warning. Short, why, and what to do about it.
   *   current  → a neutral progress line. The target, and how far along it is.
   *              Muted, not `text-warning`, and it accuses nobody of anything.
   *
   * Decided on the server, not from a clock here: this is a client component,
   * and a browser in another timezone deciding whether a Manila week is over
   * would disagree with the row the server rendered.
   */
  weekHasEnded?: boolean;
}) {
  const [pending, start] = useTransition();

  const status = week?.status ?? null;
  const locked = isWeekLocked(status);

  /* A returned week and the reason it came back travel together — the table's
     own constraint guarantees the reason is present — which is exactly why this
     must not be the thing that decides whether anything ELSE gets said. */
  const returnedReason = status === "RETURNED" ? (week?.decisionReason ?? null) : null;

  /*
   * P8-05 — the shortfall, said BEFORE the button is pressed.
   *
   * `vizserve_pms_submit_timesheet_week` refuses a week below its scheduled
   * minimum. Without this the refusal arrives as a toast on a week somebody
   * thought was finished, which is the worst moment to learn it and the one
   * place a person cannot see what to do about it — this line names the figure
   * and the remedy while the grid is still in front of them.
   *
   * ADVISORY ONLY, AND THE BUTTON STAYS ENABLED. Disabling it would put this
   * client-side arithmetic in charge of a rule the database owns: a
   * disagreement between the two would then read as "the app is broken" with no
   * way to find out why. Let it be pressed; let the database have the last word;
   * and make sure it is never a surprise.
   */
  const shortfall =
    !locked &&
    weekHasEnded &&
    scheduledWeek &&
    weekTotalMinutes > 0 &&
    weekTotalMinutes < scheduledWeek.minimumMinutes
      ? { ...scheduledWeek, minutes: scheduledWeek.minimumMinutes - weekTotalMinutes }
      : null;

  /*
   * The same figure on a week still being worked, said as progress rather than
   * as a shortfall.
   *
   * ⚠️ THE DATABASE APPLIES THE FULL WEEK'S MINIMUM TO THE CURRENT WEEK. It
   * refuses only a week in the FUTURE; the current one is checked in full, and
   * Friday afternoon is a perfectly normal time to hand a week in. Somebody who
   * never sees the target until they press the button meets it as a refusal.
   *
   * NEUTRAL, AND THAT IS THE ENTIRE DESIGN. No "short", no "cannot be handed
   * in", no `text-warning` — a person is mid-week and has done nothing wrong.
   * It states the target and where they are against it, and lets them draw the
   * conclusion, which is the difference between a bar people read and a nag they
   * learn to look past.
   *
   * `weekTotalMinutes > 0` mirrors the shortfall's own guard and is load-bearing
   * for a second reason here: the submit button is DISABLED at zero, so an empty
   * week cannot be refused and has no surprise to warn about. Its existing
   * sentence — "nothing to hand in" — is the more useful one.
   */
  const progress =
    !locked && !weekHasEnded && scheduledWeek && weekTotalMinutes > 0 ? scheduledWeek : null;

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

      <div className="min-w-0 flex-1 space-y-1">
        {/*
          ⚠️ TWO MESSAGES, NOT TWO BRANCHES OF ONE.

          "Here is why it came back" and "it is still short" answer different
          questions, and the person who needs both at once is exactly the one
          resubmitting a week that was sent back. This used to be the first arm
          of the ternary below — and `vizserve_pms_timesheet_weeks` has a
          constraint guaranteeing a RETURNED week carries a reason, so that arm
          ALWAYS won: the shortfall warning could not render on a returned week
          at all. The likeliest short week in the system was the one week that
          got the database's refusal instead of the warning.
        */}
        {returnedReason ? (
          <p className="text-sm text-foreground-muted">
            <span className="font-medium text-foreground">Sent back:</span> {returnedReason}
          </p>
        ) : null}

        {locked ? (
          <p className="text-sm text-foreground-muted">
            Locked — {formatCellDuration(weekTotalMinutes)} handed in
            {week?.submittedAt ? ` on ${formatDateTime(week.submittedAt)}` : null}. Ask your
            lead to send it back if something needs fixing.
          </p>
        ) : shortfall ? (
          /* THE LABEL CARRIES THE STATE, never the colour — the same rule every
             status in this app follows, and it matters more here than usual
             because this sentence is the only warning before a refusal. */
          <p className="text-sm text-warning">
            <span className="font-medium">
              {formatCellDuration(shortfall.minutes)} short of your schedule.
            </span>{" "}
            {formatCellDuration(weekTotalMinutes)} logged against{" "}
            {formatCellDuration(shortfall.minimumMinutes)} for the {shortfall.expectedDays}{" "}
            {shortfall.expectedDays === 1 ? "day" : "days"} you were due in. Log the missing time,
            or file leave for any day you were away — a short week cannot be handed in.
          </p>
        ) : progress ? (
          /* Muted, like the plain "N logged" line it replaces — the state here is
             "in progress", and there is no state to convey. The figure IS the
             message: a person who can see 28h against 40h needs no adjective. */
          <p className="text-sm text-foreground-muted">
            <span className="font-medium text-foreground">
              {formatCellDuration(weekTotalMinutes)} of{" "}
              {formatCellDuration(progress.minimumMinutes)} logged so far
            </span>{" "}
            — the {progress.expectedDays} {progress.expectedDays === 1 ? "day" : "days"} you are due
            in.
            {/* ⚠️ NOT AFTER A SEND-BACK. "Submitting locks the week" is the
                right nudge on a week nobody has looked at, and the wrong one
                under "Sent back: …" — that week has already been submitted and
                already been locked, and the person reading it is being told the
                mechanic they just experienced. The FIGURE still belongs here:
                somebody fixing a returned week is exactly who needs to know
                what it has to reach. */}
            {returnedReason ? null : " Submitting locks the week until your lead decides."}
          </p>
        ) : returnedReason ? (
          /* The reason above already says what this week needs; repeating "N
             logged, submitting locks the week" under it would bury it. */
          null
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
