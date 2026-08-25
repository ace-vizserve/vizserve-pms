import { z } from "zod";

import { formatAppTime, STANDARD_DAY_MINUTES } from "@/lib/dates";

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

/** `HH:MM` — what `<input type="time">` sends. Seconds are not offered. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * An optional wall-clock time (P7-21).
 *
 * Blank normalises to null BEFORE the pattern is applied, so a cleared field
 * and an untouched one are the same value. Validating first would reject "" as
 * a malformed time, which is not what an empty optional field means.
 */
const timeOfDay = z
  .string()
  .nullish()
  .transform((value) => (value && value.trim() ? value.trim() : null))
  .refine((value) => value === null || TIME_OF_DAY.test(value), {
    message: "Use a time like 09:30.",
  });

/**
 * The rule, as one line of zod.
 *
 * `task_id` is a required uuid — not `.nullish()`, not defaulted. Free-text
 * logging is forbidden (Amier, 33:20), the column is NOT NULL, and the type
 * being non-optional is what makes "log time without a task" fail to compile
 * rather than fail at runtime.
 */
const timesheetEntryShape = z.object({
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
  /**
   * P7-21 — optional wall-clock times on `work_date`.
   *
   * `HH:MM`, Manila, the same clock the DTR and every other time in this app
   * shows. Not a timestamp: the row already carries `work_date`, and a value
   * with its own date in it would be a second claim about which day this was.
   *
   * Empty string is normalised to null so a cleared input and an untouched one
   * mean the same thing — the paired CHECK reads nulls, not blanks.
   */
  started_at: timeOfDay,
  ended_at: timeOfDay,
});

/**
 * The three P7-21 rules, applied to the insert shape and the update shape
 * alike.
 *
 * A function rather than a chain on the base object, because `.refine()`
 * returns an effects wrapper with no `.extend()` on it — so refining first
 * would make the update schema below impossible to build from this one, and the
 * two would drift into checking different things.
 *
 * Every rule here has a CHECK constraint behind it. These exist for the message:
 * the database is the authority, and a round trip that fails on a constraint
 * name is a worse way to learn a rule than a sentence under the field.
 */
function withTimeRules<
  T extends z.ZodType<{
    minutes: number;
    started_at: string | null;
    ended_at: string | null;
  }>,
>(schema: T) {
  return (
    schema
      // BOTH OR NEITHER — `vizserve_pms_timesheet_entries_times_paired`.
      .refine((value) => (value.started_at === null) === (value.ended_at === null), {
        message: "Give both a start and an end time, or neither.",
        path: ["ended_at"],
      })
      .refine((value) => value.started_at === null || value.ended_at === null || value.ended_at > value.started_at, {
        // Work crossing midnight is deliberately not expressible — see the
        // migration, and Q8, which is still open on the same question for the
        // DTR. The duration alone still records those hours.
        message: "The end time has to be after the start. Work past midnight goes on as a duration.",
        path: ["ended_at"],
      })
      .refine(
        (value) =>
          value.started_at === null ||
          value.ended_at === null ||
          minutesBetween(value.started_at, value.ended_at) === value.minutes,
        {
          // Should be unreachable from the UI — the editor derives the duration
          // from the times the moment both are set. It is here because the
          // database enforces it either way.
          message: "The duration does not match the times.",
          path: ["minutes"],
        },
      )
  );
}

export const timesheetEntrySchema = withTimeRules(timesheetEntryShape);

export type TimesheetEntryInput = z.infer<typeof timesheetEntrySchema>;

/**
 * Whole minutes between two `HH:MM` wall-clock times on the same day.
 *
 * String arithmetic rather than Date construction: `lib/dates.ts` exists
 * because parsing a bare date drags a timezone in with it, and the same trap is
 * one line away here. Two clock times on one day need no zone at all.
 */
