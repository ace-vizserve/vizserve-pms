/**
 * P8-12 — is a clock reminder due right now?
 *
 * The sibling of `lib/dtr-schedule.ts`, and deliberately built the same way.
 * That file answers "was this punch where the schedule said it should be" AFTER
 * the fact; this one answers "is the schedule about to expect a punch" BEFORE
 * it. Same inputs, same wall-clock arithmetic, opposite direction in time.
 *
 * PURE, AND DELIBERATELY NOT SERVER-ONLY. It takes everything as arguments and
 * reads nothing — no clock, no client, no DOM. The component that calls it runs
 * a timer in the browser; the tests call it with a fixed `nowClock` and no
 * timer at all, which is the only reason a reminder that fires at 08:45 is
 * testable without waiting until 08:45.
 *
 * ⚠️ THE TIMEZONE TRAP IS THE CALLER'S TO AVOID, exactly as in
 * `lib/dtr-schedule.ts`. `nowClock` must be an `HH:MM` string already brought
 * into Manila by `formatAppTime` — `new Date().getHours()` is the browser's zone
 * and is right only for somebody physically in Manila. Everything below is
 * integer arithmetic on minutes since midnight, with no zone left in it.
 *
 * ⚠️ IT WRITES NOTHING AND SENDS NOTHING. There is no notification row, no enum
 * value, no email, and no record that a reminder fired or was ignored. That
 * follows the position `app/(app)/dtr/off-schedule-dialog.tsx` states outright
 * — "DISMISSAL IS NOT RECORDED, on purpose" — and it keeps this off the email
 * budget docs/12 §3 spends deliberately. A nudge in a tab that is already open
 * is a different thing from a notification, and the moment it becomes durable
 * it needs an inbox row, a type and a preference per type.
 */

/** The reminder that is due, or nothing. `minutesAway` is always ≥ 1. */
export type DueReminder = {
  side: "in" | "out";
  /** The `HH:MM` the schedule expects, after any approved overtime. */
  scheduled: string;
  /** Whole minutes from now until `scheduled`. */
  minutesAway: number;
};

