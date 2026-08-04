/**
 * Date helpers.
 *
 * NO DATE LIBRARY. `dayjs`, `date-fns` and `moment` are banned by inherited
 * house rule (docs/11-stack-conventions.md) — everything lives here, with
 * `Intl` doing the heavy lifting.
 *
 * This file will need real extension before Phase 4 and Phase 5:
 *   - business-day arithmetic and a PH holiday calendar, if the 3-day
 *     auto-complete window becomes business days (Q6)
 *   - work-date normalisation for the DTR, including overnight OT crossing
 *     midnight (Q4, Q8)
 * Both are budgeted work, not an afternoon's import. Raise it rather than
 * quietly adding a dependency.
 */

/**
 * The business runs in Manila. Timestamps are stored as `timestamptz` (UTC) and
 * rendered here — never the other way round.
 *
 * This matters earlier than it looks: `target_date` and `due_date` are DATE
 * columns, so "is this overdue?" is a question about the local calendar day,
 * not about a UTC instant. Comparing a DATE against `new Date()` on a server in
 * another zone is how a request reads as overdue several hours early.
 */
export const APP_TIME_ZONE = "Asia/Manila";

/** `YYYY-MM-DD` for a given instant, in app time. */
export function toAppDateString(value: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which sorts and parses predictably.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

/** Today in app time, as `YYYY-MM-DD`. */
export function todayInAppZone(): string {
  return toAppDateString(new Date());
}

/**
 * Human date, e.g. "3 Aug 2026". Returns an em dash for null so tables do not
 * render the string "null".
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";

  const date = typeof value === "string" ? parseDateOnly(value) : value;
  if (!date || Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Human date and time, e.g. "3 Aug 2026, 14:05". */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";

  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Parses a bare `YYYY-MM-DD` as midday UTC rather than midnight.
 *
 * Midnight UTC lands on the previous calendar day in any negative offset and is
 * the classic off-by-one in date-only columns. Midday is far enough from both
 * boundaries that no real timezone shifts the day.
 */
export function parseDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
}

/** Whole days between two date-only strings — `to - from`. Negative if past. */
export function daysBetween(from: string, to: string): number | null {
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);
  if (!start || !end) return null;

  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Is this date-only value before today, in app time?
 *
 * Compared as calendar days rather than instants, so a request due today is not
 * overdue at 00:01 and is not still fine at 23:59 tomorrow.
 */
export function isOverdue(value: string | null | undefined): boolean {
  if (!value) return false;
  const days = daysBetween(todayInAppZone(), value);
  return days !== null && days < 0;
}

