import { formatAppTime } from "@/lib/dates";

/**
 * P7-36/P7-40 — is this punch where the schedule says it should be?
 *
 * Everything "smart" about the DTR is this file. The migrations add a scheduled
 * start and end (P7-36) and a company grace period (P7-37); the request types
 * exist already (P7-38/39). What was missing was the arithmetic that turns a
 * recorded instant and a wall-clock schedule into "six minutes late", and the
 * one decision that follows from it: whether to offer a correction request.
 *
 * PURE, AND DELIBERATELY NOT SERVER-ONLY. The punch dialog runs in the browser
 * and the DTR table renders on the server, and both must reach the same verdict
 * about the same punch — so this cannot import a client, and it takes its inputs
 * as arguments rather than reading anything.
 *
 * ⚠️ THE TIMEZONE TRAP, which is the only real hazard here. `time_in` is a
 * `timestamptz`; `work_start` is a bare Manila wall-clock `time`. Comparing them
 * means bringing the instant into Manila FIRST, and the two obvious ways to do
 * that are both wrong:
 *
 *   new Date(timeIn).getHours()   the SERVER's zone — right on a laptop in
 *                                 Manila, eight hours out on Vercel
 *   new Date(timeIn).toISOString() UTC, so an 09:06 punch reads as 01:06 and
 *                                 every morning is four hundred minutes early
 *
 * `formatAppTime` already does it correctly, through Intl, in APP_TIME_ZONE, and
 * it is the only time-of-day formatter in the codebase for exactly this reason.
 * Everything below works on the `HH:MM` string it returns, which is then plain
 * integer arithmetic with no zone in it at all — the same posture
 * `lib/schemas/timesheet.ts` takes with `minutesBetween`.
 */

/** A person's scheduled day, or the absence of one. Both fields or neither. */
export type WorkSchedule = {
  /** `HH:MM`, Manila wall-clock. Null when no schedule is recorded. */
  workStart: string | null;
  workEnd: string | null;
};

/**
 * How far off schedule a punch landed, once grace is spent.
 *
 * `minutes` is SIGNED and the sign is the whole meaning: positive is later than
 * scheduled, negative is earlier. A time-in can only be reported late (arriving
 * early is not a problem anybody needs to file paperwork about); a time-out
 * deviates in both directions and reads differently for each.
 */
export type Deviation = {
  side: "in" | "out";
  /** Signed minutes from the scheduled time. Never within grace. */
  minutes: number;
  /** The `HH:MM` the schedule expected, after any approved overtime. */
  scheduled: string;
};

/** The default the migration seeds, restated so a caller with no row still works. */
export const DEFAULT_GRACE_MINUTES = 5;

/**
 * P8-05 — the unpaid break inside the scheduled day, company-wide.
 *
 * Mirrors `vizserve_pms_app_settings.break_minutes`' column default, restated
 * here for the same reason and with the same caveat as `DEFAULT_GRACE_MINUTES`:
 * a settings read that fails must degrade to a number rather than take out the
 * screen. If this and the column default ever drift, THE MIGRATION WINS and
 * this is the line to change.
 *
 * ⚠️ This is the COMPANY default, never a person's. A null
 * `vizserve_pms_users.break_minutes` means "inherit the company figure", and an
 * explicit 0 means "no break" — collapsing those two is exactly what the
 * migration refuses to do, and no caller here may do it either.
 */
export const DEFAULT_BREAK_MINUTES = 60;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `HH:MM` → minutes since midnight. Null for anything that is not a clock time,
 * including the `HH:MM:SS` Postgres hands back for a `time` column.
 */
