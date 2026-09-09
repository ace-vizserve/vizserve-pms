import { z } from "zod";

import { taskStatusSchema } from "@/lib/schemas/tasks";
import { TIMESHEET_WEEK_STATUSES } from "@/lib/schemas/timesheet";

/**
 * P12-23 CONTRACT — what `/timesheet`, `/timesheet/team` and `/dtr` read, once
 * the reads are the browser's.
 *
 * ------------------------------------------------------------------------
 * The D3a handoff artefact for the three time surfaces, and the sibling of
 * `lib/schemas/task-list.ts`. Read that file's header first: every argument
 * there applies here unchanged, and the short version is that moving a read into
 * the browser does NOT move the generated `Database` types with it — `read()`
 * hands back whatever PostgREST sent, and a column renamed, dropped from a
 * `.select()` string or returned in a shape this deploy does not expect arrives
 * as `undefined` with no type error anywhere.
 *
 * ⚠️ AND HERE THAT MATTERS MORE THAN ANYWHERE ELSE IN THE PRODUCT, BECAUSE THE
 * DATA IS HOURS. A `minutes` column arriving as `undefined` sums to `NaN` and
 * renders as a blank cell; a `work_date` arriving in a different shape files
 * somebody's Tuesday under a key nothing matches and quietly removes it from
 * their week. Both look like "I did not log that" rather than like a fault, and
 * the person on the other end of the mistake is the one whose week gets
 * refused, or approved, on the strength of it. Parsing is what turns that into
 * a `QueryError` naming the migration that has not been applied.
 *
 * ⚠️ THE FIELD NAMES ARE THE DATABASE'S, snake_case and unrenamed, because the
 * grids have read the rows' own names since P6-02 and a mapping layer here would
 * be one more thing to drift.
 * ------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/* Shared shapes.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `HH:MM:SS` or `HH:MM` out of a Postgres `time`, or null.
 *
 * ⚠️ NOT NARROWED TO A PATTERN. Postgres can return `09:30:00`, `09:30:00.5`
 * and — for a column somebody set to a whole hour — `09:30`, and the trimming
 * to `HH:MM` is done at the point of use for reasons the timesheet page states
 * at length. A regex here would turn a legal third form into a parse failure
 * that reads as "this build does not recognise your timesheet".
 */
const clockSchema = z.string().nullable();

/** A `date` column. Bare `YYYY-MM-DD`; `lib/dates.ts` is what parses one. */
const dateSchema = z.string();

/** The `id, name` pair every lookup in this file resolves through. */
export const namedRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

export type NamedRow = z.infer<typeof namedRowSchema>;

/** A list, plus the folder it sits in — `/timesheet/team` draws all three. */
export const namedListRowSchema = namedRowSchema.extend({
  group_id: z.uuid().nullable(),
});

export type NamedListRow = z.infer<typeof namedListRowSchema>;

/**
 * The task an entry was logged against, as the entries embed carries it.
 *
 * ⚠️ NULLABLE, AND THE NULL IS A SUPPORTED STATE RATHER THAN A FAULT. The embed
 * is a LEFT join on purpose: the entries policy returns the caller's own rows,
 * the TASKS policy is narrower, and the two diverge the moment a task is
 * reassigned away from somebody who already logged time against it. Pinned by
 * `tests/db/timesheet.test.ts`, "entries survive losing sight of their task".
 * The hours stay theirs; only the name of the work is no longer theirs to read.
 */
export const entryTaskSchema = z
  .object({
    title: z.string(),
    status: taskStatusSchema,
    list_id: z.uuid().nullable(),
    department_id: z.uuid().nullable(),
  })
  .nullable();

/* -------------------------------------------------------------------------- */
/* `qk.week(userId, weekStart)` — one person's week.                           */
/* -------------------------------------------------------------------------- */

/**
 * One timesheet entry, exactly the columns `/timesheet` selects.
 *
 * `minutes` is `int` and the trigger caps a day at 1440; no bound is restated
 * here, because a row that got past the trigger is a fact about the database
 * and refusing to render it would hide the very thing somebody needs to see.
 */
export const timesheetEntryRowSchema = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  work_date: dateSchema,
  minutes: z.number().int(),
  note: z.string().nullable(),
  started_at: clockSchema,
  ended_at: clockSchema,
  vizserve_pms_tasks: entryTaskSchema,
});

export type TimesheetEntryRow = z.infer<typeof timesheetEntryRowSchema>;

/**
 * The week row, when there is one.
 *
 * ⚠️ NO ROW IS THE DRAFT STATE. The migration deliberately has no DRAFT enum
 * member: "not submitted" is an absence, so `maybeSingle()` returning null is
 * the normal case and must not read as an error. That is why the fetcher types
 * this `| null` rather than making the schema optional.
 */
export const timesheetWeekRowSchema = z.object({
  id: z.uuid(),
  status: z.enum(TIMESHEET_WEEK_STATUSES),
  submitted_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
});