export type ReminderInput = {
  /** `HH:MM` in app time. Produced by `formatAppTime`, never by `getHours()`. */
  nowClock: string;
  /** `HH:MM`, or null when this person works no fixed hours. */
  workStart: string | null;
  /** `HH:MM`. THE CALLER PUTS THIS THROUGH `effectiveEnd()` FIRST — see below. */
  workEnd: string | null;
  /** Today's punches. Null means not yet. */
  timeIn: string | null;
  timeOut: string | null;
  leadMinutes: number;
  clockIn: boolean;
  clockOut: boolean;
  /**
   * Is today a day this person is expected to work at all?
   *
   * Weekend, public holiday and approved leave all make this false. Resolved on
   * the server from `vizserve_pms_is_working_day` and the person's approved
   * LEAVE, because none of those are knowable in the browser — and because
   * reminding somebody to clock in on Christmas is the fastest way to get the
   * whole feature switched off.
   */
  working: boolean;
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `HH:MM` → minutes since midnight. Null for anything that is not a clock time,
 * including the `HH:MM:SS` Postgres hands back for a `time` column.
 *
 * The same helper `lib/dtr-schedule.ts` keeps privately. Duplicated rather than
 * exported across the two files on purpose: they are four lines, and a shared
 * clock-parsing module that both import is a dependency in the wrong direction
 * — `dtr-schedule` is the older, load-bearing one and should not gain an import
 * because a newer file wanted a helper.
 */
function clockMinutes(value: string): number | null {
  const trimmed = value.slice(0, 5);
  if (!CLOCK.test(trimmed)) return null;

  const [h = 0, m = 0] = trimmed.split(":").map(Number);
  return h * 60 + m;
}

/**
 * The reminder that is due now, or null.
 *
 * NULL MEANS "SAY NOTHING", never "unknown" — the same contract `deviation()`
 * has, and for the same reason: every case where we are not certain a reminder
 * is wanted is a case where silence is correct.
 *
 * The rules, in the order they are checked:
 *
 *   1. A day nobody is expected to work is silent, whatever the schedule says.
 *   2. No schedule recorded means no reminder, ever. A null `work_start` is a
 *      supported state (P7-36) meaning "this person works no fixed hours", and
 *      the DTR already says nothing about their punches.
 *   3. THE TIME-OUT REMINDER IS CHECKED FIRST. The two windows cannot overlap
 *      in any sane schedule, but somebody who never timed out yesterday and is
 *      being reminded about today would otherwise be told to clock IN while
 *      the app also believes they are still clocked in from this morning.
 *      Asking about the shift in progress is the more useful of the two.
 *   4. Time-in fires in `[workStart − lead, workStart)` when nothing is timed
 *      in. It is a half-open window and the exclusive end is deliberate: at
 *      `workStart` exactly, the moment to remind somebody has passed, and what
 *      they need then is the lateness prompt the DTR already gives them.
 *   5. Time-out fires in `[workEnd − lead, workEnd)` when timed in and not out.
 *
 * ⚠️ `workEnd` MUST ALREADY HAVE BEEN THROUGH `effectiveEnd()`. Approved
 * overtime extends the day, and reminding somebody to clock out at 17:00 on an
 * evening their lead approved two extra hours for is nagging them about doing
 * exactly what they were authorised to do — the same mistake `effectiveEnd`
 * exists to stop the deviation check making.
 */
export function dueReminder(input: ReminderInput): DueReminder | null {
  if (!input.working) return null;

  const now = clockMinutes(input.nowClock);
  if (now === null) return null;

  // A lead time outside the legal range is a corrupt read, not an instruction.
  // Falling back would invent a policy; refusing to fire says nothing, which is
  // the safe half of a feature nobody has to be told about.
  const lead = Math.trunc(input.leadMinutes);
  if (!Number.isFinite(lead) || lead < 1) return null;

  // Rule 3 — the shift in progress wins.
  if (input.clockOut && input.workEnd && input.timeIn && !input.timeOut) {
    const end = clockMinutes(input.workEnd);
    if (end !== null && now >= end - lead && now < end) {
      return { side: "out", scheduled: input.workEnd.slice(0, 5), minutesAway: end - now };
    }
  }

  if (input.clockIn && input.workStart && !input.timeIn) {
    const start = clockMinutes(input.workStart);
    if (start !== null && now >= start - lead && now < start) {
      return { side: "in", scheduled: input.workStart.slice(0, 5), minutesAway: start - now };
    }
  }

  return null;
}

/**
 * "Clock in at 09:00 — 15 minutes" / "Clock out at 18:00 — 5 minutes".
 *
 * Short enough for an OS notification title, and it names the TIME as well as
 * the countdown. A bare "15 minutes until you clock in" is unreadable on a
 * phone screen glanced at forty minutes later, when the number has stopped
 * being true but the notification is still sitting there.
 */
export function describeReminder(value: DueReminder): string {
  const unit = value.minutesAway === 1 ? "minute" : "minutes";
  const verb = value.side === "in" ? "Clock in" : "Clock out";

  return `${verb} at ${value.scheduled} — ${value.minutesAway} ${unit}`;
}

/**
 * The `localStorage` key that stops a reminder firing twice.
 *
 * Keyed on the PERSON, the WORK DATE and the SIDE — all three are load-bearing.
 * The date is what lets tomorrow's reminder fire after today's was seen; the
 * side is what lets the clock-out fire on a day the clock-in already did; and
 * the user id is what stops one reminder being swallowed because a colleague
 * signed in on the same browser earlier.
 *
 * ⚠️ THIS IS THE ONLY RECORD A REMINDER LEAVES, and it is per-browser and
 * per-device by design. Somebody with the app open on a laptop and a phone gets
 * reminded on both, which is right — they are two places the nudge might be
 * seen. Making it durable would mean a row, and a row means the durable
 * notification this deliberately is not.
 */
export function reminderSeenKey(userId: string, workDate: string, side: "in" | "out"): string {
  return `vizserve-reminder:${userId}:${workDate}:${side}`;
}
