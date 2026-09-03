"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { formatAppTime, formatDate, formatDuration, workedMinutes } from "@/lib/dates";
import {
  deviation as computeDeviation,
  effectiveEnd,
  type Deviation,
  type WorkSchedule,
} from "@/lib/dtr-schedule";
import { OffScheduleDialog } from "./off-schedule-dialog";
import { punch } from "./actions";

export type PunchState = {
  today: { work_date: string; time_in: string | null; time_out: string | null } | null;
  /** Yesterday, only when it has a time-in and no time-out. */
  openYesterday: { work_date: string; time_in: string } | null;
  /** P7-36. Both fields null when this person works no fixed hours. */
  schedule: WorkSchedule;
  /** P7-37. The company-wide tolerance, in minutes. */
  graceMinutes: number;
  /** P7-04. Overtime already approved for TODAY, which extends the day's end. */
  approvedOvertimeMinutes: number;
  /**
   * P8-12. Is today a day this person is expected to work — a weekday, not a
   * proclaimed holiday, and not covered by their own approved leave?
   *
   * READ ONLY BY THE CLOCK REMINDER, never by this panel. The buttons stay
   * exactly as available on a Sunday as on a Tuesday: somebody who comes in on
   * a weekend must be able to record it, and the DTR has always let them. This
   * decides whether to NAG about a punch, which is a different question from
   * whether to accept one.
   */
  isWorkingDay: boolean;
};

/**
 * P5-03 — the dashboard time in/out shortcut, and the header of the DTR page.
 *
 * Amier asked for this explicitly (16:30, "May in and out sa dashboard
 * shortcut"). It is one control that changes with state rather than two buttons
 * where one is always wrong.
 *
 * The panel shows what the server already recorded and never predicts it: after
 * a punch the returned row replaces local state. A DTR that says "timed in"
 * because a button was pressed, while the server captured nothing, is worse than
 * no shortcut at all.
 *
 * P7-40 adds the one judgement it makes: whether what the server recorded is
 * where the schedule said it should be. That judgement runs on the RETURNED row,
 * never on the button press, for the same reason — a prompt about a punch that
 * was not captured would be a prompt about nothing.
 */
