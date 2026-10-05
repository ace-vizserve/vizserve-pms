import { describe, expect, it } from "vitest";

import { nextPeriod, periodStart, previewNextCopy, setRecurrenceSchema, shiftIntoPeriod } from "@/lib/recurrence";

/*
 * P15-10. These cases are the SQL functions' too (`vizserve_pms_period_start`,
 * `vizserve_pms_shift_into_period`) — the database generates, this previews,
 * and the two must agree on every line below.
 */

describe("P15-10 periods", () => {
  it("starts a weekly period on Monday, a monthly one on the 1st, a daily one on the day", () => {
    expect(periodStart("WEEKLY", "2026-10-09")).toBe("2026-10-05"); // Fri → Mon
    expect(periodStart("WEEKLY", "2026-10-11")).toBe("2026-10-05"); // Sun belongs to the week ending
    expect(periodStart("WEEKLY", "2026-10-05")).toBe("2026-10-05");
    expect(periodStart("MONTHLY", "2026-10-20")).toBe("2026-10-01");
    expect(periodStart("DAILY", "2026-10-07")).toBe("2026-10-07");
  });

  it("steps to the next period; daily skips the weekend", () => {
    expect(nextPeriod("WEEKLY", "2026-10-05")).toBe("2026-10-12");
    expect(nextPeriod("MONTHLY", "2026-10-01")).toBe("2026-11-01");
    expect(nextPeriod("DAILY", "2026-10-09")).toBe("2026-10-12"); // Fri → Mon
  });
});

describe("P15-10 dates keep their place in the period", () => {
  it("moves Mon–Fri to next week's Mon–Fri — the acceptance case", () => {
    expect(shiftIntoPeriod("WEEKLY", "2026-10-05", "2026-10-05", "2026-10-12")).toBe("2026-10-12");
    expect(shiftIntoPeriod("WEEKLY", "2026-10-09", "2026-10-05", "2026-10-12")).toBe("2026-10-16");
  });

  it("keeps the day of the month, clamped at a short month", () => {
    expect(shiftIntoPeriod("MONTHLY", "2026-10-15", "2026-10-01", "2026-11-01")).toBe("2026-11-15");
    expect(shiftIntoPeriod("MONTHLY", "2026-01-31", "2026-01-01", "2026-02-01")).toBe("2026-02-28");
  });

  it("jumps straight to the current period after a gap — no backfill", () => {
    expect(shiftIntoPeriod("WEEKLY", "2026-10-09", "2026-10-05", "2026-10-26")).toBe("2026-10-30");
  });

  it("leaves a missing date missing", () => {
    expect(shiftIntoPeriod("WEEKLY", null, "2026-10-05", "2026-10-12")).toBeNull();
  });
});

describe("P15-10 preview", () => {
  it("previews next week's copy of a Mon–Fri task", () => {
    expect(previewNextCopy("WEEKLY", { start_date: "2026-10-05", due_date: "2026-10-09" }, "2026-10-06")).toEqual({
      period: "2026-10-12",
      start_date: "2026-10-12",
      due_date: "2026-10-16",
    });
  });

  it("anchors an undated task on today", () => {
    expect(previewNextCopy("MONTHLY", { start_date: null, due_date: null }, "2026-10-06")?.period).toBe("2026-11-01");
  });
});

describe("P15-10 contract", () => {
  it("defaults a new copy to Ongoing and refuses any other landing status", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(setRecurrenceSchema.parse({ task_id: id, frequency: "WEEKLY" }).landing_status).toBe("ONGOING");
    expect(setRecurrenceSchema.safeParse({ task_id: id, frequency: "WEEKLY", landing_status: "COMPLETED" }).success).toBe(false);
  });
});
