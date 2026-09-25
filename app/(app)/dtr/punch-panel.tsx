"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { formatAppTime, formatDate, formatDuration, workedMinutes } from "@/lib/dates";
import {
  deviation as computeDeviation,
  effectiveEnd,
  type Deviation,
  type WorkSchedule,
} from "@/lib/dtr-schedule";
import { browserClient } from "@/lib/query/browser-client";
import { fetchPunchState } from "@/lib/query/fetchers/dtr";
import { invalidatePunch } from "@/lib/query/invalidate";
import { qk } from "@/lib/query/keys";
import { fromAction } from "@/lib/query/mutate";
import { OffScheduleDialog } from "./off-schedule-dialog";
import { punch } from "./actions";

/** The Server Action, as a promise TanStack can drive `onError` off. */
const capturePunch = fromAction(punch);

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
  viewerId,
  compact = false,
}: {
  /**
   * P12-23 — THE SERVER'S FIRST READ, AND NOW ONLY THAT.
   *
   * ⚠️ IT SEEDS `qk.punchState()` RATHER THAN BEING THE STATE. `/`, `/dashboard`
   * and `/dtr` all render this panel and all three still call `loadPunchState`
   * in their own RSC — which is Next's own SPA guidance applied to the one card
   * that is on three screens: start the read on the server so the first paint
   * has no client waterfall, and let the cache own everything after it. Those
   * three pages therefore did not change shape, and the clock reminder in the
   * app shell reads the same entry rather than a fourth copy of it.
   */
  initial: PunchState;
  /**
   * Whose punches these are, from `requireAuthContext()` on each of the three
   * pages that render this.
   *
   * ⚠️ IT NAMES WHAT A CACHE ENTRY HOLDS, IT DOES NOT AUTHORISE ANYTHING. The
   * `.eq("user_id", …)` it feeds NARROWS a policy result — the DTR policy is
   * owner-or-department-lead, so a lead reading their own panel would otherwise
   * get their whole team's rows back. No decision about what anybody may see is
   * made in this file.
   */
  viewerId: string;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();

  const [offSchedule, setOffSchedule] = useState<{
    deviation: Deviation;
    workDate: string;
    punchedAt: string;
  } | null>(null);

  /*
   * ⚠️ ONE ENTRY FOR THE WHOLE TAB, SHARED WITH THE CLOCK REMINDER IN THE SHELL.
   * P8-12 moved that reminder OUT of the layout because its six queries on every
   * authenticated page contributed to a request burst that failed with
   * `TypeError: fetch failed`. On this key it costs nothing at all on a page
   * that already draws this panel, and one read on the ones that do not.
   *
   * `initialData` rather than a fetch on mount: the server has already read this
   * for the first paint, milliseconds ago, so it counts as fetched NOW and the
   * ordinary 30s `staleTime` applies from here. `initialDataUpdatedAt: 0` would
   * mark it stale on arrival and refetch immediately, which is the seed doing no
   * work at all.
   */
  const punchQuery = useQuery({
    queryKey: qk.punchState(),
    queryFn: () => fetchPunchState(browserClient(), viewerId),
    initialData: initial,
  });

  /*
   * ⚠️ STILL NEVER PREDICTED, AND THAT IS THE ONE RULE OF THIS PANEL. There is
   * no `onMutate` below and there must not be: the panel shows what the server
   * already recorded, because a DTR that says "timed in" because a button was
   * pressed, while the server captured nothing, is worse than no shortcut at
   * all. `vizserve_pms_punch` owns earliest-in / latest-out, the
   * today-or-yesterday window and the 18-hour cut-off, and it can legitimately
   * IGNORE a press — `captured: false` — which no optimistic paint could
   * anticipate.
   *
   * What changed in P12-23 is only where the returned row goes: into the cache
   * instead of into local state, so the shell's clock reminder and the copy of
   * this panel on `/dashboard` see it too. That is what the fire-and-forget
   * refresh this replaces was trying to do.
   */
  /*
   * ⚠️ `?? initial` IS NOT BELT AND BRACES, IT IS A RACE THIS COMPONENT LOSES.
   *
   * `initialData` seeds a query only when the ENTRY DOES NOT EXIST YET, and the
   * clock reminder in `app/(app)/layout.tsx` observes this same key — the shell
   * renders above `children`, so on a hard load of `/dtr` the reminder builds
   * the query first, with no seed, and this component's `initialData` is then
   * ignored. TanStack still TYPES `data` as non-optional because the option was
   * passed, which is the dangerous half: without this fallback the first paint
   * of the panel would read `state.today` off `undefined`.
   *
   * The fallback is also the right answer rather than merely a safe one — it is
   * the server's own read of this exact record, taken moments ago, which is what
   * the seed was carrying anyway.
   */
  const state = punchQuery.data ?? initial;

  const timeIn = state.today?.time_in ?? null;
  const timeOut = state.today?.time_out ?? null;

  const scheduledEnd = effectiveEnd(state.schedule.workEnd, state.approvedOvertimeMinutes);

  const capture = useMutation({
    mutationFn: (vars: { direction: "in" | "out"; workDate?: string }) =>
      capturePunch(
        vars.direction === "in"
          ? { direction: "in" }
          : { direction: "out", work_date: vars.workDate ?? null },
      ),

    onError: (error) => toast.error(error.message),

    onSuccess: (punched, vars) => {
      // `captured: false` means the punch was deliberately ignored — a second
      // time-in. Said out loud, because silence looks like a broken button and
      // the next thing someone does is press it again.
      if (punched.captured) toast.success(punched.message);
      else toast.info(punched.message);

      /*
       * The SERVER'S row, written into the cache. The same arithmetic as the
       * `setState` this replaces: a punch that closed YESTERDAY leaves today
       * untouched and clears the open-yesterday offer.
       */
      queryClient.setQueryData(qk.punchState(), (previous: PunchState | undefined) => {
        const base = previous ?? state;
        return punched.work_date === base.today?.work_date || !base.today
          ? {
              ...base,
              today: {
                work_date: punched.work_date,
                time_in: punched.time_in,
                time_out: punched.time_out,
              },
            }
          : { ...base, today: base.today, openYesterday: null };
      });

      /*
       * ⚠️ ONLY ON A PUNCH THAT WAS ACTUALLY CAPTURED, and only for today.
       *
       * ⚠️ THIS GUARD WAS DEAD CODE UNTIL P12-23, AND THE COMMENT BELOW HAS BEEN
       * DESCRIBING BEHAVIOUR THE CODE DID NOT HAVE. It read
       * `if (punched.captured) if (!punched.captured) return;` — an outer `if`
       * whose entire body was an inner `if` that could never be true — so the
       * lines after it ran on every punch, an ignored one included. Pressing
       * Time in twice therefore prompted about the punch made hours earlier,
       * which is exactly what this says must not happen.
       *
       * `captured: false` means the server kept an earlier time-in and ignored
       * this press — judging the value it kept would prompt about a punch made
       * hours ago every time somebody pressed the button twice.
       *
       * Closing YESTERDAY is skipped too: `approvedOvertimeMinutes` was loaded
       * for today, so a yesterday deviation would be measured against the wrong
       * end time. That day still offers the correction link in the DTR table,
       * which is the quieter surface and the right one for a shift somebody is
       * only now getting round to closing.
       */
      if (!punched.captured) return;
      if (punched.work_date !== state.today?.work_date) return;

      const punchedAt = vars.direction === "in" ? punched.time_in : punched.time_out;
      const target = vars.direction === "in" ? state.schedule.workStart : scheduledEnd;
      const found = computeDeviation(vars.direction, punchedAt, target, state.graceMinutes);

      if (found && punchedAt) {
        setOffSchedule({ deviation: found, workDate: punched.work_date, punchedAt });
      }
    },

    /*
     * ⚠️ FIRED, NEVER AWAITED, AND AFTER THE DIALOG HAS ALREADY BEEN DECIDED.
     * The off-schedule prompt has to open on the punch that just happened, not
     * after a network round trip — which is what the fire-and-forget note this
     * replaces was protecting. `invalidatePunch` re-reads this key and the DTR
     * list; it deliberately leaves `qk.reminderSetup()` alone, because a punch
     * changes neither a preference nor a signed sound URL.
     */
    onSettled: () => invalidatePunch(queryClient),
  });

  const pending = capture.isPending;

  function run(direction: "in" | "out", workDate?: string) {
    capture.mutate({ direction, workDate });
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
      {/* ⚠️ A FORM ACTION, BUT STILL NOT OPTIMISTIC. The punch goes through a
          real form so React owns the transition and the button works before
          this route's JavaScript has loaded — which on a clock-in screen is
          worth having. What has NOT changed is the panel showing only what the
          server recorded: a DTR that says "timed in" because a button was
          pressed, while the server captured nothing, is worse than a slow one.
          The form is about how the action is invoked, not about predicting it. */}
      <form action={() => run(timeIn ? "out" : "in")}>
        {!timeIn ? (
          <Button type="submit" className="w-full" loading={pending}>
            Time in
          </Button>
        ) : (
          <Button type="submit" className="w-full" variant="outline" loading={pending}>
            {timeOut ? "Update time out" : "Time out"}
          </Button>
        )}
      </form>

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
          <form action={() => run("out", state.openYesterday!.work_date)}>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="mt-2 bg-background"
              loading={pending}
            >
              Time out for {formatDate(state.openYesterday.work_date)}
            </Button>
          </form>
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