export type TimesheetWeekRow = z.infer<typeof timesheetWeekRowSchema>;

/**
 * An approved OVERTIME request, as both week grids read it.
 *
 * ⚠️ `id` IS NOT DECORATION. A day marked "OT" or "over +1h" is the grid
 * asserting that somebody signed off those hours, and the id is what lets a
 * reader open the signature. It is safe to put in a link precisely because it
 * arrived through a policy-scoped read.
 *
 * `work_date` is nullable on the table — only the time-shaped request types
 * carry one — so a null here is dropped by the caller rather than being a parse
 * failure.
 */
export const overtimeRowSchema = z.object({
  id: z.uuid(),
  work_date: dateSchema.nullable(),
  overtime_minutes: z.number().int().nullable(),
});

export type OvertimeRow = z.infer<typeof overtimeRowSchema>;

/** The same row on the team grid, which needs to know whose it is. */
export const teamOvertimeRowSchema = overtimeRowSchema.extend({
  requester_id: z.uuid(),
});

export type TeamOvertimeRow = z.infer<typeof teamOvertimeRowSchema>;

/**
 * P8-05 — the schedule half of a week.
 *
 * `break_minutes` is NULLABLE AND NULL MEANS "INHERIT THE COMPANY FIGURE",
 * never zero. `resolveScheduledWeek` is where the two are combined, and it is
 * the only place that may.
 */
export const workProfileSchema = z.object({
  work_start: clockSchema,
  work_end: clockSchema,
  break_minutes: z.number().int().nullable(),
});

export type WorkProfile = z.infer<typeof workProfileSchema>;

/** A proclaimed holiday inside the week. */
export const holidayRowSchema = z.object({ holiday_date: dateSchema });

/**
 * An approved LEAVE span overlapping a range.
 *
 * The halves come along because `expandLeaveDays` needs them: a half day is a
 * marker on the request's own end, and dropping them would turn every half day
 * into a whole one on every screen that counts days.
 */
export const leaveSpanRowSchema = z.object({
  requester_id: z.uuid(),
  start_date: dateSchema.nullable(),
  end_date: dateSchema.nullable(),
  start_half: z.enum(["MORNING", "AFTERNOON"]).nullable(),
  end_half: z.enum(["MORNING", "AFTERNOON"]).nullable(),
});

export type LeaveSpanRow = z.infer<typeof leaveSpanRowSchema>;

/**
 * The company-wide settings row, read in the browser now.
 *
 * ⚠️ THE COLUMNS ARE NULLABLE HERE AND THEY ARE NOT NULLABLE IN THE DATABASE.
 * `maybeSingle()` on a table with no row returns null with no error, and
 * `loadAppSettings` has always degraded that to the migration's own defaults
 * rather than throwing — three screens depend on it. The schema describes the
 * ROW; the absence of one is handled by the fetcher, which is also where
 * `fellBack` is decided.
 */
export const appSettingsRowSchema = z.object({
  grace_minutes: z.number().int(),
  break_minutes: z.number().int(),
});

export type AppSettingsRow = z.infer<typeof appSettingsRowSchema>;

/* -------------------------------------------------------------------------- */
/* `qk.teamWeek(departmentId, weekStart)` — a lead's week.                     */
/* -------------------------------------------------------------------------- */

/** The member's entry, plus whose it is. */
export const teamEntryRowSchema = timesheetEntryRowSchema.extend({
  user_id: z.uuid(),
});

export type TeamEntryRow = z.infer<typeof teamEntryRowSchema>;

/**
 * A submitted week on the team grid.
 *
 * `submitted_minutes` is what the person handed in; the grid shows the LIVE
 * total beside it, and the two disagreeing is a fact worth seeing rather than
 * one to reconcile away.
 */
export const teamWeekRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  status: z.enum(TIMESHEET_WEEK_STATUSES),
  submitted_minutes: z.number().int().nullable(),
  submitted_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
});

export type TeamWeekRow = z.infer<typeof teamWeekRowSchema>;

/**
 * Names, and each person's unpaid break.
 *
 * ⚠️ NO `is_active` FILTER ON THE QUERY BEHIND THIS, AND THAT IS DELIBERATE.
 * This is a LOOKUP — the grid's row set is built from entries, weeks, leave and
 * punches, never from here — so filtering only ever removes a name from
 * somebody whose rows are on the grid regardless. `is_active` is not even
 * selected, because nothing on these screens branches on it.
 */
export const personBreakRowSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  break_minutes: z.number().int().nullable(),
});

export type PersonBreakRow = z.infer<typeof personBreakRowSchema>;

/** A punch, as both the team grid and the punch panel read one. */
export const punchRowSchema = z.object({
  user_id: z.uuid(),
  work_date: dateSchema,
  time_in: clockSchema,
  time_out: clockSchema,
});

export type PunchRowData = z.infer<typeof punchRowSchema>;

