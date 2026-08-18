import { z } from "zod";

import { STANDARD_DAY_MINUTES } from "@/lib/dates";

/**
 * PHASE 6 CONTRACT — timesheet entries (D3a, R11).
 *
 * The seam between P6-01 (migration, RLS, the day-total trigger) and P6-02/03
 * (the entry UI and the week view). Agreed before either side was written, as
 * the roadmap requires — skipping this step is R11.
 *
 * Every rule below is ALSO enforced in the database. This is not belt and
 * braces for its own sake: the front end will be bypassed, and a timesheet is
 * the one artefact in this app somebody has a direct incentive to bypass it
 * with. Where the two could drift, the database is the authority and this is
 * the copy that produces a decent error message.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A day is 1440 minutes, and the per-row CHECK says exactly this. */
export const MAX_ENTRY_MINUTES = 1440;

/**
 * The rule, as one line of zod.
 *
 * `task_id` is a required uuid — not `.nullish()`, not defaulted. Free-text
 * logging is forbidden (Amier, 33:20), the column is NOT NULL, and the type
 * being non-optional is what makes "log time without a task" fail to compile
 * rather than fail at runtime.
 */
export const timesheetEntrySchema = z.object({
  task_id: z.uuid("Pick the task this time went to."),
  work_date: z.string().regex(DATE_ONLY, "Pick a date."),
  minutes: z
    .number()
    .int("Minutes must be whole.")
    .min(1, "Log at least a minute.")
    .max(MAX_ENTRY_MINUTES, "One entry cannot be longer than a day."),
  // Trimmed to null rather than kept as "": the CHECK constraint rejects a
  // blank string, so a form that sends one would fail on the round trip with a
  // constraint name instead of a message.
  note: z
    .string()
    .trim()
    .max(500, "Keep the note under 500 characters.")
    .nullish()
    .transform((value) => (value ? value : null)),
});

export type TimesheetEntryInput = z.infer<typeof timesheetEntrySchema>;

/** Editing an existing row. Same fields, plus which row. */
export const timesheetEntryUpdateSchema = timesheetEntrySchema.extend({
  id: z.uuid(),
});

export type TimesheetEntryUpdateInput = z.infer<typeof timesheetEntryUpdateSchema>;

/**
 * Hours and minutes as typed, into total minutes.
 *
 * Lives here rather than in the form component because the server has to agree
 * with it: the action takes minutes, and two implementations of "2h 30m is 150"
 * is one implementation too many.
 *
 * Returns null rather than 0 for nothing entered, so "they left it blank" and
 * "they typed zero" stay distinguishable — the first is an incomplete form, the
 * second is an error worth naming.
 */
export function toMinutes(hours: string, minutes: string): number | null {
  const h = hours.trim();
  const m = minutes.trim();
  if (!h && !m) return null;

  const parsedHours = h ? Number(h) : 0;
  const parsedMinutes = m ? Number(m) : 0;

  if (!Number.isFinite(parsedHours) || !Number.isFinite(parsedMinutes)) return null;
  if (parsedHours < 0 || parsedMinutes < 0) return null;

  return Math.round(parsedHours * 60 + parsedMinutes);
}

/** The inverse, for populating the edit form. 150 → { hours: "2", minutes: "30" }. */
export function fromMinutes(total: number): { hours: string; minutes: string } {
  return {
    hours: String(Math.floor(total / 60)),
    minutes: String(total % 60),
  };
}

// ---------------------------------------------------------------------------
// The week grid — one cell, one field
// ---------------------------------------------------------------------------

/**
 * NO COLON FORM, DELIBERATELY.
 *
 * `1:30` was accepted and read as an hour and a half. Nobody reads it that way
 * — it looks like a clock, so it reads as one-thirty, or as a minute and thirty
 * seconds next to a timer. An input format that half the team will read
 * backwards has no place on a record that feeds approval and payroll.
 *
 * Everything is units now, on the way in and on the way out: `formatCellDuration`
 * writes `1h 30m`, `parseCellDuration` reads it back. What you see in a cell is
 * exactly what you would type into it.
 *
 * A typed colon is caught and explained rather than silently rejected — see
 * `describeDuration` in the cell editor.
 */
const CELL_COLON_LIKE = /\d\s*:\s*\d/;
/** `90`, `1.5` — a number on its own. Hours, per the hint on screen. */
const CELL_BARE = /^\d+(?:\.\d+)?$/;
/* Unit forms (`1h 30m 5s`) are scanned rather than matched — see `scanUnits`. */

/**
 * A grid cell as typed, into minutes.
 *
 * The two-field hours/minutes form above could refuse decimals outright. A grid
 * cannot: the whole point of the shape is one keystroke-cheap field per day, and
 * a person moving off ClickUp will type `1.5` into it on the first day.
 *
 * So a bare number is HOURS — `1.5` is 90 minutes, not an hour and five. The
 * documented hazard (docs/09, and the two-field comment above) is that nobody
 * finds out which reading they got. Here they do: the cell re-renders as `1h 30m`
 * the moment it saves, so a wrong reading is visible in the place it was typed
 * and costs one correction rather than going unnoticed into a report.
 *
 * Returns 0 for empty — "clear this cell" is a real instruction, and the caller
 * turns it into a delete. Returns null only for input that means nothing.
 */
