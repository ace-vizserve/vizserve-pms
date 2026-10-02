import { describe, expect, it } from "vitest";

import { buildDailyAttendanceReport, type ReportPerson } from "@/lib/daily-attendance-report";
import { renderDailyAttendancePdf } from "@/lib/reports/daily-attendance-pdf";

const DATE = "2026-10-01";
const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 1, h - 8, m)).toISOString();
const people = (count: number): ReportPerson[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    fullName: `Person ${String(index).padStart(3, "0")}`,
    departmentName: index % 2 ? "Design" : "Development",
    workStart: "09:00",
    workEnd: "18:00",
  }));

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("P15-08 daily attendance PDF", () => {
  it("is a PDF carrying the day, the counts and every row", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: people(3),
      entries: [
        { user_id: "p1", time_in: at(9, 30), time_out: at(18, 0) },
        { user_id: "p2", time_in: at(9, 0), time_out: null },
      ],
      leave: [],
    });
    const pdf = text(renderDailyAttendancePdf(report, { generatedOn: "2 Oct 2026" }));

    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("Thu 1 Oct 2026");
    expect(pdf).toContain("Absent 1");
    expect(pdf).toContain("Person 000");
    expect(pdf).toContain("Person 001");
    expect(pdf).toContain("Person 002");
    expect(pdf).toContain("Late 30m");
    expect(pdf).toContain("No time-out");
    expect(pdf).toContain("09:30");
  });

  it("says so when there is nobody to list", () => {
    const report = buildDailyAttendanceReport({ date: DATE, people: [], entries: [], leave: [] });
    expect(text(renderDailyAttendancePdf(report, { generatedOn: "2 Oct 2026" }))).toContain("No active employees");
  });

  it("runs onto more pages when the list is long", () => {
    const report = buildDailyAttendanceReport({ date: DATE, people: people(90), entries: [], leave: [] });
    const pdf = text(renderDailyAttendancePdf(report, { generatedOn: "2 Oct 2026" }));
    expect(pdf).toMatch(/\/Count [2-9]/);
    expect(pdf).toContain("Person 089");
  });
});
