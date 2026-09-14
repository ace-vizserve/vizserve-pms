import type { LeavePortion } from "@/lib/leave";
import { deviation, effectiveEnd, scheduleFor, DEFAULT_GRACE_MINUTES } from "@/lib/dtr-schedule";

/**
 * P7-52 — the attendance roll-up behind `/hr/attendance`.
 *
 * ⚠️ "ABSENT" WAS NOT DEFINED ANYWHERE IN THIS CODEBASE BEFORE THIS FILE, and
 * that is worth saying out loud rather than burying. `lib/dtr-schedule.ts`
 * defines LATE precisely — a time-in past the scheduled start by more than the
 * grace — and the DTR screen shows it per row. Nothing had ever had to answer
 * "how many days was this person absent", so the answer is a decision made
 * here, and every consumer of this file inherits it. It is stated on the screen
 * too, for the same reason the audit PDF prints its rules: a count that gets
 * compared against somebody's manual tally is useless unless both say what they
 * counted.
 *
 * THE DEFINITION, in full:
 *
 *   A day counts as a WORKING DAY for a person when it is a weekday, is not a
 *   proclaimed holiday, and falls inside the period. Weekends and holidays are
 *   nobody's absence — the same rule `vizserve_pms_leave_days` uses to decide
 *   what a leave request consumes, so the two cannot disagree.
 *
 *   ABSENT is a working day with NO DTR entry and NO approved leave.
 *
 *   ON LEAVE is counted SEPARATELY and is never absence. A person on approved
 *   leave is accounted for; folding the two together would make the one number
 *   HR looks at — unexplained absence — impossible to read.
 *
 *   LATE is a time-in deviation past the grace, and UNDERTIME a time-out before
 *   the effective end by more than the grace. Both reuse `deviation()` rather
 *   than restating the arithmetic, and both honour approved overtime through
 *   `effectiveEnd`, so a day that ran long is not also counted short.
 *
 * ⚠️ SOMEBODY WITH NO SCHEDULE IS NEVER LATE, NEVER UNDERTIME AND NEVER ABSENT.
 * `work_start`/`work_end` are nullable and NULL is a supported state, not
 * missing data — plenty of people here work no fixed hours. Judging them
 * against a start time nobody set would invent lateness, and counting a day
 * they did not punch as an absence would invent that too. They appear in the
 * roll-up with their days marked `unscheduled`, so they are visibly present and
 * visibly not being counted, rather than silently dropped.
 */

export type AttendanceDay = {
  /** `YYYY-MM-DD`. */
  date: string;
  /** The DTR row for this person and day, if there is one. */
  timeIn: string | null;
  timeOut: string | null;
  hasEntry: boolean;
  /**
   * How much of the day approved leave covers, or null for none.
   *
   * ⚠️ WAS `onLeave: boolean`, AND THE BOOLEAN WAS WRONG TWICE OVER. A morning
   * half day counted as a whole day of leave, and — because leave short-circuits
   * the checks below — the AFTERNOON the person actually worked was never judged
   * for lateness or undertime. The screen feeding this did not even select the
   * halves; `lib/leave-server.ts` is why every caller now does.
   */
  leavePortion: LeavePortion | null;
  isHoliday: boolean;
  /** Approved overtime for the day, in minutes. Extends the END only. */
  overtimeMinutes: number;
};

export type AttendancePerson = {
  userId: string;
  fullName: string;
  departmentName: string | null;
  workStart: string | null;
  workEnd: string | null;
  days: AttendanceDay[];
};

export type AttendanceSummary = {
  userId: string;
  fullName: string;
  departmentName: string | null;
  /** True when no schedule is recorded — every count below is then zero. */
  unscheduled: boolean;
  workingDays: number;
  /**
   * ⚠️ THESE THREE CAN CARRY A `.5`, and the halves are why.
   *
   * A day is one unit split between them: a morning off that is then worked is
   * 0.5 leave and 0.5 present. That is what keeps `present + onLeave + absent`
   * summing to `workingDays` — the property the old day-granular version was
   * protecting and lost the moment a half day appeared, because it spent the
   * whole day on leave and never counted the worked half at all.
   *
   * ⚠️ ANYTHING RENDERING THESE MUST NOT `Math.round`. That puts the original
   * overstatement straight back.
   *
   * `late` and `undertime` below are NOT fractional: they count events, not
   * days. Arriving late on a half day is one late arrival.
   */
  present: number;
  onLeave: number;
  absent: number;
  late: number;
  undertime: number;
  /** Total minutes late across the period. The count says how often; this, how badly. */
  lateMinutes: number;
};

/** Saturday or Sunday, from the string parts — never through `Date` parsing. */
function isWeekend(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function summariseAttendance(
  people: AttendancePerson[],
  graceMinutes: number = DEFAULT_GRACE_MINUTES,
): AttendanceSummary[] {
  return people.map((person) => {
    const schedule = scheduleFor({
      work_start: person.workStart,
      work_end: person.workEnd,
    });

    // `scheduleFor` treats half a schedule as no schedule — a start with no end
    // cannot decide undertime and an end with no start cannot decide lateness,
    // and a person judged on one of the two would be counted against a rule
    // nobody set for them.
    const unscheduled = !schedule.workStart || !schedule.workEnd;

    const summary: AttendanceSummary = {
      userId: person.userId,
      fullName: person.fullName,
      departmentName: person.departmentName,
      unscheduled,
      workingDays: 0,
      present: 0,
      onLeave: 0,
      absent: 0,
      late: 0,
      undertime: 0,
      lateMinutes: 0,
    };

    for (const day of person.days) {
      if (day.isHoliday || isWeekend(day.date)) continue;

      summary.workingDays += 1;

      /*
       * Leave first, because it is the only thing that excuses an empty day.
       *
       * ⚠️ A HALF DAY NO LONGER WINS THE WHOLE DAY. It used to: the roll-up
       * added 1 and `continue`d, so somebody who took the morning off and then
       * went home two hours early was neither counted for the leave they took
       * nor checked for the undertime they took after it.
       *
       * A FULL day still short-circuits — there is nothing left to judge. A
       * HALF day books 0.5 and falls through, and `share` below is what keeps
       * the remaining half from being counted as a whole day present or absent.
       */
      const portion = day.leavePortion;

      if (portion === "full") {
        summary.onLeave += 1;
        continue;
      }

      /** What is left of this day after leave has taken its part. */
      const share = portion ? 0.5 : 1;

      if (portion) summary.onLeave += 0.5;

      if (!day.hasEntry) {
        // Unscheduled people are not marked absent — see the header. The day
        // still counts as a working day, so the columns visibly do not sum,
        // which is honest: nothing is known about it.
        if (!unscheduled) summary.absent += share;
        continue;
      }

      summary.present += share;

      if (unscheduled) continue;

      const late = deviation("in", day.timeIn, schedule.workStart, graceMinutes);
      if (late) {
        summary.late += 1;
        summary.lateMinutes += late.minutes;
      }

      // Approved overtime moves the target END, so a day that was agreed to run
      // long is not then counted as leaving early against the ordinary end.
      const end = effectiveEnd(schedule.workEnd, day.overtimeMinutes);
      const out = deviation("out", day.timeOut, end, graceMinutes);
      // NEGATIVE ONLY. `deviation` reports both directions on the way out;
      // leaving LATE is not undertime, and counting it as a deviation of any
      // kind here would make the column mean "the clock-out was unusual"
      // rather than "the person went home early".
      if (out && out.minutes < 0) summary.undertime += 1;
    }

    return summary;
  });
}
