import { describe, expect, it } from "vitest";

import { buildGrid, computeStats, dayMs } from "@/components/ui/contribution-skyline";

// 2026-10-30 is a Friday. Weekend 24–25 Oct.
const stats = (days: Record<string, number>, rest: string[] = []) => {
  const { cells } = buildGrid(
    Object.entries(days).map(([date, count]) => ({ date, count })),
    dayMs("2026-10-30"),
  );
  return computeStats(cells, new Set(rest));
};

describe("computeStats with rest days", () => {
  const week = { "2026-10-22": 8, "2026-10-23": 8, "2026-10-26": 8, "2026-10-27": 8 };

  it("ends the streak at the weekend without rest days", () => {
    expect(stats(week).longest.days).toBe(2);
  });

  it("carries the streak across a rest weekend", () => {
    const s = stats(week, ["2026-10-24", "2026-10-25"]);
    expect(s.longest).toEqual({ days: 4, start: "2026-10-22", end: "2026-10-27" });
  });

  it("current streak skips an empty today and rest days, breaks on a missed day", () => {
    const s = stats({ ...week, "2026-10-29": 7 }, ["2026-10-24", "2026-10-25"]);
    // 28 Oct is a missed working day.
    expect(s.current).toEqual({ days: 1, start: "2026-10-29", end: "2026-10-29" });
  });

  it("current streak spans rest days", () => {
    const s = stats({ ...week, "2026-10-28": 8, "2026-10-29": 8 }, ["2026-10-24", "2026-10-25"]);
    expect(s.current).toEqual({ days: 6, start: "2026-10-22", end: "2026-10-29" });
  });
});
