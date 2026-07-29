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