export function parseCellDuration(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) return 0;

  // Rejected outright rather than guessed at — see CELL_COLON_LIKE.
  if (CELL_COLON_LIKE.test(value)) return null;

  // Accumulated in SECONDS and rounded once at the end. Rounding each unit as
  // it is read makes `1h 30m 40s` and `90m 40s` disagree, which is the kind of
  // difference nobody finds until it is in a payroll dispute.
  let seconds: number;

  if (CELL_BARE.test(value)) {
    seconds = Number(value) * 3600;
  } else {
    const scanned = scanUnits(value);
    if (scanned === null) return null;
    seconds = scanned;
  }

  const minutes = Math.round(seconds / 60);

  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_ENTRY_MINUTES) return null;
  return minutes;
}

/**
 * `1h 30m 5s`, and every sensible spelling of it.
 *
 * A scanner rather than one regex: the previous single-pattern version could
 * only express "optional hours then optional minutes", so it had no room for
 * seconds and no way to reject a trailing remainder — it matched the empty
 * string and had to be checked for that afterwards. This consumes the input or
 * fails, which is the property that matters.
 *
 * A number with NO unit means minutes, so `1h30` is still ninety. A bare number
 * on its own never reaches here — `CELL_BARE` claims it above and reads it as
 * hours, which is the documented rule on screen.
 *
 * Returns seconds, or null if anything in the string was not consumed.
 */
function scanUnits(value: string): number | null {
  // Sticky: each match must start exactly where the last one ended, so a
  // trailing `banana` cannot be quietly skipped over.
  const token = /\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)?\s*/y;

  let seconds = 0;
  let found = false;

  while (token.lastIndex < value.length) {
    const at = token.lastIndex;
    const match = token.exec(value);

    // No match, or a match that consumed nothing — either way the rest of the
    // string is not a duration.
    if (!match || token.lastIndex === at) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;

    const unit = match[2];
    seconds +=
      unit === undefined
        ? amount * 60
        : unit.startsWith("h")
          ? amount * 3600
          : unit.startsWith("s")
            ? amount
            : amount * 60;

    found = true;
  }

  return found ? seconds : null;
}

/**
 * Minutes as a cell reads them — `2:30`, never `2h 30m`.
 *
 * Zero-padded and colon-separated so seven of them in a row line up under each
 * other. `formatDuration` in lib/dates is the prose form and stays that way; a
 * grid is scanned down a column, and "45m" next to "2h 30m" does not scan.
 */
export function formatCellDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

// ---------------------------------------------------------------------------
// P7-05 — the week as a thing that gets submitted
// ---------------------------------------------------------------------------

/**
 * Mirrors `vizserve_pms_timesheet_week_status`.
 *
 * There is no DRAFT. The absence of a row IS the draft state, and a value that
 * never appears in the table is one somebody eventually writes by mistake.
 *
 * RETURNED exists here and deliberately does not exist for internal requests.
 * A rejected leave request is a finished conversation; a week with a wrong
 * Tuesday needs fixing and resubmitting, which is exactly what the approval
 * engine has always meant by `returned`.
 */
export const TIMESHEET_WEEK_STATUSES = ["SUBMITTED", "RETURNED", "APPROVED"] as const;

export type TimesheetWeekStatus = (typeof TIMESHEET_WEEK_STATUSES)[number];

export const TIMESHEET_WEEK_LABELS: Record<TimesheetWeekStatus, string> = {
  SUBMITTED: "Submitted",
  RETURNED: "Sent back",
  APPROVED: "Approved",
};

/** Submitted and approved weeks are read-only; a returned one is editable again. */
export function isWeekLocked(status: TimesheetWeekStatus | null): boolean {
  return status === "SUBMITTED" || status === "APPROVED";
}

/**
 * The decision payload.
 *
 * `approved` and `returned` — and pointedly **no `rejected`**. There is no
 * meaningful terminal rejection of hours somebody already worked: you either
 * accept them or send them back to be fixed. Internal requests take the
 * opposite subset of the same engine's decisions, which is the clearest proof
 * that the engine stayed generic.
 */
export const timesheetWeekDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), reason: z.string().trim().max(2000).optional() }),
  z.object({
    decision: z.literal("returned"),
    reason: z
      .string()
      .trim()
      .min(5, "Say what needs fixing — a week sent back with no reason cannot be acted on.")
      .max(2000, "Keep it under 2000 characters."),
  }),
]);

export type TimesheetWeekDecisionInput = z.infer<typeof timesheetWeekDecisionSchema>;

export const submitTimesheetWeekSchema = z.object({
  week_start: z.string().regex(DATE_ONLY, "Pick a week."),
});

// ---------------------------------------------------------------------------
// P7-06 — the eight-hour day
// ---------------------------------------------------------------------------

/** What a day's total is telling you. `over` is the only one that is a problem. */
export type DayState = "empty" | "normal" | "overtime" | "over";

/**
 * How a day's total should read, given any overtime approved for that date.
 *
 * Advisory, not enforcement — nothing refuses a nine-hour day, and the only
 * hard ceiling is the database's 1440 minutes. This decides what the grid says
 * about it.
 *
 * Extracted here rather than living in the grid so the arithmetic is testable
 * without React, and so the member's week and the lead's team week cannot drift
 * into disagreeing about what counts as a long day.
 */
export function dayState(totalMinutes: number, approvedOvertimeMinutes = 0): DayState {
  if (totalMinutes <= 0) return "empty";
  if (totalMinutes <= STANDARD_DAY_MINUTES) return "normal";

  // Past eight hours. Approved overtime raises the bar rather than removing it:
  // three hours over on a day with two hours approved is still an hour nobody
  // signed off.
  return totalMinutes <= STANDARD_DAY_MINUTES + approvedOvertimeMinutes ? "overtime" : "over";
}
