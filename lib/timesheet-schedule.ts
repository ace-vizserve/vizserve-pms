import { scheduledDayMinutes } from "@/lib/dtr-schedule";
import { expandLeaveDays, leaveKey, type LeaveSpan } from "@/lib/leave";
import { scheduledWeekMinutes } from "@/lib/schemas/timesheet";

/**
 * P8-05 — "what was this week supposed to come to", as one rule.
 *
 * WHY THIS FILE EXISTS. The arithmetic lived inside `/timesheet`'s page
 * component, which was fine while `/timesheet` was the only screen that made
 * the claim. The dashboard then wanted the same figure and reached for
 * `STANDARD_DAY_MINUTES * 5` instead — a 40-hour week this codebase has
 * deliberately never defined (`lib/dates.ts:417-419`: a weekly constant would
 * mean deciding whether Saturday counts, and nobody has answered that). So the
 * strip told every person in the company they owed 40 hours, including the
 * part-timers, including the week with a public holiday in it.
 *
 * The fix is not to copy the page's arithmetic into the dashboard. THREE COPIES
 * OF THIS RULE IS HOW TWO SCREENS START DISAGREEING ABOUT SOMEBODY'S WEEK, and
 * a disagreement here is not cosmetic: `vizserve_pms_submit_timesheet_week`
 * recomputes the minimum from its own tables and REFUSES the submission below
 * it, so a screen that is wrong in the low direction stays quiet and lets the
 * database do the telling, after the button was pressed.
 *
 * PURE, AND SEPARATE FROM THE READS ON PURPOSE. `lib/timesheet-schedule-server.ts`
 * is the four queries and nothing else — the same division
 * `lib/pending-requests-server.ts` and `lib/dtr-server.ts` follow — which is
 * what lets every exemption below be pinned by a unit test with no database in
 * sight.
 *
 * THE DATABASE REMAINS THE AUTHORITY. Nothing here can let a short week through.
 * A disagreement shows up as a screen that said "fine" and a submission that was
 * refused, which is annoying and safe, rather than the reverse.
 */

/** What the four reads produced, errors and all. Nothing here is optional. */
export type ScheduleReads = {
  /** Whose week. `expandLeaveDays` keys its days by person, so it is needed. */
  userId: string;
  /**
   * The week's dates, Monday first — `weekDates(startOfWeek(...))`.
   *
   * ⚠️ MONDAY-FIRST IS LOAD-BEARING. `days.slice(0, 5)` below IS the weekend
   * test, and it is only a weekend test because `weekDates` is built from
   * `startOfWeek`, which `vizserve_pms_timesheet_weeks_monday` constrains to be
   * Monday-anchored. No date parsing, and therefore no timezone to get wrong.
   */
  days: string[];
  /** The user row, or null when it failed or the row is missing. */
  profile: { work_start: string | null; work_end: string | null; break_minutes: number | null } | null;
  profileError: boolean;
  /** `holiday_date`s proclaimed inside the week. */
  holidays: string[];
  holidaysError: boolean;
  /** Approved LEAVE spans OVERLAPPING the week — not contained by it. */
  leave: LeaveSpan[];
  leaveError: boolean;
  /** `vizserve_pms_app_settings.break_minutes`, or the fallback. */
  companyBreakMinutes: number;
  /** True when the figure above is `loadAppSettings`' fallback, not the row. */
  settingsFellBack: boolean;
};

export type ScheduledWeek = {
  /**
   * Null when this person is EXEMPT (no schedule, a schedule the break
   * swallows, or a week that expected nothing of them) *or* when a read
   * failed. `readFailure` is what tells those two apart — callers that only
   * need "may I state a figure" can ignore it.
   */
  scheduledWeek: { expectedDays: number; minimumMinutes: number } | null;
  /**
   * Which read failed, in the words a banner says. Null when all four arrived.
   */
  readFailure: string | null;
};