/** Adds calendar days to a `YYYY-MM-DD` string, returning the same format. */
export function addDays(value: string, days: number): string | null {
  const date = parseDateOnly(value);
  if (!date) return null;

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Business days (Phase 4, Q6)
// ---------------------------------------------------------------------------

/**
 * Philippine regular holidays, as a mirror of `vizserve_pms_holidays`.
 *
 * The DATABASE IS THE AUTHORITY — `vizserve_pms_add_business_days` computes the
 * deadline that actually governs auto-completion, and it reads the table. This
 * copy exists so a screen can say "closes on Thursday" without a round trip.
 *
 * Movable holidays (Eid, and any special non-working days) are proclaimed
 * annually and are not derivable, which is why this is a list rather than an
 * algorithm. When a new year is proclaimed, both this and the table need it —
 * `tests/db/client-approval.test.ts` asserts they agree, so forgetting one
 * fails a test rather than quietly closing tickets a day early.
 */
export const PH_HOLIDAYS: readonly string[] = [
  "2026-01-01",
  "2026-04-02",
  "2026-04-03",
  "2026-04-09",
  "2026-05-01",
  "2026-06-12",
  "2026-08-31",
  "2026-11-30",
  "2026-12-25",
  "2026-12-30",
];

const HOLIDAY_SET = new Set(PH_HOLIDAYS);

/** Is this a working day in Manila? Weekends and regular holidays are not. */
export function isBusinessDay(value: string): boolean {
  const date = parseDateOnly(value);
  if (!date) return false;

  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;

  return !HOLIDAY_SET.has(value);
}

/**
 * Adds business days to a `YYYY-MM-DD`, skipping weekends and holidays.
 *
 * Q6, decided the way docs/08 recommends. A ticket sent Friday 5pm
 * auto-completes Monday 5pm on calendar days, having given the client roughly
 * one working day — which is the version of this feature that produces the
 * angry phone call.
 *
 * Bounded rather than `while (true)`: a corrupted holiday table should not spin
 * a request handler forever. Six weeks of consecutive holidays does not happen,
 * so hitting the cap means something is wrong and returning null says so.
 */
export function addBusinessDays(value: string, days: number): string | null {
  let cursor = value;
  let added = 0;
  let guard = 0;

  while (added < days) {
    if (guard++ > 400) return null;

    const next = addDays(cursor, 1);
    if (!next) return null;
    cursor = next;

    if (isBusinessDay(cursor)) added += 1;
  }

  return cursor;
}

// ---------------------------------------------------------------------------
// Work dates (Phase 5, P5-12)
// ---------------------------------------------------------------------------

/**
 * The longest a shift may stay open before a time-out is refused.
 *
 * Q4's recommendation. An 18-hour-old punch-in is a forgotten clock-out, not a
 * shift — and accepting it silently writes a fake 18-hour day into payroll,
 * which is the expensive kind of wrong. The DTR rules make time-in
 * unoverwritable, so there is no way for the user to undo it afterwards either;
 * the correction has to go through a No Time-Out request.
 */
export const MAX_SHIFT_HOURS = 18;

/** Yesterday in app time, as `YYYY-MM-DD`. */
export function yesterdayInAppZone(): string {
  return addDays(todayInAppZone(), -1)!;
}

/** `HH:mm` in app time, e.g. "22:00". Em dash for null, like formatDate. */
export function formatAppTime(value: string | Date | null | undefined): string {
  if (!value) return "—";

  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Which `work_date` a time-out may attach to.
 *
 * Q4, as recommended in docs/09: today, or yesterday when yesterday's shift was
 * left open. That is the narrowest window that still serves Amier's worked
 * example — in 22:00 on Jul 22, out 01:00 on Jul 23, recorded against Jul 22 —
 * while refusing an arbitrary backdate to a favourable past date.
 *
 * Time-IN takes no date at all and is not served by this function: it always
 * attaches to today, which is what removes the backdating hole entirely.
 */
export function allowedTimeOutDates(hasOpenShiftYesterday: boolean): string[] {
  const today = todayInAppZone();
  return hasOpenShiftYesterday ? [today, yesterdayInAppZone()] : [today];
}

/**
 * Minutes worked between two instants. Null if either is missing.
 *
 * Deliberately instant arithmetic rather than clock arithmetic: a shift that
 * crosses midnight is a real duration, and subtracting wall-clock times would
 * return a negative number for exactly the overnight case the DTR exists to
 * handle.
 */
export function workedMinutes(
  timeIn: string | null | undefined,
  timeOut: string | null | undefined,
): number | null {
  if (!timeIn || !timeOut) return null;

  const start = new Date(timeIn).getTime();
  const end = new Date(timeOut).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  const minutes = Math.round((end - start) / 60_000);
  return minutes < 0 ? null : minutes;
}

/** "8h 15m", "45m", "—". For the DTR list and the payroll export. */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes < 0) return "—";

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/**
 * Decimal hours to two places — "8.25" — for the payroll export only.
 *
 * Payroll multiplies by a rate, and "8h 15m" does not multiply. Kept separate
 * from formatDuration so nobody renders a spreadsheet number into a UI where a
 * human is reading it.
 */
export function decimalHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes < 0) return "";
  return (minutes / 60).toFixed(2);
}

/**
 * "in 2 days", "tomorrow", "today", "3 days ago".
 *
 * For the approval email and the client page, where an absolute date alone
 * ("closes 7 Aug") makes a reader work out whether that is soon.
 */
export function relativeDays(target: string | null | undefined): string {
  if (!target) return "—";

  const days = daysBetween(todayInAppZone(), target);
  if (days === null) return "—";

  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}
