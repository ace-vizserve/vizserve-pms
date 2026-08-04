"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { formatAppTime, formatDate, formatDuration, workedMinutes } from "@/lib/dates";
import { punch } from "./actions";

export type PunchState = {
  today: { work_date: string; time_in: string | null; time_out: string | null } | null;
  /** Yesterday, only when it has a time-in and no time-out. */
  openYesterday: { work_date: string; time_in: string } | null;
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
 */
export function PunchPanel({
  initial,
  compact = false,
}: {
  initial: PunchState;
  compact?: boolean;
}) {
  const [state, setState] = useState(initial);
  const [pending, startTransition] = useTransition();

  const timeIn = state.today?.time_in ?? null;
  const timeOut = state.today?.time_out ?? null;

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
              openYesterday: previous.openYesterday,
              today: {
                work_date: punched.work_date,
                time_in: punched.time_in,
                time_out: punched.time_out,
              },
            }
          : // The punch closed yesterday, so today is untouched and yesterday is
            // no longer open.
            { today: previous.today, openYesterday: null },
      );
    });
  }

  const worked = workedMinutes(timeIn, timeOut);

  return (
    <div className={compact ? "" : "rounded-xl bg-card p-5 ring-1 ring-foreground/10"}>
      {!compact ? (
        <div className="mb-4">
          <h2 className="text-sm font-semibold">Today</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatDate(state.today?.work_date ?? null)}
          </p>
        </div>
      ) : null}

      <dl className="mb-4 grid grid-cols-3 gap-3">
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
    </div>
  );
}
