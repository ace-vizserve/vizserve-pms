import { describe, expect, it } from "vitest";

import {
  createHolidaySchema,
  holidayDateSchema,
  holidayNameSchema,
  holidayYearSchema,
  isClosedYear,
  updateHolidaySchema,
} from "@/lib/schemas/holidays";

/**
 * P7-35 — the holiday calendar contract.
 *
 * This table stopped being decoration when P7-33 landed. It used to feed one
 * thing, the client-approval deadline, and it now also decides how many working
 * days a leave request consumes — and therefore what the December audit says
 * anybody has left. A bad date in here is a wrong entitlement figure, so the
 * validation is worth pinning.
 */

describe("holidayDateSchema", () => {
  it("accepts a plain ISO date", () => {
    expect(holidayDateSchema.parse("2027-01-01")).toBe("2027-01-01");
  });

  it("trims", () => {
    expect(holidayDateSchema.parse("  2027-01-01  ")).toBe("2027-01-01");
  });

  it("refuses a date that does not exist", () => {
    // The regex is happy with 31 February. `new Date` is too — it rolls forward
    // into March rather than failing, which is why the schema rebuilds the date
    // and compares the parts back.
    expect(holidayDateSchema.safeParse("2027-02-31").success).toBe(false);
    expect(holidayDateSchema.safeParse("2027-13-01").success).toBe(false);
    expect(holidayDateSchema.safeParse("2027-00-10").success).toBe(false);
  });

  it("accepts 29 February in a leap year and refuses it otherwise", () => {
    expect(holidayDateSchema.safeParse("2028-02-29").success).toBe(true);
    expect(holidayDateSchema.safeParse("2027-02-29").success).toBe(false);
  });

  it("refuses anything carrying a time", () => {
    // Every consumer compares this as a STRING — the calendar decides which cell
    // a day lands in with `start <= day`, which only works because the format
    // sorts lexicographically. A timestamp would break that silently.
    expect(holidayDateSchema.safeParse("2027-01-01T00:00:00Z").success).toBe(false);
    expect(holidayDateSchema.safeParse("2027-1-1").success).toBe(false);
  });

  it("refuses a year outside the window", () => {
    expect(holidayDateSchema.safeParse("1999-01-01").success).toBe(false);
    expect(holidayDateSchema.safeParse("2200-01-01").success).toBe(false);
  });

  it("refuses a blank", () => {
    expect(holidayDateSchema.safeParse("").success).toBe(false);
    expect(holidayDateSchema.safeParse("   ").success).toBe(false);
  });
});

describe("holidayNameSchema", () => {
  it("takes a name and trims it", () => {
    expect(holidayNameSchema.parse("  Araw ng Kagitingan ")).toBe("Araw ng Kagitingan");
  });

  it("refuses an empty one", () => {
    // A nameless holiday paints a calendar cell with nothing in it, and colour
    // is never the only carrier of state in this app.
    expect(holidayNameSchema.safeParse("").success).toBe(false);
    expect(holidayNameSchema.safeParse("    ").success).toBe(false);
  });

  it("refuses one too long for a calendar cell", () => {
    expect(holidayNameSchema.safeParse("x".repeat(81)).success).toBe(false);
    expect(holidayNameSchema.safeParse("x".repeat(80)).success).toBe(true);
  });
});

describe("createHolidaySchema", () => {
  it("needs both fields", () => {
    expect(
      createHolidaySchema.parse({ holiday_date: "2027-04-09", name: "Araw ng Kagitingan" }),
    ).toEqual({ holiday_date: "2027-04-09", name: "Araw ng Kagitingan" });

    expect(createHolidaySchema.safeParse({ holiday_date: "2027-04-09" }).success).toBe(false);
    expect(createHolidaySchema.safeParse({ name: "Araw ng Kagitingan" }).success).toBe(false);
  });

  it("reports the offending field, so the form can point at it", () => {
    const result = createHolidaySchema.safeParse({ holiday_date: "nope", name: "" });
    expect(result.success).toBe(false);

    const paths = result.success ? [] : result.error.issues.map((issue) => issue.path[0]);
    expect(paths).toContain("holiday_date");
    expect(paths).toContain("name");
  });
});

describe("updateHolidaySchema", () => {
  it("carries the date as the key, and a new name", () => {
    // The date identifies the holiday and is NOT editable — moving one is a
    // delete and an add, because an audit row saying "renamed" about a date that
    // changed would be a lie. This shape is what enforces that at the boundary.
    expect(
      updateHolidaySchema.parse({ holiday_date: "2026-12-25", name: "Christmas Day" }),
    ).toEqual({ holiday_date: "2026-12-25", name: "Christmas Day" });
  });
});

describe("holidayYearSchema", () => {
  it("coerces the URL's string", () => {
    expect(holidayYearSchema.parse("2027")).toBe(2027);
  });

  it("refuses a mistyped year, so the page can fall back", () => {
    expect(holidayYearSchema.safeParse("banana").success).toBe(false);
    expect(holidayYearSchema.safeParse("1999").success).toBe(false);
    expect(holidayYearSchema.safeParse("2027.5").success).toBe(false);
  });
});

describe("isClosedYear", () => {
  it("is true only for a year before the current one", () => {
    // YEAR granularity, not "before today". Editing next week's holiday changes
    // a count for leave nobody has taken yet — ordinary maintenance. Editing
    // last year's changes a figure that has been reported and possibly paid.
    expect(isClosedYear("2025-12-25", 2026)).toBe(true);
    expect(isClosedYear("2026-01-01", 2026)).toBe(false);
    expect(isClosedYear("2026-12-31", 2026)).toBe(false);
    expect(isClosedYear("2027-01-01", 2026)).toBe(false);
  });
});
