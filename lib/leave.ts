/**
 * Approved leave, expanded from spans into the days it actually covers.
 *
 * WHY THIS EXISTS — the DTR had no idea leave was a thing.
 *
 * `vizserve_pms_dtr_entries` only ever holds a row for a day somebody PUNCHED.
 * A day off has no row, so on the DTR list it is an invisible gap and in the
 * payroll CSV it is simply absent — indistinguishable from a day the person was
 * rostered and did not turn up. Approving leave writes nothing into the DTR (by
 * design: it is not a time somebody was at work), so the join has to happen at
 * read time, and this is the arithmetic that join needs.
 *
 * NOT `vizserve_pms_leave_calendar`. That function is SECURITY DEFINER and
 * returns EVERY active user's approved leave, because it backs an out-of-office
 * widget where that is the point. The DTR is scoped: a lead sees their
 * departments, a member sees themselves. Reading the calendar here would put
 * people outside the caller's scope into a payroll export, so the callers query
 * `vizserve_pms_internal_requests` through its ordinary policy
 * (`requester_id = auth.uid() or vizserve_pms_manages_department(...)`) — the
 * same shape as the DTR's own policy — and hand the rows to this module.
 *
 * That also means the halves come along, which the calendar deliberately does
 * not return. P7-16 was right that a shared out-of-office calendar has no
 * business claiming "available until midday". Payroll is the opposite case: a
 * half day is exactly the fact being counted, and dropping it here would make
 * the CSV overstate every half day as a whole one.
 */

import { addDays } from "@/lib/dates";

/** Mirrors `vizserve_pms_day_half`. MORNING before AFTERNOON, as declared. */
export type DayHalf = "MORNING" | "AFTERNOON";

/** One approved LEAVE row, as the callers select it. */
export type LeaveSpan = {
  user_id: string;
  start_date: string;
  end_date: string;
  /** Null on rows that predate P7-16. Treated as a whole day. */
  start_half: DayHalf | null;
  end_half: DayHalf | null;
  /** Null on rows that predate P7-12. */
  type_name: string | null;
};

/** How much of one day the leave covers. */
export type LeavePortion = "full" | "morning" | "afternoon";

export type LeaveDay = {
  portion: LeavePortion;
  /** Distinct type names covering this day, joined. Empty when none is known. */
  typeNames: string[];
};

export const LEAVE_PORTION_LABELS: Record<LeavePortion, string> = {
  full: "Full day",
  morning: "Morning",
  afternoon: "Afternoon",
};

/**
 * Which part of `date` a span covers.
 *
 * Read straight off the column comments in P7-16:
 *
 *   start_half  MORNING   = the whole of that day
 *               AFTERNOON = from midday
 *   end_half    AFTERNOON = the whole of that day
 *               MORNING   = until midday
 *
 * A middle day is always whole, whatever the halves say about the ends. The two
 * conditions cannot both hold: on a multi-day span they are different dates, and
 * on a single day `start_half > end_half` is refused by
 * `vizserve_pms_internal_requests_shape`.
 */
function portionOn(date: string, span: LeaveSpan): LeavePortion {
  const startsHere = date === span.start_date;
  const endsHere = date === span.end_date;

  if (startsHere && span.start_half === "AFTERNOON") return "afternoon";
  if (endsHere && span.end_half === "MORNING") return "morning";
  return "full";
}

/** Two halves of one day, from two separate requests, are a whole day off. */
function merge(a: LeavePortion, b: LeavePortion): LeavePortion {
  if (a === b) return a;
  return "full";
}

/** `${user_id}|${YYYY-MM-DD}` — the key both callers look days up by. */
export function leaveKey(userId: string, date: string): string {
  return `${userId}|${date}`;
}

/**
 * Every day in `[from, to]` that one of these spans covers.
 *
 * Spans are clamped to the range rather than filtered by it: leave running
 * 28 Aug – 3 Sep is relevant to a September payroll run for its first three
 * days, and the query that produced these rows already selected on overlap for
 * exactly that reason.
 *
 * Dates are walked as strings. `lib/dates.ts` parses a bare date at midday UTC
 * precisely so this kind of stepping cannot slide onto the previous day in a
 * negative offset, and this uses `addDays` rather than doing its own arithmetic.
 */
export function expandLeaveDays(
  spans: readonly LeaveSpan[],
  from: string,
  to: string,
): Map<string, LeaveDay> {
  const days = new Map<string, LeaveDay>();

  for (const span of spans) {
    const first = span.start_date > from ? span.start_date : from;
    const last = span.end_date < to ? span.end_date : to;

    // A span entirely outside the range contributes nothing. Guarded rather
    // than trusted: the callers filter on overlap, but a bad range should end
    // the loop rather than run it a few million times.
    if (first > last) continue;

    for (let date: string | null = first; date && date <= last; date = addDays(date, 1)) {
      const key = leaveKey(span.user_id, date);
      const portion = portionOn(date, span);
      const existing = days.get(key);

      const typeNames = existing ? [...existing.typeNames] : [];
      if (span.type_name && !typeNames.includes(span.type_name)) typeNames.push(span.type_name);

      days.set(key, {
        portion: existing ? merge(existing.portion, portion) : portion,
        typeNames,
      });
    }
  }

  return days;
}

/**
 * The one-line description of a leave day, for a CSV cell or a table row.
 *
 * "Full day", or "Half day (morning)" — the shape payroll needs, with the type
 * appended when it is known. Historic rows have neither halves nor a type and
 * read simply as "Full day", which is the honest reading of a row that never
 * recorded either.
 */
export function describeLeaveDay(day: LeaveDay): string {
  const portion =
    day.portion === "full" ? "Full day" : `Half day (${day.portion})`;

  return day.typeNames.length > 0 ? `${portion} — ${day.typeNames.join(", ")}` : portion;
}
