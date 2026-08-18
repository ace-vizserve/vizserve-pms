import { z } from "zod";

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

/** `1:30` — h:mm. */
const CELL_COLON = /^(\d{1,2}):([0-5]?\d)$/;
/** `90`, `1.5` — a number on its own. */
const CELL_BARE = /^\d+(?:\.\d+)?$/;
/** `1h30m`, `1h30`, `1h`, `30m`. Both halves optional, so the caller must reject an empty match. */
const CELL_UNITS = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m?)?$/;

/**
 * A grid cell as typed, into minutes.
 *
 * The two-field hours/minutes form above could refuse decimals outright. A grid
 * cannot: the whole point of the shape is one keystroke-cheap field per day, and
 * a person moving off ClickUp will type `1.5` into it on the first day.
 *
 * So a bare number is HOURS — `1.5` is 90 minutes, not an hour and five. The
 * documented hazard (docs/09, and the two-field comment above) is that nobody
 * finds out which reading they got. Here they do: the cell re-renders as `1:30`
 * the moment it saves, so a wrong reading is visible in the place it was typed
 * and costs one correction rather than going unnoticed into a report.
 *
 * Returns 0 for empty — "clear this cell" is a real instruction, and the caller
 * turns it into a delete. Returns null only for input that means nothing.
 */
export function parseCellDuration(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) return 0;

  let minutes: number;

  const colon = CELL_COLON.exec(value);
  if (colon) {
    minutes = Number(colon[1]) * 60 + Number(colon[2]);
  } else if (CELL_BARE.test(value)) {
    minutes = Math.round(Number(value) * 60);
  } else {
    const units = CELL_UNITS.exec(value);
    // `CELL_UNITS` matches the empty string, and a stray `h` leaves nothing in
    // either group — both are input that parsed to no quantity at all.
    if (!units || (units[1] === undefined && units[2] === undefined)) return null;
    minutes = Math.round(Number(units[1] ?? 0) * 60 + Number(units[2] ?? 0));
  }

  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_ENTRY_MINUTES) return null;
  return minutes;
}

/**
 * Minutes as a cell reads them — `2:30`, never `2h 30m`.
 *
 * Zero-padded and colon-separated so seven of them in a row line up under each
 * other. `formatDuration` in lib/dates is the prose form and stays that way; a
 * grid is scanned down a column, and "45m" next to "2h 30m" does not scan.
 */
export function formatCellDuration(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
