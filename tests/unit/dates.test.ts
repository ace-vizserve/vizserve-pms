import { describe, expect, it } from "vitest";

import {
  addDays,
  daysBetween,
  formatDate,
  isOverdue,
  parseDateOnly,
  toAppDateString,
  todayInAppZone,
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
