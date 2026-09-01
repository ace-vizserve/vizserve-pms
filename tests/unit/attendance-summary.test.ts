import { describe, expect, it } from "vitest";

import {
  summariseAttendance,
  type AttendanceDay,
  type AttendancePerson,
} from "@/lib/attendance-summary";

/**
 * P7-52 — the attendance roll-up.
 *
 * This file exists mostly to pin ONE decision: what "absent" means. Nothing in
 * the codebase defined it before `lib/attendance-summary.ts`, so the definition
 * is a choice rather than a derivation, and a choice nobody wrote a test for is
 * a choice that quietly changes.
 */

// March 2026: the 2nd is a Monday, the 7th/8th a weekend.
const MON = "2026-03-02";
const TUE = "2026-03-03";
const WED = "2026-03-04";
const SAT = "2026-03-07";
const SUN = "2026-03-08";

function day(date: string, overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  return {
    date,
    timeIn: null,
    timeOut: null,
    hasEntry: false,
    onLeave: false,
    isHoliday: false,
    overtimeMinutes: 0,
    ...overrides,
  };
}

/** A punch at a Manila wall-clock time on the given day. */
function at(date: string, time: string): string {
  return `${date}T${time}:00+08:00`;
}

function person(overrides: Partial<AttendancePerson> = {}): AttendancePerson {
  return {
    userId: "u1",
    fullName: "Test Person",
    departmentName: "VizBytes",
    workStart: "09:00",
    workEnd: "18:00",
    days: [],
    ...overrides,
  };
}

function summarise(p: AttendancePerson, grace = 5) {
  return summariseAttendance([p], grace)[0];
}

describe("summariseAttendance — what counts as a working day", () => {
  it("ignores weekends entirely", () => {
    const result = summarise(person({ days: [day(SAT), day(SUN)] }));

    expect(result.workingDays).toBe(0);
    expect(result.absent).toBe(0);
  });

  it("ignores holidays, even on a weekday", () => {
    // The same rule `vizserve_pms_leave_days` uses. If these two disagreed, a
    // day would be an absence here and not a leave day there.
    const result = summarise(person({ days: [day(MON, { isHoliday: true })] }));

    expect(result.workingDays).toBe(0);
    expect(result.absent).toBe(0);
  });
});

describe("summariseAttendance — absent", () => {
  it("counts a working day with no entry and no leave", () => {
    const result = summarise(person({ days: [day(MON), day(TUE)] }));

    expect(result.workingDays).toBe(2);
    expect(result.absent).toBe(2);
    expect(result.present).toBe(0);
  });

  it("does NOT count approved leave as absence", () => {
    // ⚠️ The decision this file exists for. A person on approved leave is
    // accounted for; folding the two together would make the one figure HR
    // actually looks at — unexplained absence — unreadable.
    const result = summarise(person({ days: [day(MON, { onLeave: true }), day(TUE)] }));

    expect(result.onLeave).toBe(1);
    expect(result.absent).toBe(1);
  });

  it("counts leave over a punch, so the columns still sum", () => {
    // A half day of leave where the person also punched in. Counted once, as
    // leave — this roll-up counts DAYS, and counting the day twice would make
    // present + onLeave + absent exceed workingDays.
    const result = summarise(
      person({
        days: [day(MON, { onLeave: true, hasEntry: true, timeIn: at(MON, "13:00") })],
      }),
    );

    expect(result.onLeave).toBe(1);
    expect(result.present).toBe(0);
    expect(result.present + result.onLeave + result.absent).toBe(result.workingDays);
  });
});