/**
 * The week's minimum, or a refusal to state one.
 *
 * ⚠️ NO MINIMUM WHEN WE COULD NOT WORK ONE OUT — and note which way the error
 * pushes it. Holidays and leave only ever SUBTRACT, so a failed read does not
 * degrade the figure gracefully, it INFLATES it: a week with one holiday in it
 * would demand 2400 minutes instead of 1920, and the screen would tell somebody
 * they are eight hours short of a week the database will accept without a
 * murmur. A warning that is wrong in the direction of accusing somebody of
 * under-logging is worse than no warning, so the whole claim is withheld.
 *
 * FOUR INPUTS, NOT TWO. The profile row and the settings row fail the same way:
 *
 *   - a failed profile read leaves the day computed from `{}`, which is null and
 *     therefore SILENT — and silently dropping the check is exactly what the
 *     caller's banner exists to say out loud.
 *   - `loadAppSettings` never throws by design (three other screens depend on
 *     that), so a failed read arrives as the fallback 60. If the company break is
 *     really 30 the minimum comes out 2.5h A DAY too LOW, the screen stays quiet,
 *     and the database then refuses the submission with a figure nobody mentioned.
 *     `fellBack` is how that read owns up.
 *
 * The rule is one line: never state a minimum derived from a value that was not
 * actually read.
 */
export function resolveScheduledWeek(reads: ScheduleReads): ScheduledWeek {
  const readFailure = reads.holidaysError
    ? "Holidays"
    : reads.leaveError
      ? "Approved leave"
      : reads.profileError
        ? "Your working hours"
        : /* ⚠️ ONLY WHEN THIS PERSON ACTUALLY INHERITS IT. The break below is
             `break_minutes ?? company`, and the SQL says the same thing with
             `coalesce(u.break_minutes, s.break_minutes)` — so somebody carrying
             their own break never touched the company figure, and a failed
             settings read tells us nothing about their week. Withholding it from
             them anyway would leave the database computing a minimum and
             refusing the week in silence, which is the exact surprise this whole
             block exists to prevent. `== null` catches undefined too, and a
             deliberate 0 is a real break that keeps its own branch. */
          reads.profile?.break_minutes == null && reads.settingsFellBack
          ? "The company break setting"
          : null;

  if (readFailure !== null) return { scheduledWeek: null, readFailure };

  /*
   * ⚠️ THE BREAK IS RESOLVED HERE AND NOWHERE ELSE, because this is the only
   * place both rows are in hand. `?? companyBreakMinutes` and not
   * `|| companyBreakMinutes`: a person whose break is deliberately 0 must keep
   * their 0, and `||` would quietly hand them the company hour and demand an
   * hour a day less of them than their schedule actually says.
   */
  const dayMinutes = scheduledDayMinutes(
    reads.profile ?? {},
    reads.profile?.break_minutes ?? reads.companyBreakMinutes,
  );

  const holidays = new Set(reads.holidays);

  const monday = reads.days[0] ?? "";
  const lastDay = reads.days[reads.days.length - 1] ?? monday;
  const leaveByDay = expandLeaveDays(reads.leave, monday, lastDay);

  /*
   * Working days in the week, and the approved leave sitting on them.
   *
   * A half day of leave removes half a day of expectation, and only ever from a
   * day that was counted in the first place — the loop never deducts a half on a
   * day it did not add.
   *
   * ⚠️ THE DEDUPLICATION IS `expandLeaveDays`, AND IT IS LOAD-BEARING. This
   * counts DAYS, not requests: two approved LEAVE rows both covering Wednesday
   * subtract one day, because a person is absent on a day rather than absent
   * twice. `vizserve_pms_submit_timesheet_week` used to sum per request, so it
   * subtracted that Wednesday twice and asked for 960 minutes where the screen
   * asked for 1440 — a false "you are short" on a week Postgres accepts. The SQL
   * now walks the week's own dates the same way this loop does.
   */
  let workingDays = 0;
  let leaveDays = 0;

  for (const day of reads.days.slice(0, 5)) {
    if (holidays.has(day)) continue;
    workingDays += 1;

    const leave = leaveByDay.get(leaveKey(reads.userId, day));
    if (leave) leaveDays += leave.portion === "full" ? 1 : 0.5;
  }

  return {
    scheduledWeek: scheduledWeekMinutes({
      scheduledDayMinutes: dayMinutes,
      workingDays,
      leaveDays,
    }),
    readFailure: null,
  };
}
