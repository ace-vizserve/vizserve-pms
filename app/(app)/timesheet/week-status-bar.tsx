"use client";

import { useState, useTransition } from "react";
import { Send, Undo2 } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/dates";
import {
  TIMESHEET_WEEK_LABELS,
  type TimesheetWeekStatus,
  formatCellDuration,
  isWeekLocked,
} from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { submitTimesheetWeek, withdrawTimesheetWeek } from "./actions";

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
 *
 * P7-05b — a SUBMITTED week the lead has not decided yet can be cancelled by
 * its owner to revise it. That deletes the row, so the week is a draft again.
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
   * ⚠️ IT CHOOSES WHICH SENTENCE IS SAID, AND NEVER WHETHER ONE IS. On the
   * current week the minimum covers all five working days, so somebody with 8h
   * logged on Tuesday would be told they were "32h short" every day of every
   * week. So:
   *
   *   ended    → the warning. Short, and what to do about it.
   *   current  → a neutral progress line. The target, and how far along it is.
   *              Muted, not `text-warning`, and it accuses nobody of anything.
   *
   * It does NOT decide whether the short-week confirmation appears — submitting
   * on Thursday with 32h logged is just as short as submitting it next Monday.
   *
   * Decided on the server, not from a clock here: this is a client component,
   * and a browser in another timezone deciding whether a Manila week is over
   * would disagree with the row the server rendered.
   */
  weekHasEnded?: boolean;
}) {
  const [pending, start] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const status = week?.status ?? null;
  const locked = isWeekLocked(status);

  /* A returned week and the reason it came back travel together — the table's
     own constraint guarantees the reason is present — which is exactly why this
     must not be the thing that decides whether anything ELSE gets said. */
  const returnedReason = status === "RETURNED" ? (week?.decisionReason ?? null) : null;

  /*
   * P8-05b — how far below the scheduled week this is, finished or not.
   *
   * A short week is no longer refused by `vizserve_pms_submit_timesheet_week`.
   * The person decides, and this figure is what the confirmation shows them
   * before the week goes to their lead.
   */
  const short =
    !locked &&
    scheduledWeek &&
    weekTotalMinutes > 0 &&
    weekTotalMinutes < scheduledWeek.minimumMinutes
      ? { ...scheduledWeek, minutes: scheduledWeek.minimumMinutes - weekTotalMinutes }
      : null;

  /*
   * The shortfall, said BEFORE the button is pressed — on a finished week only.
   * See `weekHasEnded` for why the current week gets a progress line instead.
   */
  const shortfall = weekHasEnded ? short : null;

  /*
   * The same figure on a week still being worked, said as progress rather than
   * as a shortfall.
   *
   * NEUTRAL, AND THAT IS THE ENTIRE DESIGN. No "short", no `text-warning` — a
   * person is mid-week and has done nothing wrong. It states the target and
   * where they are against it, and lets them draw the conclusion, which is the
   * difference between a bar people read and a nag they learn to look past.
   *
   * `weekTotalMinutes > 0` mirrors the shortfall's own guard: the submit button
   * is DISABLED at zero, and its existing sentence — "nothing to hand in" — is
   * the more useful one.
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

  function send() {
    setConfirmOpen(false);
    start(async () => {
      const result = await submitTimesheetWeek({ week_start: weekStart });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Week sent to your department lead.");
    });
  }

  function submit() {
    if (short) {
      setConfirmOpen(true);
      return;
    }
    send();
  }

  /* No confirmation: nothing is lost — the hours stay exactly as logged and
     the week can be submitted again straight away. */
  function cancelSubmission() {
    start(async () => {
      const result = await withdrawTimesheetWeek({ week_start: weekStart });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Submission cancelled. Edit the week and submit it again when it is ready.");
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
          resubmitting a week that was sent back. `vizserve_pms_timesheet_weeks`
          guarantees a RETURNED week carries a reason, so if this were the first
          arm of the ternary below the shortfall could never render on a
          returned week — the likeliest short week in the system.
        */}
        {returnedReason ? (
          <p className="text-sm text-foreground-muted">
            <span className="font-medium text-foreground">Sent back:</span> {returnedReason}
          </p>
        ) : null}

        {status === "SUBMITTED" ? (
          <p className="text-sm text-foreground-muted">
            Locked — {formatCellDuration(weekTotalMinutes)} handed in
            {week?.submittedAt ? ` on ${formatDateTime(week.submittedAt)}` : null}. Waiting on
            your lead. Need to change something? Cancel the submission to edit it.
          </p>
        ) : locked ? (
          <p className="text-sm text-foreground-muted">
            Locked — {formatCellDuration(weekTotalMinutes)} handed in
            {week?.submittedAt ? ` on ${formatDateTime(week.submittedAt)}` : null}. Ask your
            lead to send it back if something needs fixing.
          </p>
        ) : shortfall ? (
          /* THE LABEL CARRIES THE STATE, never the colour — the same rule every
             status in this app follows. */
          <p className="text-sm text-warning">
            <span className="font-medium">
              {formatCellDuration(shortfall.minutes)} short of your schedule.
            </span>{" "}
            {formatCellDuration(weekTotalMinutes)} logged against{" "}
            {formatCellDuration(shortfall.minimumMinutes)} for the {shortfall.expectedDays}{" "}
            {shortfall.expectedDays === 1 ? "day" : "days"} you were due in. If you were on leave
            or had an emergency, let your team leader know.
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
                already been locked. The FIGURE still belongs here: somebody
                fixing a returned week is exactly who needs to know what it has
                to reach. */}
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

      {/* SUBMITTED → cancel it to revise (P7-05b). APPROVED → nothing: reopening
          a signed week is the lead's call, and a greyed button would only
          invite the question. Anything else → submit. */}
      {status === "SUBMITTED" ? (
        <Button variant="outline" onClick={cancelSubmission} loading={pending}>
          <Undo2 />
          Cancel submission
        </Button>
      ) : locked ? null : (
        <Button onClick={submit} loading={pending} disabled={weekTotalMinutes <= 0}>
          <Send />
          {status === "RETURNED" ? "Resubmit week" : "Submit for approval"}
        </Button>
      )}

      {/* P8-05b — the short week is confirmed, not refused. */}
      {short ? (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Submit a short week?</DialogTitle>
              <DialogDescription>
                You logged {formatCellDuration(weekTotalMinutes)} of the{" "}
                {formatCellDuration(short.minimumMinutes)} expected this week —{" "}
                {formatCellDuration(short.minutes)} short. Your team leader will see that this week
                is short of your working hours.
              </DialogDescription>
            </DialogHeader>

            <p className="text-sm text-foreground-muted">
              If you were on leave or had an emergency, please let your team leader know.
            </p>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                Go back
              </Button>
              <Button onClick={send}>
                <Send />
                Submit anyway
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
