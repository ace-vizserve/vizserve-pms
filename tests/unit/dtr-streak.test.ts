import { describe, expect, it } from "vitest";

import { computeDtrStreak } from "@/lib/dtr-streak";

// 2026-10-30 is a Friday.
const streak = (punched: string[], today = "2026-10-30") =>
  computeDtrStreak({ today, punchedDates: new Set(punched) });

describe("computeDtrStreak", () => {
  it("counts consecutive weekdays including today", () => {
    expect(streak(["2026-10-28", "2026-10-29", "2026-10-30"])).toBe(3);
  });

  it("does not break because today is not punched yet", () => {
    expect(streak(["2026-10-28", "2026-10-29"])).toBe(2);
  });

  it("skips the weekend without breaking", () => {
    expect(streak(["2026-10-23", "2026-10-26"], "2026-10-26")).toBe(2);
  });

  it("counts a weekend punch", () => {
    expect(streak(["2026-10-23", "2026-10-24", "2026-10-26"], "2026-10-26")).toBe(3);
  });

  it("breaks on a working day with no time-in — leave included", () => {
    // 28 Oct: on leave, or simply absent. Either way, no time-in.
    expect(streak(["2026-10-27", "2026-10-29", "2026-10-30"])).toBe(2);
  });

  it("is zero with no punches", () => {
    expect(streak([])).toBe(0);
  });
});