export function PunchPanel({
  initial,
  compact = false,
}: {
  initial: PunchState;
  compact?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [offSchedule, setOffSchedule] = useState<{
    deviation: Deviation;
    workDate: string;
    punchedAt: string;
  } | null>(null);

  const timeIn = state.today?.time_in ?? null;
  const timeOut = state.today?.time_out ?? null;

  const scheduledEnd = effectiveEnd(state.schedule.workEnd, state.approvedOvertimeMinutes);

  function run(direction: "in" | "out", workDate?: string) {
    startTransition(async () => {
      const result = await punch(
        direction === "in"
          ? { direction: "in" }
          : { direction: "out", work_date: workDate ?? null },
      );

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      const punched = result.data;

      // `captured: false` means the punch was deliberately ignored — a second
      // time-in. Said out loud, because silence looks like a broken button and
      // the next thing someone does is press it again.
      if (punched.captured) toast.success(punched.message);
      else toast.info(punched.message);

      setState((previous) =>
        punched.work_date === previous.today?.work_date || !previous.today
          ? {
              ...previous,
              today: {
                work_date: punched.work_date,
                time_in: punched.time_in,
                time_out: punched.time_out,
              },
            }
          : // The punch closed yesterday, so today is untouched and yesterday is
            // no longer open.
            { ...previous, today: previous.today, openYesterday: null },
      );

      /*
       * P8-12 — TELL THE SHELL, not just this panel.
       *
       * The local `setState` above is what keeps the button honest without a
       * round trip, and it stays. But since P8-12 the app shell holds its own
       * copy of "have they timed in yet", because that is what decides whether
       * the clock reminder fires — and the shell only re-renders on navigation.
       * Somebody who times in early at 08:40 and then sits on this page would
       * be reminded to clock in at 08:45, which is the exact false alarm that
       * gets a reminder switched off for good.
       *
       * Fire-and-forget, and NOT awaited: the off-schedule dialog below must
       * open on the punch that just happened, not after a network round trip.
       */
      if (punched.captured) router.refresh();

      // ⚠️ ONLY ON A PUNCH THAT WAS ACTUALLY CAPTURED, and only for today.
      //
      // `captured: false` means the server kept an earlier time-in and ignored
      // this press — judging the value it kept would prompt about a punch made
      // hours ago every time somebody pressed the button twice.
      //
      // Closing YESTERDAY is skipped too: approvedOvertimeMinutes was loaded for
      // today, so a yesterday deviation would be measured against the wrong end
      // time. That day still offers the correction link in the DTR table, which
      // is the quieter surface and the right one for a shift somebody is only
      // now getting round to closing.
      if (!punched.captured) return;
      if (punched.work_date !== initial.today?.work_date) return;

      const punchedAt = direction === "in" ? punched.time_in : punched.time_out;
      const target = direction === "in" ? state.schedule.workStart : scheduledEnd;
      const found = computeDeviation(direction, punchedAt, target, state.graceMinutes);

      if (found && punchedAt) {
        setOffSchedule({ deviation: found, workDate: punched.work_date, punchedAt });
      }
    });
  }

  const worked = workedMinutes(timeIn, timeOut);

  return (
    // p-3, matching the filter card and the summary directly beneath it in the
    // DTR rail. p-5 was the one padding in that column that lined up with
    // nothing, which is what made the rail read as three unrelated boxes.
    <div className={compact ? "" : "rounded-lg border bg-card grade-surface p-3 shadow-raised-lg"}>
      {!compact ? (
        <div className="mb-3">
          <h2 className="text-sm font-semibold">Today</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatDate(state.today?.work_date ?? null)}
          </p>
          {/* The schedule these punches are judged against, shown where they
              are. Somebody prompted about being six minutes late should be able
              to see what they were six minutes late FOR without opening another
              screen — and somebody with no schedule set should be able to tell
              that this is why they are never prompted. */}
          {state.schedule.workStart && state.schedule.workEnd ? (
            <p className="mt-0.5 text-2xs text-muted-foreground">
              Scheduled {state.schedule.workStart}–{state.schedule.workEnd}
              {state.approvedOvertimeMinutes > 0 && scheduledEnd
                ? ` · to ${scheduledEnd} with approved overtime`
                : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      <dl className="mb-3 grid grid-cols-3 gap-2">
        <div>
          <dt className="text-2xs tracking-wide text-muted-foreground uppercase">In</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatAppTime(timeIn)}</dd>
        </div>
        <div>
          <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Out</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatAppTime(timeOut)}</dd>
        </div>
        <div>
          <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Worked</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatDuration(worked)}</dd>
        </div>
      </dl>

      {/* One control, not two. Which action is available is a fact about the
          record, so showing both and disabling one just invites the question. */}
      {!timeIn ? (
        <Button className="w-full" loading={pending} onClick={() => run("in")}>
          Time in
        </Button>
      ) : (
        <Button className="w-full" variant="outline" loading={pending} onClick={() => run("out")}>
          {timeOut ? "Update time out" : "Time out"}
        </Button>
      )}

      {/* Q4's narrow backdating window, surfaced only when it actually applies.
          A date picker that is usually pointless is a date picker people learn
          to ignore — and this one exists for exactly one situation: an OT shift
          that ran past midnight. */}
      {state.openYesterday ? (
        <div className="mt-4 rounded-sm border border-warning/40 bg-warning-subtle p-3">
          <p className="text-xs font-medium text-foreground">
            {formatDate(state.openYesterday.work_date)} is still open
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            You timed in at {formatAppTime(state.openYesterday.time_in)} and never timed out. If
            that shift ran past midnight, close it against yesterday.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 bg-background"
            loading={pending}
            onClick={() => run("out", state.openYesterday!.work_date)}
          >
            Time out for {formatDate(state.openYesterday.work_date)}
          </Button>
        </div>
      ) : null}

      <OffScheduleDialog
        deviation={offSchedule?.deviation ?? null}
        workDate={offSchedule?.workDate ?? ""}
        punchedAt={offSchedule?.punchedAt ?? ""}
        onDismiss={() => setOffSchedule(null)}
      />
    </div>
  );
}