function clockMinutes(value: string): number | null {
  const trimmed = value.slice(0, 5);
  if (!CLOCK.test(trimmed)) return null;

  const [h = 0, m = 0] = trimmed.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes since midnight → `HH:MM`. Clamped inside the day. */
function clockString(minutes: number): string {
  const bounded = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${String(Math.floor(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}

/**
 * Normalise whatever the database handed back into a schedule.
 *
 * Postgres returns a `time` column as `HH:MM:SS`, so the raw value is never the
 * `HH:MM` the rest of this file works in. Half a schedule — which the CHECK
 * constraint refuses, but a hand-edited row or a stale cache could still produce
 * — is treated as NO schedule rather than as an error: the correct response to
 * "we do not know when this person starts" is to say nothing about their punches.
 */
export function scheduleFor(source: {
  work_start?: string | null;
  work_end?: string | null;
}): WorkSchedule {
  const start = source.work_start ? clockMinutes(source.work_start) : null;
  const end = source.work_end ? clockMinutes(source.work_end) : null;

  if (start === null || end === null) return { workStart: null, workEnd: null };
  return { workStart: clockString(start), workEnd: clockString(end) };
}

/**
 * P8-05 — how many minutes a scheduled day is actually worth.
 *
 * ⚠️ THE SPAN IS NOT THE ANSWER, which is the trap P7-36's column comment left
 * a warning about: `work_end - work_start` INCLUDES the unpaid break, so
 * 08:00-17:00 is a nine-hour span describing an eight-hour day. Every caller
 * that wants "hours short of schedule" wants this function and not that
 * subtraction.
 *
 * NULL MEANS "DO NOT JUDGE THIS PERSON", and there are two ways to reach it —
 * no schedule recorded, and a schedule whose break swallows it. Both are cases
 * where the honest answer is silence: the first because nobody set the hours,
 * the second because the hours that were set are broken, and a broken record
 * must never become a demand made of the person it describes. This mirrors the
 * first two exemptions in `vizserve_pms_submit_timesheet_week` exactly, so the
 * screen and the database agree about who is exempt.
 *
 * `breakMinutes` is the RESOLVED figure — the person's own if they have one,
 * the company's otherwise. Resolving it is the caller's job because only the
 * caller can see both rows, and because `null ?? company` and `0 ?? company`
 * must give different answers.
 */
export function scheduledDayMinutes(
  source: { work_start?: string | null; work_end?: string | null },
  breakMinutes: number = DEFAULT_BREAK_MINUTES,
): number | null {
  const { workStart, workEnd } = scheduleFor(source);
  if (!workStart || !workEnd) return null;

  const start = clockMinutes(workStart);
  const end = clockMinutes(workEnd);
  if (start === null || end === null) return null;

  const rest = Number.isFinite(breakMinutes) ? Math.max(0, breakMinutes) : DEFAULT_BREAK_MINUTES;
  const worked = end - start - rest;

  return worked > 0 ? worked : null;
}

/**
 * The end of the day a person is actually expected to work, given overtime that
 * has already been approved for it.
 *
 * ⚠️ THIS IS WHY APPROVED OVERTIME BELONGS IN THE DTR. Without it, doing exactly
 * what you were authorised to do — staying two hours late on a day your lead
 * approved — is flagged as a deviation, and the DTR asks you to file a
 * correction request for the overtime you already filed a request for. The
 * nudge would be wrong precisely for the people who followed the process.
 *
 * It extends the END only. Approved overtime never moves a start time, so it
 * cannot be used to excuse arriving late.
 */
export function effectiveEnd(workEnd: string | null, approvedOvertimeMinutes = 0): string | null {
  if (!workEnd) return null;

  const base = clockMinutes(workEnd);
  if (base === null) return null;
  if (!Number.isFinite(approvedOvertimeMinutes) || approvedOvertimeMinutes <= 0) return workEnd;

  return clockString(base + approvedOvertimeMinutes);
}

/**
 * Did this punch land off schedule?
 *
 * Returns null — meaning "nothing to say" — for every case where silence is the
 * right answer: no schedule recorded, no punch, an unparseable value, or a
 * deviation inside grace. Callers should read null as "this is fine", never as
 * "unknown".
 *
 * GRACE APPLIES AT BOTH ENDS AND IN BOTH DIRECTIONS. A grace period that
 * forgives arriving five minutes late but not leaving five minutes early is two
 * policies wearing one name, and nobody in the company could tell you which was
 * in force. The comparison is strictly greater-than, so a grace of 5 forgives
 * exactly five minutes and flags the sixth; a grace of 0 means exact.
 *
 * A TIME-IN EARLIER THAN SCHEDULED IS NOT A DEVIATION. Arriving at 08:40 for a
 * 09:00 start needs no approval and no paperwork — the record is not wrong, the
 * person was simply early. Only lateness is reportable at the start of the day.
 */
export function deviation(
  side: "in" | "out",
  punchedAt: string | null | undefined,
  scheduled: string | null,
  graceMinutes: number = DEFAULT_GRACE_MINUTES,
): Deviation | null {
  if (!punchedAt || !scheduled) return null;

  const target = clockMinutes(scheduled);
  if (target === null) return null;

  // The one line that must go through formatAppTime. See the header.
  const actual = clockMinutes(formatAppTime(punchedAt));
  if (actual === null) return null;

  const grace = Number.isFinite(graceMinutes) ? Math.max(0, graceMinutes) : DEFAULT_GRACE_MINUTES;
  const minutes = actual - target;

  if (side === "in" && minutes <= 0) return null;
  if (Math.abs(minutes) <= grace) return null;

  return { side, minutes, scheduled };
}

/**
 * Which request type fixes this deviation — the only mapping there is.
 *
 * Both time-out directions map to TIME_OUT_CORRECTION. Clocking out after the
 * scheduled end is NOT routed to an overtime request: overtime is agreed in
 * advance (P7-04), and a DTR that turned a forgotten clock-out into an overtime
 * claim would be manufacturing entitlement out of forgetfulness. Where overtime
 * WAS agreed, `effectiveEnd` has already moved the target and there is no
 * deviation to map.
 */
export function correctionTypeFor(side: "in" | "out"): "TIME_IN_CORRECTION" | "TIME_OUT_CORRECTION" {
  return side === "in" ? "TIME_IN_CORRECTION" : "TIME_OUT_CORRECTION";
}

/**
 * "Late in · 6m" / "Out early · 20m" / "Out late · 45m".
 *
 * Short enough to sit under a time in a numeric column. THE LABEL CARRIES THE
 * STATE, never the colour — the same rule every status pill in this app follows.
 */
export function describeDeviation(value: Deviation): string {
  const size = Math.abs(value.minutes);
  const amount = size >= 60 ? `${Math.floor(size / 60)}h ${size % 60}m`.replace(" 0m", "") : `${size}m`;

  if (value.side === "in") return `Late in · ${amount}`;
  return value.minutes > 0 ? `Out late · ${amount}` : `Out early · ${amount}`;
}

/**
 * The sentence the dialog opens with — "You timed in at 09:06, 6 minutes after
 * your 09:00 start."
 *
 * Written out in full rather than assembled in the component because the same
 * words have to survive being read by somebody who is about to sign a statement
 * about their own attendance. Vague there is worse than verbose.
 */
export function describeDeviationLong(value: Deviation, punchedAt: string): string {
  const at = formatAppTime(punchedAt);
  const size = Math.abs(value.minutes);
  const unit = size === 1 ? "minute" : "minutes";

  if (value.side === "in") {
    return `You timed in at ${at}, ${size} ${unit} after your ${value.scheduled} start.`;
  }

  return value.minutes > 0
    ? `You timed out at ${at}, ${size} ${unit} after your ${value.scheduled} finish.`
    : `You timed out at ${at}, ${size} ${unit} before your ${value.scheduled} finish.`;
}