export function minutesBetween(start: string, end: string): number {
  const [sh = 0, sm = 0] = start.split(":").map(Number);
  const [eh = 0, em = 0] = end.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

/** `HH:MM` as an `<input type="time">` produces it. 150 → "02:30" is `fromMinutes`. */
export function addMinutesToTime(start: string, minutes: number): string | null {
  const [h = 0, m = 0] = start.split(":").map(Number);
  const total = h * 60 + m + minutes;
  // Refuses to wrap past midnight rather than silently landing on the next day
  // — the same rule the `ended_at > started_at` constraint states.
  if (!Number.isFinite(total) || total < 0 || total > 23 * 60 + 59) return null;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * WHEN A DURATION IS TYPED, THE CLOCK IS ALREADY KNOWN.
 *
 * P7-21 made times optional and left them to be filled in by hand, which meant
 * the fact easiest to capture — that the hour just logged is the hour just
 * worked — was the one thing nobody ever recorded. Typing `1h` at 3:16pm marks
 * the entry 3:16 to 4:16, and that is what it saves.
 *
 * ⚠️ THE DAY OF THE CELL DOES NOT CHANGE THIS. An earlier version stamped only
 * cells dated today, arguing that Monday's work did not happen at Friday
 * afternoon's clock time. That was overruled, and the reasoning behind the
 * decision is what makes it work: the pair marks WHEN THE ENTRY WENT IN — when
 * the task was done, touched, or written up — rather than reconstructing the
 * day it belongs to. Both clocks stay editable, so anyone who does know the
 * real hours can say so.
 *
 * `now` is a parameter rather than a call, so the callers and the tests all
 * describe the same instant instead of racing the clock.
 */
export function clockAt(now: Date = new Date()): string {
  return formatAppTime(now);
}

/**
 * A start plus a length, as the pair the row stores.
 *
 * Returns the empty pair rather than a start on its own in the two cases that
 * cannot be written: no start to begin with, and a span that would run past
 * midnight — `addMinutesToTime` refuses to wrap, and the `ended_at > started_at`
 * constraint refuses the row that wrapping would produce.
 */
export function spanFrom(
  start: string | null | undefined,
  minutes: number,
): { started_at: string | null; ended_at: string | null } {
  const empty = { started_at: null, ended_at: null };
  if (!start) return empty;

  // Postgres hands `time` back as `HH:MM:SS`; the seconds are not ours to keep.
  const from = start.slice(0, 5);
  const end = addMinutesToTime(from, minutes);

  return end ? { started_at: from, ended_at: end } : empty;
}

/**
 * The quarter hour a clock time is closest to. `15:16` → `15:15`.
 *
 * Where a list of quarter hours should be sitting when it opens on a field
 * nobody has set yet. Opening at `12:00 am` — the top of the list — means
 * scrolling past most of a day to reach the only part of it anyone is ever
 * logging from, which is the hour they are in.
 */
export function nearestQuarterHour(clock: string): string {
  const minutes = minutesBetween("00:00", clock);
  // Capped rather than wrapped: 23:53 rounds up to a midnight that is not on
  // this day and is not in the list.
  const rounded = Math.min(Math.round(minutes / 15) * 15, 23 * 60 + 45);

  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

/**
 * THE THREE FIELDS AN ENTRY IS EDITED THROUGH, AND THE ONE RULE BETWEEN THEM.
 *
 * `vizserve_pms_timesheet_entries_times_match_minutes` refuses a row whose
 * length disagrees with its span, so a length and two clocks are not three
 * independent facts — they are two, and a derivation. Which two is decided by
 * whichever one was touched last:
 *
 *   type a length  → the end moves          (3:00pm + 2h = 5:00pm)
 *   move the start → the end follows, length kept
 *   move the end   → the LENGTH is recomputed from the span
 *
 * Pure transitions on a plain object, and NOT because purity is nice: this is
 * edited from two places now — the popover and the expanded week row — and the
 * one thing this repo has learnt the hard way is that a rule with two copies
 * has two copies to drift. Tested without React, once, for both.
 *
 * Strings throughout, because that is what a half-typed field holds. `1h 3` is
 * not a number yet and must not be rounded into one on the way past.
 */
export type EntryDraft = {
  /** As typed. `1h 30m`, `90m`, `1.5` — anything `parseCellDuration` reads. */
  duration: string;
  note: string;
  /** 24-hour `HH:MM`, or `""` for unset. Both or neither, like the column pair. */
  start: string;
  end: string;
};

/** Typing a length. The end moves, when there is a start to move it from. */
export function withDuration(draft: EntryDraft, duration: string): EntryDraft {
  const minutes = parseCellDuration(duration);
  if (!draft.start || minutes === null || minutes <= 0) return { ...draft, duration };

  // Null is a span that would cross midnight, which the constraint refuses.
  // Blanking the end says so on screen rather than saving a row onto tomorrow.
  return { ...draft, duration, end: addMinutesToTime(draft.start, minutes) ?? "" };
}

/** Moving the start. The length is what was meant, so the end comes along. */
export function withStart(draft: EntryDraft, start: string): EntryDraft {
  // Both or neither: clearing the start clears the end, so the pair is never
  // half-saved and nobody has to work out which half to remove.
  if (!start) return { ...draft, start, end: "" };

  const minutes = parseCellDuration(draft.duration);
  if (minutes === null || minutes <= 0) return { ...draft, start };

  return { ...draft, start, end: addMinutesToTime(start, minutes) ?? "" };
}

/** Moving the end. The one field that overrides the length instead of obeying it. */
export function withEnd(draft: EntryDraft, end: string): EntryDraft {
  if (!draft.start || !end) return { ...draft, end };

  const span = minutesBetween(draft.start, end);
  // A negative span is somebody mid-correction, not an instruction to write a
  // negative length. It stays on screen and `draftToEntry` names it on save.
  return span > 0 ? { ...draft, end, duration: formatCellDuration(span) } : { ...draft, end };
}

/** The draft as the row would be written, or the sentence to show instead. */
export function draftToEntry(
  draft: EntryDraft,
):
  | { ok: true; entry: { minutes: number; note: string | null; started_at: string | null; ended_at: string | null } }
  | { ok: false; error: string } {
  // Half a pair. Usually somebody mid-edit — but it is also where a length that
  // would run past midnight lands, because `addMinutesToTime` refuses to wrap
  // rather than filing the work on tomorrow. Both readings get this sentence,
  // and it names the second one.
  if (Boolean(draft.start) !== Boolean(draft.end)) {
    return {
      ok: false,
      error: "Give both a start and an end time, or neither. Work running past midnight goes on as a duration.",
    };
  }

  let minutes = parseCellDuration(draft.duration);

  if (minutes === null || minutes === 0) {
    return { ok: false, error: "How long was it? Try 1h 30m, 90m or 1.5." };
  }

  if (draft.start && draft.end) {
    const span = minutesBetween(draft.start, draft.end);
    if (span <= 0) {
      return { ok: false, error: "The end time has to be after the start. Work past midnight goes on as a duration." };
    }

    // The times win. They normally agree with the length already — the end was
    // derived from it — but `1h 30m 5s` rounds and a span does not, and the
    // constraint compares them exactly.
    minutes = span;
  }

  return {
    ok: true,
    entry: {
      minutes,
      note: draft.note.trim() ? draft.note.trim() : null,
      started_at: draft.start || null,
      ended_at: draft.end || null,
    },
  };
}

/**
 * `90` → "1 hour 30 minutes". The suggestion under the field, in words.
 *
 * Deliberately NOT `formatCellDuration`, which writes `1h 30m` — the two say
 * the same thing in the same place and only one of them tells somebody who has
 * just typed `1.5` which reading they got. Spelling it out is the point.
 */
export function spellDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (rest > 0) parts.push(`${rest} minute${rest === 1 ? "" : "s"}`);

  return parts.join(" ");
}

/** Editing an existing row. Same fields and the same rules, plus which row. */
export const timesheetEntryUpdateSchema = withTimeRules(timesheetEntryShape.extend({ id: z.uuid() }));

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
/**
 * SLICE H — what a typed cell means, decided outside the component.
 *
 * The grid already saves on blur and on Enter; what it could not do was survive a
 * cell being typed into and then abandoned — a tab closed, a phone rotated, the
 * row scrolled away. Committing on unmount and on `visibilitychange` fixes that,
 * and both of those fire in places where React state is no longer readable. So
 * the DECISION moves here, where it is a pure function of the typed string and
 * the cell's current contents, and the component is left holding only the call.
 *
 * That it is now unit-testable is the second benefit rather than the first. The
 * branches below are the ones that used to be four early `return`s inside an
 * event handler, which is not a place a rule about deleting somebody's timesheet
 * entry should live.
 *
 * `noop` is a first-class answer and there are two ways to reach it: the number
 * did not change, or an empty cell was left empty. Neither is an error and
 * neither may write — a no-change UPDATE still bumps `updated_at` and would make
 * every tab through a week look like an edit in the audit trail.
 */
export type CellCommit =
  /** Not a length of time. The caller shows the sentence and keeps the draft. */
  | { kind: "invalid"; typed: string }
  /** Nothing to write. */
  | { kind: "noop" }
  /** No entry existed and a duration was given. */
  | { kind: "insert"; minutes: number }
  /** An entry existed and its length changed. */
  | { kind: "update"; minutes: number }
  /** An entry existed and the cell was cleared. Zero means "remove it". */
  | { kind: "delete" };

export function cellCommit(typed: string, cell: { total: number; entryCount: number }): CellCommit {
  const minutes = parseCellDuration(typed);

  // null is "means nothing" — an empty string is 0, which is a real instruction.
  if (minutes === null) return { kind: "invalid", typed };

  // Unchanged. Checked before the empty case, so clearing an already-empty cell
  // lands here rather than in `delete` with no entry to delete.
  if (minutes === cell.total) return { kind: "noop" };

  if (cell.entryCount === 0) {
    // Nothing there and nothing typed.
    return minutes === 0 ? { kind: "noop" } : { kind: "insert", minutes };
  }

  return minutes === 0 ? { kind: "delete" } : { kind: "update", minutes };
}

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

/**
 * A day's figures, once — capacity, what was tracked against it, and by how
 * much it ran over.
 *
 * WHY THIS EXISTS. `dayState` already stopped the two grids disagreeing about
 * what counts as a long day, but each of them then went on to recompute
 * `STANDARD_DAY_MINUTES + granted` and the overage inline, in slightly
 * different words, and only ever spoke the amount to a screen reader. On screen
 * the rule was a red bar and nothing else — a member could see that a day was
 * "over" and not what it was over BY, which is the one number they need in
 * order to decide whether to fix the hours or file the overtime.
 *
 * ADVISORY, AND STAYING ADVISORY. Nothing here refuses anything. The database
 * caps a day at 1440 minutes and knows nothing about this figure; approved
 * overtime is capped at 960 exactly so `480 + approved` can never exceed that
 * ceiling. This function decides what the screen SAYS, which is the whole of
 * what the rule has ever been.
 */
export type DaySummary = {
  state: DayState;
  /** The standard day, plus whatever overtime was approved for this date. */
  capacityMinutes: number;
  trackedMinutes: number;
  /** How far past capacity. Zero unless the state is `over`. */
  overMinutes: number;
  /** Tracked as a percentage of capacity, rounded. 0 on an empty day. */
  percentOfCapacity: number;
};

export function daySummary(totalMinutes: number, approvedOvertimeMinutes = 0): DaySummary {
  const capacityMinutes = STANDARD_DAY_MINUTES + approvedOvertimeMinutes;

  return {
    state: dayState(totalMinutes, approvedOvertimeMinutes),
    capacityMinutes,
    trackedMinutes: totalMinutes,
    // `max(0, …)` rather than a branch on the state: a day inside its approved
    // overtime is not over by anything, and a negative "over" is not a number
    // anybody should have to render.
    overMinutes: Math.max(0, totalMinutes - capacityMinutes),
    percentOfCapacity: totalMinutes > 0 ? Math.round((totalMinutes / capacityMinutes) * 100) : 0,
  };
}