describe("summariseAttendance — somebody with no schedule", () => {
  const noSchedule = { workStart: null, workEnd: null };

  it("is never absent, however many days they did not punch", () => {
    // ⚠️ NULL hours are a supported state, not missing data. Counting an
    // unpunched day against somebody who works no fixed hours would invent an
    // absence out of a schedule nobody set.
    const result = summarise(person({ ...noSchedule, days: [day(MON), day(TUE)] }));

    expect(result.unscheduled).toBe(true);
    expect(result.workingDays).toBe(2);
    expect(result.absent).toBe(0);
  });

  it("is never late, even on a punch that would be late for anyone else", () => {
    const result = summarise(
      person({
        ...noSchedule,
        days: [day(MON, { hasEntry: true, timeIn: at(MON, "11:30") })],
      }),
    );

    expect(result.late).toBe(0);
    expect(result.present).toBe(1);
  });

  it("treats HALF a schedule as no schedule", () => {
    // `scheduleFor` already does this: a start with no end cannot decide
    // undertime, and judging on one of the two counts somebody against a rule
    // nobody set for them.
    const result = summarise(
      person({
        workStart: "09:00",
        workEnd: null,
        days: [day(MON, { hasEntry: true, timeIn: at(MON, "11:30") })],
      }),
    );

    expect(result.unscheduled).toBe(true);
    expect(result.late).toBe(0);
  });
});

describe("summariseAttendance — late and undertime", () => {
  it("honours the grace and counts the minutes", () => {
    const result = summarise(
      person({
        days: [
          // 09:04 — inside a 5-minute grace, so not late.
          day(MON, { hasEntry: true, timeIn: at(MON, "09:04"), timeOut: at(MON, "18:00") }),
          // 09:20 — fifteen minutes past the grace.
          day(TUE, { hasEntry: true, timeIn: at(TUE, "09:20"), timeOut: at(TUE, "18:00") }),
        ],
      }),
    );

    expect(result.late).toBe(1);
    expect(result.lateMinutes).toBe(20);
    expect(result.present).toBe(2);
  });

  it("never counts an EARLY arrival as late", () => {
    const result = summarise(
      person({
        days: [day(MON, { hasEntry: true, timeIn: at(MON, "08:30"), timeOut: at(MON, "18:00") })],
      }),
    );

    expect(result.late).toBe(0);
    expect(result.lateMinutes).toBe(0);
  });

  it("counts leaving early as undertime and leaving late as neither", () => {
    const result = summarise(
      person({
        days: [
          day(MON, { hasEntry: true, timeIn: at(MON, "09:00"), timeOut: at(MON, "16:00") }),
          // ⚠️ Two hours PAST the end is not undertime. `deviation` reports both
          // directions on the way out; counting either as undertime would make
          // the column mean "the clock-out was unusual" rather than "went home
          // early", and somebody working late would be flagged for it.
          day(TUE, { hasEntry: true, timeIn: at(TUE, "09:00"), timeOut: at(TUE, "20:00") }),
        ],
      }),
    );

    expect(result.undertime).toBe(1);
  });

  it("does not count undertime against APPROVED overtime", () => {
    // Overtime extends the effective END, so a day agreed to run to 20:00 and
    // finished at 19:55 is on time, not two hours early against 18:00.
    const result = summarise(
      person({
        days: [
          day(WED, {
            hasEntry: true,
            timeIn: at(WED, "09:00"),
            timeOut: at(WED, "19:55"),
            overtimeMinutes: 120,
          }),
        ],
      }),
    );

    expect(result.undertime).toBe(0);
  });
});

describe("summariseAttendance — the whole shape", () => {
  it("keeps present + onLeave + absent equal to workingDays for a scheduled person", () => {
    const result = summarise(
      person({
        days: [
          day(MON, { hasEntry: true, timeIn: at(MON, "09:00"), timeOut: at(MON, "18:00") }),
          day(TUE, { onLeave: true }),
          day(WED),
          day(SAT),
        ],
      }),
    );

    expect(result.workingDays).toBe(3);
    expect(result.present).toBe(1);
    expect(result.onLeave).toBe(1);
    expect(result.absent).toBe(1);
    expect(result.present + result.onLeave + result.absent).toBe(result.workingDays);
  });

  it("summarises each person independently", () => {
    const results = summariseAttendance([
      person({ userId: "a", days: [day(MON)] }),
      person({ userId: "b", days: [day(MON, { onLeave: true })] }),
    ]);

    expect(results.map((row) => row.userId)).toEqual(["a", "b"]);
    expect(results[0].absent).toBe(1);
    expect(results[1].absent).toBe(0);
  });
});
