import { describe, expect, it } from "vitest";

import {
  addDays,
  allowedTimeOutDates,
  daysBetween,
  decimalHours,
  formatDate,
  formatDuration,
  isOverdue,
  parseDateOnly,
  toAppDateString,
  todayInAppZone,
  workedMinutes,
  yesterdayInAppZone,
} from "@/lib/dates";

/**
 * P0-12 — date helpers.
 *
 * `lib/dates.ts` exists because no date library is allowed (docs/11). That makes
 * it the single place an off-by-one day can hide, and date bugs are invisible
 * until someone's request reads as overdue a day early.
 */

describe("parseDateOnly — midday UTC, not midnight", () => {
  it("parses a bare YYYY-MM-DD at 12:00 UTC", () => {
    const parsed = parseDateOnly("2026-08-03");
    expect(parsed?.toISOString()).toBe("2026-08-03T12:00:00.000Z");
  });

  it("still renders as the intended day in a negative-offset zone", () => {
    // The bug this guards: midnight UTC on 3 Aug is 8pm on 2 Aug in UTC-4, so a
    // date-only column silently loses a day for anyone west of Greenwich.
    const parsed = parseDateOnly("2026-08-03")!;
    const inNewYork = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(parsed);
    expect(inNewYork).toBe("2026-08-03");
  });

  it("still renders as the intended day in Manila, the app zone", () => {
    const parsed = parseDateOnly("2026-08-03")!;
    expect(toAppDateString(parsed)).toBe("2026-08-03");
  });

  it("returns null for a value that is not a date at all", () => {
    expect(parseDateOnly("not-a-date")).toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts forward days as positive", () => {
    expect(daysBetween("2026-08-03", "2026-08-10")).toBe(7);
  });

  it("counts backward days as negative", () => {
    expect(daysBetween("2026-08-10", "2026-08-03")).toBe(-7);
  });

  it("is zero for the same day", () => {
    expect(daysBetween("2026-08-03", "2026-08-03")).toBe(0);
  });

  it("crosses a DST boundary without drifting", () => {
    // Both ends are midday UTC, so a one-hour civil shift cannot round to a day.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  });

  it("crosses a leap day correctly", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });
});

describe("addDays", () => {
  it("adds within a month", () => {
    expect(addDays("2026-08-03", 4)).toBe("2026-08-07");
  });

  it("rolls over a month boundary", () => {
    expect(addDays("2026-08-30", 3)).toBe("2026-09-02");
  });

  it("rolls over a year boundary", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });

  it("subtracts on a negative count", () => {
    expect(addDays("2026-08-03", -3)).toBe("2026-07-31");
  });

  it("handles the Phase 4 three-day window without losing a day", () => {
    // P4-09 auto-completes three days after the approval email goes out. If this
    // drifts, a client is told one deadline and held to another.
    expect(addDays("2026-08-03", 3)).toBe("2026-08-06");
  });
});

describe("isOverdue", () => {
  it("is false for today", () => {
    expect(isOverdue(todayInAppZone())).toBe(false);
  });

  it("is true for yesterday", () => {
    expect(isOverdue(addDays(todayInAppZone(), -1)!)).toBe(true);
  });

  it("is false for tomorrow", () => {
    expect(isOverdue(addDays(todayInAppZone(), 1)!)).toBe(false);
  });

  it("is false for no date rather than throwing", () => {
    expect(isOverdue(null)).toBe(false);
    expect(isOverdue(undefined)).toBe(false);
  });
});

describe("formatDate", () => {
  it("renders a readable day/month/year", () => {
    expect(formatDate("2026-08-03")).toBe("3 Aug 2026");
  });

  it("renders an em dash rather than the string 'null'", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("nonsense")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — work dates (P5-12)
// ---------------------------------------------------------------------------

describe("workedMinutes — instants, not wall clocks", () => {
  it("measures a normal shift", () => {
    expect(workedMinutes("2026-08-03T01:00:00Z", "2026-08-03T09:15:00Z")).toBe(495);
  });

  it("measures an overnight shift as a positive duration", () => {
    // THE case the DTR exists for: in 22:00 Manila on 22 Jul, out 01:00 on the
    // 23rd. Wall-clock subtraction gives -21 hours; instant subtraction gives 3.
    const timeIn = "2026-07-22T14:00:00Z"; // 22:00 Manila, 22 Jul
    const timeOut = "2026-07-22T17:00:00Z"; // 01:00 Manila, 23 Jul
    expect(workedMinutes(timeIn, timeOut)).toBe(180);
  });

  it("returns null rather than a negative duration when out precedes in", () => {
    expect(workedMinutes("2026-08-03T09:00:00Z", "2026-08-03T01:00:00Z")).toBeNull();
  });

  it("returns null for an open shift", () => {
    expect(workedMinutes("2026-08-03T01:00:00Z", null)).toBeNull();
  });
});

describe("formatDuration", () => {
  it.each([
    [495, "8h 15m"],
    [480, "8h"],
    [45, "45m"],
    [0, "0m"],
  ])("renders %i minutes as %s", (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });

  it("renders an open shift as an em dash", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("decimalHours — payroll multiplies by a rate", () => {
  it.each([
    [495, "8.25"],
    [480, "8.00"],
    [30, "0.50"],
  ])("renders %i minutes as %s", (minutes, expected) => {
    expect(decimalHours(minutes)).toBe(expected);
  });

  it("renders an open shift as empty, not as zero", () => {
    // A zero would be summed by payroll as a real worked day.
    expect(decimalHours(null)).toBe("");
  });
});

describe("allowedTimeOutDates — Q4's backdating guard", () => {
  it("offers today only when yesterday has no open shift", () => {
    expect(allowedTimeOutDates(false)).toEqual([todayInAppZone()]);
  });

  it("offers yesterday as well when yesterday's shift was left open", () => {
    const allowed = allowedTimeOutDates(true);
    expect(allowed).toContain(todayInAppZone());
    expect(allowed).toContain(yesterdayInAppZone());
    // Never more than those two — the whole point is that an arbitrary past
    // date cannot be chosen.
    expect(allowed).toHaveLength(2);
  });

  it("never offers a date older than yesterday", () => {
    const twoDaysAgo = addDays(todayInAppZone(), -2)!;
    expect(allowedTimeOutDates(true)).not.toContain(twoDaysAgo);
  });
});

describe("yesterdayInAppZone", () => {
  it("is exactly one day before today in app time", () => {
    expect(daysBetween(yesterdayInAppZone(), todayInAppZone())).toBe(1);
  });
});
