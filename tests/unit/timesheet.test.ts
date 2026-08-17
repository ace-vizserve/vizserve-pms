import { describe, expect, it } from "vitest";

import { formatWeekRange, formatWeekday, startOfWeek, weekDates } from "@/lib/dates";
import { fromMinutes, timesheetEntrySchema, toMinutes } from "@/lib/schemas/timesheet";

/**
 * P6-01 / P6-02 — the timesheet's pure logic.
 *
 * Two things are worth testing without a database. The week helpers, because
 * `lib/dates.ts` is where an off-by-one day hides and a week boundary is the
 * easiest one to get wrong. And the entry schema, because `task_id` being
 * required IS the feature (docs/09, Amier 33:20) — a refactor that quietly
 * makes it optional should fail here rather than in production, where the
 * symptom is untraceable hours.
 */

describe("startOfWeek — Monday, and Sunday belongs to the week that ended", () => {
  it("returns the same day when it is already a Monday", () => {
    // 2026-08-03 is a Monday.
    expect(startOfWeek("2026-08-03")).toBe("2026-08-03");
  });

  it("walks back to Monday from mid-week", () => {
    expect(startOfWeek("2026-08-06")).toBe("2026-08-03"); // Thursday
  });

  it("puts Sunday at the END of its week, not the start of the next", () => {
    // The bug this guards: getUTCDay() is 0 for Sunday, so the naive
    // `weekday - 1` sends it forward a day into the following week and a
    // Sunday's hours land on a timesheet nobody is looking at.
    expect(startOfWeek("2026-08-09")).toBe("2026-08-03");
  });

  it("crosses a month boundary", () => {
    // 2026-08-01 is a Saturday, so its Monday is in July.
    expect(startOfWeek("2026-08-01")).toBe("2026-07-27");
  });

  it("returns null for something that is not a date", () => {
    expect(startOfWeek("banana")).toBeNull();
  });
});

describe("weekDates", () => {
  it("returns seven consecutive days, Monday first", () => {
    expect(weekDates("2026-08-06")).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
  });

  it("gives the same week for every day in it", () => {
    const fromMonday = weekDates("2026-08-03");
    for (const day of fromMonday) {
      expect(weekDates(day)).toEqual(fromMonday);
    }
  });
});

describe("formatWeekday — reads the calendar date, not the server's zone", () => {
  it("names the weekday", () => {
    expect(formatWeekday("2026-08-03")).toBe("Mon");
    expect(formatWeekday("2026-08-09")).toBe("Sun");
  });
});

describe("formatWeekRange", () => {
  it("collapses the month when both ends share it", () => {
    expect(formatWeekRange("2026-08-03")).toBe("3 – 9 Aug 2026");
  });

  it("keeps the month when the week spans two", () => {
    expect(formatWeekRange("2026-07-27")).toBe("27 Jul – 2 Aug 2026");
  });
});

describe("toMinutes — hours and minutes, never a decimal", () => {
  it("adds the two fields", () => {
    expect(toMinutes("2", "30")).toBe(150);
    expect(toMinutes("1", "")).toBe(60);
    expect(toMinutes("", "45")).toBe(45);
  });

  it("returns null for nothing entered, so blank stays distinct from zero", () => {
    expect(toMinutes("", "")).toBeNull();
    expect(toMinutes("0", "0")).toBe(0);
  });

  it("refuses negatives rather than subtracting time", () => {
    expect(toMinutes("-1", "0")).toBeNull();
    expect(toMinutes("1", "-30")).toBeNull();
  });

  it("round-trips through fromMinutes", () => {
    for (const total of [1, 45, 60, 150, 480, 1440]) {
      const parts = fromMinutes(total);
      expect(toMinutes(parts.hours, parts.minutes)).toBe(total);
    }
  });
});

describe("timesheetEntrySchema — task_id is the feature", () => {
  const valid = {
    task_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    work_date: "2026-08-06",
    minutes: 90,
    note: "second round",
  };

  it("accepts a complete entry", () => {
    expect(timesheetEntrySchema.safeParse(valid).success).toBe(true);
  });

  it("REJECTS an entry with no task — free-text logging is forbidden", () => {
    const withoutTask = { work_date: valid.work_date, minutes: valid.minutes, note: valid.note };
    expect(timesheetEntrySchema.safeParse(withoutTask).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, task_id: null }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, task_id: "" }).success).toBe(false);
  });

  it("rejects zero, negative and longer-than-a-day durations", () => {
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: 0 }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: -30 }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: 1441 }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: 1440 }).success).toBe(true);
  });

  it("rejects fractional minutes", () => {
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: 90.5 }).success).toBe(false);
  });

  it("normalises a blank note to null, which is what the CHECK constraint wants", () => {
    const parsed = timesheetEntrySchema.parse({ ...valid, note: "   " });
    expect(parsed.note).toBeNull();
  });
});
