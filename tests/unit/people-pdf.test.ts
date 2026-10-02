import { describe, expect, it } from "vitest";

import { renderPeoplePdf } from "@/app/(app)/analytics/people/people-pdf";
import type { PersonRow } from "@/app/(app)/analytics/people/people-table";
import { averageRow, isWorse } from "@/app/(app)/analytics/people/rows";

export function samplePeople(count: number): PersonRow[] {
  const departments = ["Design", "Development", "Operations", null];
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    name: `Person ${String(index + 1).padStart(2, "0")}`,
    department: departments[index % departments.length],
    open: (index * 3) % 9,
    overdue: index % 5 === 0 ? 6 : index % 3,
    completed: 4 + ((index * 7) % 15),
    onTime: index % 6 === 0 ? null : 55 + ((index * 13) % 45),
    onTimeOf: 10,
    cycleDays: 1 + ((index * 5) % 9) / 2,
    firstPass: 60 + ((index * 11) % 40),
    firstPassOf: 8,
    qaReturns: index % 4,
    reviews: (index * 2) % 7,
    minutes: 6000 + ((index * 977) % 4000),
    accounted: 70 + ((index * 3) % 30),
    timesheetsOnTime: index % 7 === 0 ? 50 : 100,
    timesheetsExpected: 4,
    missingTimesheets: index % 7 === 0 ? 2 : 0,
    late: index % 4 === 3 ? null : (index * 5) % 6,
    absent: index % 4 === 3 ? null : index % 9 === 0 ? 3 : (index % 3) * 0.5,
    rating: index % 2 ? 4 + (index % 10) / 10 : null,
    ratingCount: index % 2 ? 3 : 0,
  }));
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const meta = { period: "1 Oct 2026 - 31 Oct 2026", scope: "All departments", generatedOn: "2 Oct 2026" };

describe("P15-09 People PDF", () => {
  it("is a PDF with the tiles, every chart, every person and the average row", () => {
    const rows = samplePeople(6);
    const pdf = text(renderPeoplePdf(rows, averageRow(rows), meta));

    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    for (const title of ["Tasks completed", "Delivered on time", "QA first pass", "Hours logged", "Overdue now", "Timesheets on time", "Late arrivals", "Days absent", "Every measure", "Department average"]) {
      expect(pdf).toContain(title);
    }
    for (const row of rows) expect(pdf).toContain(row.name);
    expect(pdf).toContain("worse than avg");
    expect(pdf).toContain("not measured");
    // Landscape.
    expect(pdf).toContain("/MediaBox [0 0 841.89 595.28]");
  });

  it("flows a large team over more pages without dropping anybody", () => {
    const rows = samplePeople(60);
    const pdf = text(renderPeoplePdf(rows, averageRow(rows), meta));
    expect(Number(/\/Count (\d+)/.exec(pdf)![1])).toBeGreaterThan(3);
    expect(pdf).toContain("continued");
    expect(pdf).toContain("Person 60");
  });

  it("marks worse-than-average by the same rule as the table", () => {
    expect(isWorse(50, 80, "up")).toBe(true);
    expect(isWorse(75, 80, "up")).toBe(false);
    expect(isWorse(6, 2, "down")).toBe(true);
    expect(isWorse(null, 2, "down")).toBe(false);
  });
});