/**
 * P7-10 — `vizserve_pms_leave_calendar`, which is `SECURITY DEFINER` and
 * returns name and dates and no reason and no type.
 *
 * ⚠️ THE RPC RETURNS MORE COLUMNS THAN THIS AND THE SCHEMA DOES NOT LIST THEM.
 * `z.object` strips unknown keys by default, which is the right posture for a
 * function whose signature is owned by a migration: the three fields the team
 * grid reads are asserted, and a fourth appearing is not a reason to refuse the
 * whole week.
 */
export const leaveCalendarRowSchema = z.object({
  user_id: z.uuid(),
  start_date: dateSchema,
  end_date: dateSchema,
});

export type LeaveCalendarRow = z.infer<typeof leaveCalendarRowSchema>;

/* -------------------------------------------------------------------------- */
/* `qk.dtrView(filters)` — the daily time record.                              */
/* -------------------------------------------------------------------------- */

/**
 * A DTR row with the person's name and schedule hanging off it.
 *
 * ⚠️ THE FK IS NAMED IN THE `.select()` BEHIND THIS AND IT MUST STAY NAMED.
 * `vizserve_pms_dtr_entries` has TWO foreign keys to `vizserve_pms_users` —
 * `user_id` and `corrected_by` — so an unqualified embed is ambiguous and
 * PostgREST refuses the whole query with "more than one relationship was
 * found". That shipped broken and looked EMPTY for months, because the page read
 * `data ?? []`.
 */
export const dtrPunchRowSchema = z.object({
  id: z.uuid(),
  work_date: dateSchema,
  time_in: clockSchema,
  time_out: clockSchema,
  corrected_at: z.string().nullable(),
  user_id: z.uuid(),
  vizserve_pms_users: z
    .object({
      full_name: z.string(),
      work_start: clockSchema,
      work_end: clockSchema,
    })
    .nullable(),
});

export type DtrPunchRow = z.infer<typeof dtrPunchRowSchema>;

/**
 * P7-40 — a correction or an approved overtime filed against a day.
 *
 * `status` is the internal-request enum, narrowed to the three members the DTR
 * can receive: this query filters to the time-shaped types, and a WITHDRAWN or
 * CANCELLED row would be a shape this screen has never rendered.
 */
export const dayRequestRowSchema = z.object({
  id: z.uuid(),
  request_type: z.string(),
  status: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED"]),
  work_date: dateSchema.nullable(),
  requester_id: z.uuid(),
  correction_at: z.string().nullable(),
  overtime_minutes: z.number().int().nullable(),
});

export type DayRequestRow = z.infer<typeof dayRequestRowSchema>;

/** The DTR's own leave read — the label rides along, unlike the week's. */
export const dtrLeaveSpanRowSchema = leaveSpanRowSchema.extend({
  vizserve_pms_leave_types: z.object({ label: z.string() }).nullable(),
});

export type DtrLeaveSpanRow = z.infer<typeof dtrLeaveSpanRowSchema>;

/** The person picker on the DTR toolbar, and `nameOf` inside the view. */
export const dtrPersonRowSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
});

export type DtrPersonRow = z.infer<typeof dtrPersonRowSchema>;

/* -------------------------------------------------------------------------- */
/* `qk.punchState()` — am I timed in?                                          */
/* -------------------------------------------------------------------------- */

/** Today's and yesterday's rows, for the one person asking. */
export const ownPunchRowSchema = z.object({
  work_date: dateSchema,
  time_in: clockSchema,
  time_out: clockSchema,
});

export type OwnPunchRow = z.infer<typeof ownPunchRowSchema>;

/** Just the schedule half of the user row. `scheduleFor` normalises it. */
export const ownScheduleRowSchema = z.object({
  work_start: clockSchema,
  work_end: clockSchema,
});

export type OwnScheduleRow = z.infer<typeof ownScheduleRowSchema>;

/** Overtime already approved for today, which extends the day's end. */
export const ownOvertimeRowSchema = z.object({
  overtime_minutes: z.number().int().nullable(),
});

/* -------------------------------------------------------------------------- */
/* The picker.                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `qk.loggableTasks()` — the twenty the picker shows before anybody types.
 *
 * ⚠️ SHAPED HERE AND BUILT IN `lib/timesheet-tasks.ts`, which merges two
 * queries and resolves `where` itself. So this is not a row schema over a
 * `.select()` string: it is the contract of that function's OUTPUT, asserted at
 * the cache boundary for the same reason every other shape in this file is.
 * `status` is a plain string on the wire because that module is shared with a
 * caller that has no opinion on the enum; the narrowing happens in the one
 * component that renders a badge from it.
 */
export const loggableTaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: z.string(),
  where: z.string(),
  created_at: z.string(),
  start_date: dateSchema.nullable(),
  due_date: dateSchema.nullable(),
});

export type LoggableTaskRow = z.infer<typeof loggableTaskSchema>;
