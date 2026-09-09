import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { weekDates, workedMinutes } from "@/lib/dates";
import { DEFAULT_BREAK_MINUTES, DEFAULT_GRACE_MINUTES } from "@/lib/dtr-schedule";
import type { DayHalf, LeaveSpan } from "@/lib/leave";
import { parse, parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import {
  appSettingsRowSchema,
  holidayRowSchema,
  leaveCalendarRowSchema,
  leaveSpanRowSchema,
  loggableTaskSchema,
  namedListRowSchema,
  namedRowSchema,
  overtimeRowSchema,
  personBreakRowSchema,
  punchRowSchema,
  teamEntryRowSchema,
  teamOvertimeRowSchema,
  teamWeekRowSchema,
  timesheetEntryRowSchema,
  timesheetWeekRowSchema,
  workProfileSchema,
  type LoggableTaskRow,
  type NamedRow,
  type OvertimeRow,
  type TimesheetEntryRow,
  type TimesheetWeekRow,
} from "@/lib/schemas/time-records";
import { breakAdjustedPunches, type OvertimeApproval } from "@/lib/schemas/timesheet";
import { loadLoggableTaskLists, loadLoggableTasks } from "@/lib/timesheet-tasks";
import type { TeamRow, TeamTaskRow } from "@/app/(app)/timesheet/team/team-week-grid";
import { resolveScheduledWeek, type ScheduledWeek } from "@/lib/timesheet-schedule";

/**
 * P12-23 — the reads behind `/timesheet` and `/timesheet/team`.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. Both pages were RSCs that awaited eight or ten queries
 * and handed the whole week down as props, and every write went through
 * `revalidatePath("/timesheet")` — which re-ran all of them to move one number
 * in one cell. The `useOptimistic` in `week-grid.tsx` existed only to bridge the
 * gap while they ran, and it dropped its value the instant its transition ended,
 * which is why a typed cell reverted to the server total and then re-appeared.
 *
 * ⚠️ THE DATA IS HOURS, AND THAT CHANGES WHAT A FAILED READ MAY DO. This is the
 * closest thing in the app to payroll. Everything below goes through `read()`,
 * which THROWS — there is no `?? []` in this file for the entries, the week row
 * or the overtime, and there must never be one. A failed entries read that
 * rendered as an empty week would be the screen telling somebody they logged
 * nothing, on the screen where that distinction decides what they are paid.
 *
 * ⚠️ WITH EXACTLY FOUR EXCEPTIONS, THREE OF WHICH P8-05 ARGUED FOR. The
 * schedule half — the profile, the holidays and the leave — is ADVISORY: it
 * produces a sentence saying "this week is short of your
 * schedule", and `vizserve_pms_submit_timesheet_week` is what actually refuses a
 * short week. Taking the hours off the screen because a holiday list did not
 * load would be the wrong trade in both directions, so those three are read
 * through `tolerate` below, which turns a failure into a FLAG rather than into
 * silence. `resolveScheduledWeek` then withholds the whole claim and names which
 * read failed, and the banner says so out loud. That is the opposite of `?? []`:
 * the failure is reported, it is just not fatal. The fifth is the team grid's
 * punch comparison, which is argued at its own call. The company settings row
 * degrades inside `readAppSettings` instead, for the reason stated there.
 *
 * ⚠️ NOTHING HERE RESTATES A SCOPE FILTER. The entries policy returns the
 * caller's own rows plus their team's; the `.eq("user_id", …)` on the member's
 * week NARROWS a policy result to the one person this screen is about, and the
 * team page carries no filter at all. There is no department clause anywhere
 * below and adding one would imply the policy were optional (CLAUDE.md).
 * ------------------------------------------------------------------------
 */

/**
 * The half of the Supabase client these reads touch.
 *
 * `rpc` is here for `vizserve_pms_leave_calendar` on the team page. Structural,
 * so a hand-written stub satisfies it and a fetcher stays testable without a
 * Supabase client — the rule `tests/unit/query-layer.test.ts` states.
 */
export type TimesheetReadClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

/**
 * A read whose failure is a FLAG, not the end of the query.
 *
 * ⚠️ THE ONLY THING IN THIS FILE ALLOWED TO SWALLOW AN ERROR, AND IT DOES NOT
 * SWALLOW IT — it reports it as `failed`, which travels into
 * `resolveScheduledWeek` and comes back out as `readFailure`, which the banner
 * above the grid prints in words. The distinction from `?? []` is the whole of
 * P12-01: an empty holiday list and a holiday list that did not load produce
 * different screens.
 *
 * Used for the four reads named in the header and nothing else. A
 * caller reaching for this on the entries, the week row or the overtime has
 * misread it.
 */
async function tolerate<T>(
  query: Promise<T>,
): Promise<{ data: T | null; failed: boolean; message: string | null }> {
  try {
    return { data: await query, failed: false, message: null };
  } catch (error) {
    /* The sentence is KEPT, not discarded. `QueryError` shows the Postgres
       wording on every other surface in this app, and a banner that says a read
       failed without saying what it said is a banner nobody can act on. */
    return {
      data: null,
      failed: true,
      message: error instanceof Error ? error.message : "Unknown error.",
    };
  }
}

/* -------------------------------------------------------------------------- */
/* `qk.week(userId, weekStart)` — one person's week.                           */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ ROWS, NOT THE GRID. The cache holds what came back and
 * `timesheet-view.tsx` builds the `TaskRow[]` from it — the same derivation that
 * was in the RSC, moved and not rewritten.
 *
 * That division is not stylistic. A typed cell is an optimistic ENTRY, and
 * `lib/query/timesheet-cache.ts` patches it into `entries` below; every total on
 * the screen — the cell, the row, the day header, the week footer — is summed
 * from that array, so one patch moves all four and they cannot disagree. Caching
 * the derived grid instead would mean patching four numbers by hand and getting
 * one of them wrong somewhere.
 */
export type TimesheetWeek = {
  entries: TimesheetEntryRow[];
  /** Null is the DRAFT state. See `timesheetWeekRowSchema`. */
  week: TimesheetWeekRow | null;
  overtime: OvertimeRow[];
  /** Name lookups for the line under each task. See the note in the fetcher. */
  departments: NamedRow[];
  lists: NamedRow[];
  /** P8-05. Null inside means exempt OR a failed read; `readFailure` separates them. */
  schedule: ScheduledWeek;
};

export async function fetchTimesheetWeek(
  client: TimesheetReadClient,
  params: { userId: string; monday: string },
): Promise<TimesheetWeek> {
  const { userId, monday } = params;
  const days = weekDates(monday);
  const sunday = days[days.length - 1]!;

  const [
    entryRows,
    weekRow,
    overtimeRows,
    departmentRows,
    listRows,
    profile,
    holidays,
    leave,
    settings,
  ] = await Promise.all([
    /*
     * A LEFT embed, deliberately not `!inner`.
     *
     * The entries policy returns a row on `user_id = auth.uid()`. The TASKS
     * policy is narrower — PIC, QA, or department lead — so the two diverge the
     * moment a task is reassigned away from somebody who already logged time
     * against it. An inner join turns "I cannot see that task" into "that row
     * does not exist", and their hours disappear from their own week, from the
     * day totals, and from anything derived from them.
     *
     * Pinned by a test: tests/db/timesheet.test.ts, "entries survive losing
     * sight of their task".
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_timesheet_entries")
        .select(
          "id, task_id, work_date, minutes, note, started_at, ended_at, vizserve_pms_tasks(title, status, list_id, department_id)",
        )
        // No `user_id` filter would still be correct — the SELECT policy returns
        // the caller's own rows plus their team's — and this page shows only
        // their own, which is what the eq is for. It narrows a policy result; it
        // does not replace it.
        .eq("user_id", userId)
        .gte("work_date", monday)
        .lte("work_date", sunday)
        .order("work_date")
        .order("created_at"),
    ),

    // P7-05 — this week, if it has been handed in.
    //
    // `maybeSingle`, because NO ROW IS THE DRAFT STATE. The migration
    // deliberately has no DRAFT enum member: "not submitted" is an absence, so
    // a missing row is the normal case and must not read as an error.
    read<unknown>(
      client
        .from("vizserve_pms_timesheet_weeks")
        .select("id, status, submitted_at, decision_reason")
        .eq("user_id", userId)
        .eq("week_start", monday)
        .maybeSingle(),
    ),

    /*
     * P7-04 / slice D — overtime somebody's lead has already signed off.
     *
     * The eight-hour rule is `480 + approved overtime for that day`, so without
     * this the grid marks a legitimately approved eleven-hour day as over —
     * which trains people to ignore the marker, and the marker is the only thing
     * the rule has.
     *
     * ADVISORY, NEVER ENFORCEMENT. The database caps a day at 1440 minutes and
     * does not care about this figure at all; approved overtime is capped at 960
     * precisely so `480 + 960` cannot exceed what the trigger allows.
     *
     * ⚠️ AND YET IT IS READ THROUGH `read()` RATHER THAN `tolerate`. "Advisory"
     * here means the DATABASE does not enforce it; a failure would still make
     * the grid mark an approved eleven-hour day as an hour over, which is an
     * accusation drawn from a read that did not happen. The schedule banner has
     * a sentence for its own failure; this marker has none, so it must not be
     * allowed to be wrong quietly.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_internal_requests")
        .select("id, work_date, overtime_minutes")
        .eq("requester_id", userId)
        .eq("request_type", "OVERTIME")
        .eq("status", "APPROVED")
        .gte("work_date", monday)
        .lte("work_date", sunday),
    ),

    /*
     * Names for the location line under each task.
     *
     * ⚠️ TWO SMALL REFERENCE READS RATHER THAN A DEEPER EMBED, and that is the
     * RSC's own reasoning kept: the entries embed above is already a LEFT join
     * guarding against a task that left this person's scope, and nesting two
     * more levels under it makes that guard harder to read than the thing it is
     * guarding.
     *
     * ⚠️ AND THEY ARE HERE RATHER THAN ON `qk.ref(...)`, WHICH IS A REAL COST
     * AND A DELIBERATE ONE. The existing ref entries are OFFER lists — the
     * departments a lead may file work under, the ACTIVE lists a filter may
     * name — and both filter `is_active = true`. These two are NAME LOOKUPS: a
     * task sitting in an archived list still has hours logged against it, and
     * resolving its name through a list that excludes archived rows would drop
     * the line under the task rather than say it. Different row set, same
     * argument `keys.ts` makes for `listsVisible()` against `lists(id)`.
     *
     * The price is two small `id, name` reads per week navigated. They ride in
     * this wave rather than after it, so they cost no extra round trip. Phase 6
     * owns `qk.ref` and is where a shared name lookup belongs if one is wanted.
     */
    read<unknown[]>(client.from("vizserve_pms_departments").select("id, name")),
    read<unknown[]>(client.from("vizserve_pms_lists").select("id, name")),

    /*
     * P8-05 — the four reads behind "this week is short of your schedule".
     *
     * ⚠️ EVERY ONE OF THEM GOES THROUGH `tolerate`, AND THE HEADER EXPLAINS WHY
     * AT LENGTH. Holidays and leave only ever SUBTRACT from the expected week,
     * so a failed read does not degrade the figure gracefully — it INFLATES it,
     * and the screen would tell somebody they are eight hours short of a week
     * the database will accept without a murmur. `resolveScheduledWeek` withholds
     * the whole claim instead, and names the read that failed.
     */
    tolerate(
      read<unknown>(
        client
          .from("vizserve_pms_users")
          .select("work_start, work_end, break_minutes")
          .eq("id", userId)
          .maybeSingle(),
      ),
    ),

    /*
     * The proclaimed holidays inside this week. Read from the TABLE, not from
     * `isBusinessDay` in lib/dates — that helper carries a seeded 2026 list and
     * says so, and a holiday an admin added would be missing from it. The
     * database counts expected days through `vizserve_pms_is_working_day`, which
     * reads this table, so this is the only reading that agrees with it.
     */
    tolerate(
      read<unknown[]>(
        client
          .from("vizserve_pms_holidays")
          .select("holiday_date")
          .gte("holiday_date", monday)
          .lte("holiday_date", sunday),
      ),
    ),

    /*
     * Approved leave OVERLAPPING the week, not contained by it — leave running
     * Thursday to next Tuesday reduces what is expected of both weeks.
     */
    tolerate(
      read<unknown[]>(
        client
          .from("vizserve_pms_internal_requests")
          .select("requester_id, start_date, end_date, start_half, end_half")
          .eq("requester_id", userId)
          .eq("request_type", "LEAVE")
          .eq("status", "APPROVED")
          .lte("start_date", sunday)
          .gte("end_date", monday),
      ),
    ),

    readAppSettings(client),
  ]);

  return {
    entries: parseAll(timesheetEntryRowSchema, entryRows, "this week's entries"),
    week: weekRow === null ? null : parse(timesheetWeekRowSchema, weekRow, "the week's status"),
    overtime: parseAll(overtimeRowSchema, overtimeRows, "approved overtime"),
    departments: parseAll(namedRowSchema, departmentRows, "departments"),
    lists: parseAll(namedRowSchema, listRows, "lists"),
    schedule: resolveScheduledWeek({
      userId,
      days,
      profile:
        profile.data === null ? null : parse(workProfileSchema, profile.data, "your working hours"),
      profileError: profile.failed,
      holidays: (holidays.data === null
        ? []
        : parseAll(holidayRowSchema, holidays.data, "holidays")
      ).map((row) => row.holiday_date),
      holidaysError: holidays.failed,
      leave:
        leave.data === null
          ? []
          : toLeaveSpans(parseAll(leaveSpanRowSchema, leave.data, "approved leave")),
      leaveError: leave.failed,
      companyBreakMinutes: settings.breakMinutes,
      /* A failed settings read and a settings read that found no row are the
         same thing to `resolveScheduledWeek`: a number nobody actually read.
         `readAppSettings` collapses both into `fellBack`. */
      settingsFellBack: settings.fellBack,
    }),
  };
}

/**
 * `user_id` rather than `requester_id`, and `type_name: null` because the type
 * is not read here — `expandLeaveDays` keys days by person, and this figure has
 * exactly one. The name is what the DTR's export needs; a shortfall sentence has
 * no room for it and no reason to say it.
 *
 * The shape constraint guarantees both dates on a LEAVE row; the types do not,
 * and a null would expand into an unbounded walk.
 */
function toLeaveSpans(
  rows: { requester_id: string; start_date: string | null; end_date: string | null; start_half: DayHalf | null; end_half: DayHalf | null }[],
): LeaveSpan[] {
  return rows
    .filter((row) => row.start_date !== null && row.end_date !== null)
    .map((row) => ({
      user_id: row.requester_id,
      start_date: row.start_date!,
      end_date: row.end_date!,
      start_half: row.start_half,
      end_half: row.end_half,
      type_name: null,
    }));
}

/**
 * P7-37 / P8-05 — the company-wide settings row, read in the browser.
 *
 * ⚠️ `fellBack` IS THE WHOLE REASON THIS IS NOT A ONE-LINER. `loadAppSettings`
 * on the server degrades to the migration's own defaults rather than throwing,
 * because three screens would go down otherwise — and it reports the degrade,
 * because a caller that turns the break into a THRESHOLD it shows somebody is
 * asserting a figure. A company break of 30 read as the fallback 60 makes the
 * weekly minimum 2.5h a day too LOW, the bar stays quiet, and the database then
 * refuses the submission with a figure the screen never mentioned.
 *
 * ⚠️ A MISSING ROW COUNTS AS A FALLBACK JUST AS MUCH AS A FAILED READ DOES.
 * `maybeSingle` reports no error for zero rows, so testing the error alone would
 * call the singleton's disappearance a successful read of 60.
 */
export async function readAppSettings(
  client: TimesheetReadClient,
): Promise<{ graceMinutes: number; breakMinutes: number; fellBack: boolean }> {
  try {
    const row = await read<unknown>(
      client
        .from("vizserve_pms_app_settings")
        .select("grace_minutes, break_minutes")
        .maybeSingle(),
    );

    /* A missing ROW is the same answer as a failed read and takes the same
       branch — see the header. */
    if (row === null) return fallbackSettings();

    const parsed = parse(appSettingsRowSchema, row, "the company settings");
    return {
      graceMinutes: parsed.grace_minutes,
      breakMinutes: parsed.break_minutes,
      fellBack: false,
    };
  } catch {
    /*
     * ⚠️ THE ONE READ IN THIS FILE THAT CATCHES ITS OWN FAILURE, and it is the
     * server contract kept rather than a shortcut. `loadAppSettings` has never
     * thrown, deliberately: the punch panel renders on `/`, `/dashboard` and
     * `/dtr` and reads `graceMinutes` for an advisory late marker, so a settings
     * wobble taking out three screens for one decoration is the wrong trade in
     * every direction. Making this throw would have done exactly that — the
     * panel and the DTR both read it.
     *
     * It is NOT a `?? []`. The degrade is REPORTED, through `fellBack`, and the
     * one caller that turns the break into a THRESHOLD it shows somebody
     * withholds the whole claim when it is set. See `resolveScheduledWeek`.
     */
    return fallbackSettings();
  }
}

/** The migration's own column defaults. If these and it disagree, it wins. */
function fallbackSettings() {
  return {
    graceMinutes: DEFAULT_GRACE_MINUTES,
    breakMinutes: DEFAULT_BREAK_MINUTES,
    fellBack: true,
  };
}

/* -------------------------------------------------------------------------- */
/* `qk.loggableTasks()` — the picker's first page.                             */
/* -------------------------------------------------------------------------- */

export type LoggableTasks = {
  tasks: LoggableTaskRow[];
  /** The List filter's options: lists this person actually has work in. */
  listIds: string[];
  /**
   * ⚠️ PARTIAL, AND SAID SO RATHER THAN THROWN. `loadLoggableTasks` reads the
   * PIC/QA half and the assignee half separately and treats one failure as a
   * narrower picker rather than as no picker — somebody who is the PIC on things
   * can still log against them. The sentence reaches the banner above the grid,
   * which is where the RSC put it. Both halves failing is a genuine error and
   * comes back as `tasks: []` with this set.
   */
  error: string | null;
};

/**
 * ⚠️ THE SCOPE RULE IS NOT IN THIS FILE AND MUST NOT BE COPIED INTO IT.
 * `lib/timesheet-tasks.ts` owns it — `vizserve_pms_is_on_task`, which is what
 * `vizserve_pms_may_log_time` enforces on write — and it is shared with the
 * picker's search action so the list cannot go back to disagreeing with the
 * insert about who is on a task. That module was split out of a `server-only`
 * one in P12-23 for exactly this call.
 */
export async function fetchLoggableTasks(
  client: TimesheetReadClient,
  userId: string,
): Promise<LoggableTasks> {
  const [loggable, listIds] = await Promise.all([
    loadLoggableTasks(client, userId),
    loadLoggableTaskLists(client, userId),
  ]);

  return {
    tasks: parseAll(loggableTaskSchema, loggable.tasks, "the tasks you can log against"),
    listIds,
    error: loggable.error,
  };
}

/* -------------------------------------------------------------------------- */
/* `qk.teamWeekVisible(weekStart)` — the lead's week.                          */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ THE ROW SHAPES ARE `team-week-grid.tsx`'S OWN AND ARE DELIBERATELY NOT
 * RE-DECLARED HERE. That component owns every column of the grid and both types
 * travel with them; a second declaration is the one place a dropped field could
 * hide. Type-only imports of a `"use client"` module are erased at compile time,
 * so this contributes no runtime edge — the same reach `lib/dtr-server.ts` makes
 * for `PunchState`.
 */
export type { TeamRow, TeamTaskRow } from "@/app/(app)/timesheet/team/team-week-grid";

export type TeamWeek = {
  rows: TeamRow[];
  /**
   * P8-07 — false when the DTR read failed. The grid stops printing "no punch"
   * in fourteen cells, because a dead read must not read as "nobody punched".
   */
  punchesLoaded: boolean;
  /** What the DTR read said when it failed. Printed in the banner, never hidden. */
  punchesError: string | null;
  /** Drives the "the company break setting could not be loaded" banner. */
  settingsFellBack: boolean;
};

/**
 * ⚠️ THE GRID, NOT THE ROWS, AND THIS IS THE OPPOSITE CALL FROM `fetchTimesheetWeek`.
 *
 * The member's week is TYPED INTO, so its cache entry has to hold entries an
 * `onMutate` can patch. Nothing on the team grid edits an hour: the only write
 * is a decision on a WEEK, which `patchTeamWeekDecision` moves by finding the
 * row with that `weekId`. So the derivation — six lookups keyed together, a
 * break resolved per person, punches adjusted, leave expanded — runs once here
 * rather than on every render of a screen a lead scrolls.
 *
 * NO DEPARTMENT FILTER ON ANY QUERY. Every table below scopes by policy through
 * the person the row belongs to, and restating the filter would imply the policy
 * is optional — it is the only thing standing between one lead and another
 * lead's team.
 */
export async function fetchTeamWeek(
  client: TimesheetReadClient,
  params: { monday: string },
): Promise<TeamWeek> {
  const days = weekDates(params.monday);
  const monday = params.monday;
  const lastDay = days[days.length - 1]!;

  const [
    entryRows,
    weekRows,
    overtimeRows,
    leaveRows,
    peopleRows,
    punchRows,
    departmentRows,
    listRows,
    groupRows,
    settings,
  ] = await Promise.all([
    /*
     * Every entry the policy will show this lead, for this week — and P8-07,
     * WHAT THE HOURS WENT TO. A total with no breakdown is the rubber stamp
     * this page exists to prevent.
     *
     * ⚠️ THE EMBED IS LEFT, NOT `!inner`, for the reason stated on the member's
     * own week above. An inner join turns "I cannot see that task" into "that
     * row does not exist" and takes a person's whole week with it.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_timesheet_entries")
        .select(
          "id, user_id, task_id, work_date, minutes, note, started_at, ended_at, vizserve_pms_tasks(title, status, list_id, department_id)",
        )
        .gte("work_date", monday)
        .lte("work_date", lastDay),
    ),

    read<unknown[]>(
      client
        .from("vizserve_pms_timesheet_weeks")
        .select("id, user_id, status, submitted_minutes, submitted_at, decision_reason")
        .eq("week_start", monday),
    ),

    // The team's approved overtime, not just the viewer's. This widens from the
    // member's page with NO policy change: the SELECT policy on internal
    // requests already returns `requester_id = auth.uid() or
    // vizserve_pms_manages_department(department_id)`.
    read<unknown[]>(
      client
        .from("vizserve_pms_internal_requests")
        .select("id, requester_id, work_date, overtime_minutes")
        .eq("request_type", "OVERTIME")
        .eq("status", "APPROVED")
        .gte("work_date", monday)
        .lte("work_date", lastDay),
    ),

    /*
     * P7-10 — who was away.
     *
     * WITHOUT THIS THE PAGE LIBELS PEOPLE. Slice C refuses to submit an empty
     * week, so a person on approved leave all week has no week row at all — and
     * on this grid that is indistinguishable from somebody who has simply not
     * filed. A lead would chase someone who was on holiday.
     *
     * The function returns name and dates and no reason and no type, so the grid
     * can say "on leave" and nothing more. That is all a lead needs and all they
     * are entitled to.
     */
    read<unknown[]>(
      client.rpc("vizserve_pms_leave_calendar", { p_from: monday, p_to: lastDay }),
    ),

    /*
     * Names, and — P8-07 — each person's unpaid break.
     *
     * ⚠️ NO `is_active` FILTER, AND THAT IS DELIBERATE. This is a LOOKUP: the
     * row set below is built from entries, weeks, leave and punches, never from
     * here, so filtering only ever removes a name and a break from somebody
     * whose rows are on the grid regardless. A person deactivated part-way
     * through the week is exactly that case, and it is the week a lead most
     * needs to read. RLS still scopes this to the caller's own department.
     */
    read<unknown[]>(client.from("vizserve_pms_users").select("id, full_name, break_minutes")),

    /*
     * P8-07 — what the clock says, beside what the timesheet says.
     *
     * ⚠️ A READ, NOT A RELATION. There is deliberately no foreign key or
     * derivation between the DTR and the timesheet: the DTR owns "when somebody
     * was at work", the timesheet owns "where the day went", and two tables
     * claiming the same fact will disagree. This shows both figures and names
     * the difference; nothing downstream may treat the gap as an error.
     *
     * ⚠️ NO EMBED OF `vizserve_pms_users` HERE. That table has TWO foreign keys
     * into it from this one — `user_id` and `corrected_by` — and an unqualified
     * embed is refused by PostgREST every time. It shipped once as "DTR is
     * empty", because the page swallowed the error with `data ?? []`. Names come
     * from the people read above, which needs no embed at all.
     */
    /*
     * ⚠️ `tolerate`, AND IT IS THE FIFTH AND LAST EXCEPTION IN THIS FILE. The
     * punch comparison is an ADDITION to a review whose job is the hours: "the
     * hours themselves loaded, and withholding the whole review because one
     * comparison failed would be the worse trade" is the RSC's own wording and
     * it stands. What must not happen is the other degrade — `data ?? []` here
     * would put an EMPTY punch record beside a full week of logged hours, which
     * is an accusation the page has no evidence for. So the failure travels as
     * `punchesLoaded: false`, the banner prints the message, and the grid stops
     * writing "no punch" in fourteen cells.
     */
    tolerate(
      read<unknown[]>(
        client
          .from("vizserve_pms_dtr_entries")
          .select("user_id, work_date, time_in, time_out")
          .gte("work_date", monday)
          .lte("work_date", lastDay),
      ),
    ),

    /*
     * P8-08 — WHERE the work sat: department, folder, list. A reviewer reading
     * "Client QA · 7h" had no way to tell WHICH Client QA it was.
     *
     * ⚠️ THREE SMALL LOOKUPS, NOT A DEEPER EMBED, for the reason the member's
     * week gives: hanging two more levels off the entries embed buries the LEFT
     * join guard in a select string nobody should have to squint at.
     */
    read<unknown[]>(client.from("vizserve_pms_departments").select("id, name")),
    read<unknown[]>(client.from("vizserve_pms_lists").select("id, name, group_id")),
    read<unknown[]>(client.from("vizserve_pms_task_groups").select("id, name")),

    /* Degrades rather than throwing, and says so through `fellBack` — which is
       the only thing this page trusts it for. See `readAppSettings`. */
    readAppSettings(client),
  ]);

  const entries = parseAll(teamEntryRowSchema, entryRows, "this week's entries");
  const weeks = parseAll(teamWeekRowSchema, weekRows, "submitted weeks");
  const overtimeAll = parseAll(teamOvertimeRowSchema, overtimeRows, "approved overtime");
  const leaveSpans = parseAll(leaveCalendarRowSchema, leaveRows, "approved leave");
  const people = parseAll(personBreakRowSchema, peopleRows, "people");
  const punches =
    punchRows.data === null ? [] : parseAll(punchRowSchema, punchRows.data, "punched hours");
  const departments = parseAll(namedRowSchema, departmentRows, "departments");
  const lists = parseAll(namedListRowSchema, listRows, "lists");
  const groups = parseAll(namedRowSchema, groupRows, "folders");

  const settingsFellBack = settings.fellBack;
  const companyBreak = settings.breakMinutes;

  const nameOf = new Map(people.map((row) => [row.id, row.full_name]));

  /*
   * P8-07 — each person's resolved unpaid break, or null when it is not known.
   *
   * ⚠️ `??` AND NOT `||`: a person whose break is deliberately 0 must keep their
   * 0, and `||` would hand them the company hour and quietly take an hour a day
   * off their punched figure. This is `coalesce(u.break_minutes, s.break_minutes)`
   * in TypeScript.
   *
   * ⚠️ NULL WHEN THE COMPANY SETTING FELL BACK. Deducting 60 that nobody read,
   * and then telling a lead somebody was "2h more on the clock than on the
   * timesheet", is asserting a figure this page never obtained. Anyone with
   * their OWN break is unaffected: that figure was read.
   */
  const breakOf = new Map<string, number | null>(
    people.map((row) => [row.id, row.break_minutes ?? (settingsFellBack ? null : companyBreak)]),
  );

  const departmentName = new Map(departments.map((row) => [row.id, row.name]));
  const listRow = new Map(lists.map((row) => [row.id, row]));
  const groupName = new Map(groups.map((row) => [row.id, row.name]));

  /**
   * P8-08 — "Marketing / Campaigns / Client QA", or as much of it as resolves.
   *
   * ⚠️ EVERY PART IS OPTIONAL AND A MISSING PART IS DROPPED, NEVER PLACEHOLDERED.
   * A list with no folder is a ClickUp "Folderless List" and is the state of
   * every list made before P7-18, so a rendered "—" in the middle would be
   * decorating the ordinary case as a fault.
   */
  const whereTaskSat = (task: { list_id: string | null; department_id: string | null }): string => {
    const list = task.list_id ? listRow.get(task.list_id) : null;

    return [
      task.department_id ? departmentName.get(task.department_id) : null,
      list?.group_id ? groupName.get(list.group_id) : null,
      list?.name ?? null,
    ]
      .filter(Boolean)
      .join(" / ");
  };

  // Minutes per person per day — the collapsed grid.
  const cells = new Map<string, Record<string, number>>();
  // Person → task → the task's row, with its entries filed under the day they
  // were logged on. Built in one pass over the same entries the totals come
  // from, so the breakdown and the total cannot disagree about a day.
  const tasksByUser = new Map<string, Map<string, TeamTaskRow>>();

  for (const entry of entries) {
    const row = cells.get(entry.user_id) ?? {};
    row[entry.work_date] = (row[entry.work_date] ?? 0) + entry.minutes;
    cells.set(entry.user_id, row);

    const byTask = tasksByUser.get(entry.user_id) ?? new Map<string, TeamTaskRow>();
    let task = byTask.get(entry.task_id);

    if (!task) {
      task = {
        taskId: entry.task_id,
        /*
         * ⚠️ THE ROW STAYS EVEN WHEN THE EMBED CAME BACK NULL. That is the whole
         * reason the embed is a LEFT join: a task reassigned away from this lead
         * — or deleted — must not delete somebody's hours from the review.
         */
        title: entry.vizserve_pms_tasks?.title ?? "Task no longer visible to you",
        status: entry.vizserve_pms_tasks?.status ?? null,
        /*
         * ⚠️ EMPTY WHEN THE EMBED CAME BACK NULL, and it must stay empty. There
         * is no task row to ask where it sat, and guessing from the person's own
         * department would be putting a location on hours whose work this viewer
         * is explicitly not allowed to see.
         */
        where: entry.vizserve_pms_tasks ? whereTaskSat(entry.vizserve_pms_tasks) : "",
        cells: {},
      };
      byTask.set(entry.task_id, task);
    }

    (task.cells[entry.work_date] ??= []).push({
      id: entry.id,
      minutes: entry.minutes,
      note: entry.note,
      started_at: entry.started_at ? entry.started_at.slice(0, 5) : null,
      ended_at: entry.ended_at ? entry.ended_at.slice(0, 5) : null,
    });

    tasksByUser.set(entry.user_id, byTask);
  }

  /*
   * P8-07 — punched minutes per person per day.
   *
   * ⚠️ THREE STATES, NOT TWO, and flattening them is the bug this guards
   * against. A key with a number is a closed shift. A key with NULL is a day
   * punched in and never out — `workedMinutes` refuses to guess its length, and
   * so does this. A key that is ABSENT is a day nobody punched at all, which is
   * not the same statement as "punched and worked nothing" and must never render
   * as 0 beside somebody's logged hours.
   *
   * ⚠️ RAW SPANS AT THIS POINT, AND RAW SPANS ARE NOT COMPARABLE TO LOGGED
   * HOURS. `workedMinutes` is the whole distance between the two punches, break
   * and all; a timesheet minute is working time. `breakAdjustedPunches` is what
   * makes the two figures the same kind of number, and NOTHING may reach the
   * grid without going through it.
   */
  const spans = new Map<string, Record<string, number | null>>();
  for (const row of punches) {
    const byDay = spans.get(row.user_id) ?? {};
    byDay[row.work_date] = workedMinutes(row.time_in, row.time_out);
    spans.set(row.user_id, byDay);
  }

  const punched = new Map<string, Record<string, number | null> | null>();
  for (const [userId, byDay] of spans) {
    punched.set(
      userId,
      breakAdjustedPunches({ punched: byDay, breakMinutes: breakOf.get(userId) ?? null }),
    );
  }

  /*
   * Approved overtime per person per day — the requests, not just their total.
   *
   * ⚠️ THE IDS ARE ONLY OFFERED AS LINKS BECAUSE THIS READ IS POLICY-SCOPED. A
   * lead who may not read somebody's overtime request gets no row for it here
   * and therefore no link to a page that would refuse them — the day simply
   * keeps the plain 480 threshold.
   */
  const overtime = new Map<string, Record<string, OvertimeApproval[]>>();
  for (const row of overtimeAll) {
    if (!row.work_date) continue;
    const byDay = overtime.get(row.requester_id) ?? {};
    (byDay[row.work_date] ??= []).push({ id: row.id, minutes: row.overtime_minutes ?? 0 });
    overtime.set(row.requester_id, byDay);
  }

  // Leave days per person. Expanded from spans to individual dates here so the
  // grid can ask a flat question per cell.
  const leave = new Map<string, Set<string>>();
  for (const span of leaveSpans) {
    const taken = leave.get(span.user_id) ?? new Set<string>();
    for (const day of days) {
      if (day >= span.start_date && day <= span.end_date) taken.add(day);
    }
    leave.set(span.user_id, taken);
  }

  const weekByUser = new Map(weeks.map((row) => [row.user_id, row]));

  // Everyone the lead can see anything about this week: somebody with hours,
  // somebody with a submitted week, or somebody who was away. Built from the
  // policy-scoped results rather than from a department list, so the page shows
  // exactly what the database is willing to show and never an empty row for
  // somebody out of scope.
  const userIds = new Set<string>([
    ...cells.keys(),
    ...weekByUser.keys(),
    ...leave.keys(),
    // P8-07. Somebody who punched all week and logged nothing had no row here at
    // all, so the one case the comparison exists to surface was the one case the
    // page could not show.
    ...punched.keys(),
  ]);

  const rows: TeamRow[] = [...userIds]
    .map((userId) => {
      const week = weekByUser.get(userId);
      /*
       * ⚠️ COMPARABILITY IS ASKED OF THE BREAK, NOT OF THE PUNCHES. A person
       * with no DTR rows at all still has an empty record here, and "nobody
       * punched" is a true thing to show them; what decides whether any FIGURE
       * may be put beside their logged hours is whether their break was read.
       */
      const comparable = typeof breakOf.get(userId) === "number";
      const adjusted = punched.get(userId) ?? null;

      return {
        userId,
        name: nameOf.get(userId) ?? "Someone no longer active",
        cells: cells.get(userId) ?? {},
        overtime: overtime.get(userId) ?? {},
        leaveDays: [...(leave.get(userId) ?? [])],
        // Alphabetical, like the member's own grid — first-logged-first would
        // reorder the breakdown under the reviewer's cursor between refreshes.
        tasks: [...(tasksByUser.get(userId)?.values() ?? [])].sort((a, b) =>
          a.title.localeCompare(b.title),
        ),
        // Empty is "no DTR rows this week", which the grid says out loud as "no
        // punch". The flag is separate and is the thing that stops a settings
        // failure turning into an accusation.
        punched: adjusted ?? {},
        punchesComparable: comparable,
        weekId: week?.id ?? null,
        status: week?.status ?? null,
        submittedMinutes: week?.submitted_minutes ?? null,
        decisionReason: week?.decision_reason ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    rows,
    punchesLoaded: !punchRows.failed,
    punchesError: punchRows.message,
    settingsFellBack,
  };
}
