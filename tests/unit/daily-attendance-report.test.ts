import { describe, expect, it } from "vitest";

import { buildDailyAttendanceReport, type ReportPerson } from "@/lib/daily-attendance-report";
import type { LeaveSpan } from "@/lib/leave";

const DATE = "2026-10-01";
// 09:00 Manila is 01:00Z.
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 9, 1, h - 8, m)).toISOString();
};

const person = (id: string, fullName: string, scheduled = true, departmentName: string | null = "Design"): ReportPerson => ({
  id,
  fullName,
  departmentName,
  workStart: scheduled ? "09:00" : null,
  workEnd: scheduled ? "18:00" : null,
});

const leave = (user_id: string, overrides: Partial<LeaveSpan> = {}): LeaveSpan => ({
  user_id,
  start_date: DATE,
  end_date: DATE,
  start_half: null,
  end_half: null,
  type_name: null,
  ...overrides,
});

describe("P15-08 daily attendance report", () => {
  it("is clean when everybody timed in on time and out", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana")],
      entries: [{ user_id: "a", time_in: at("09:03"), time_out: at("18:01") }],
      leave: [],
    });
    expect(report.body.heading).toBe("A clean day");
    expect(report.body.facts).toEqual([]);
  });

  it("finds absent, late (past grace) and no time-out, in that order", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana"), person("b", "Ben"), person("c", "Cara"), person("d", "Dan")],
      entries: [
        { user_id: "b", time_in: at("09:20"), time_out: at("18:00") },
        { user_id: "c", time_in: at("08:55"), time_out: null },
        { user_id: "d", time_in: at("09:05"), time_out: at("18:00") }, // within grace
      ],
      leave: [],
    });

    expect([report.absent, report.late, report.noTimeOut]).toEqual([1, 1, 1]);
    expect(report.body.facts).toEqual([
      { label: "Ana", value: "Absent · No time record · Design" },
      { label: "Ben", value: "Late · 20m late, in at 09:20 (start 09:00) · Design" },
      { label: "Cara", value: "No time-out · In at 08:55, never timed out · Design" },
    ]);
  });

  it("never marks anybody with leave on the calendar absent, half day included", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana"), person("b", "Ben")],
      entries: [],
      leave: [leave("a"), leave("b", { end_half: "MORNING" })],
    });
    expect(report.absent).toBe(0);
    expect(report.sheet.map((row) => row.status)).toEqual([["On leave"], ["On leave (AM)"]]);
  });

  it("never marks somebody without fixed hours late or absent, but does flag a missing time-out", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana", false), person("b", "Ben", false, null)],
      entries: [{ user_id: "b", time_in: at("11:00"), time_out: null }],
      leave: [],
    });
    expect([report.absent, report.late, report.noTimeOut]).toEqual([0, 0, 1]);
    expect(report.body.facts?.[0].value).toBe("No time-out · In at 11:00, never timed out");
  });

  it("uses the configured grace", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana")],
      entries: [{ user_id: "a", time_in: at("09:10"), time_out: at("18:00") }],
      leave: [],
      graceMinutes: 15,
    });
    expect(report.late).toBe(0);
  });
});

describe("P15-08 the full sheet", () => {
  it("lists everybody with their times and a status, worst first", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [
        person("a", "Ana", true, "Dev"),
        person("b", "Ben"),
        person("c", "Cara"),
        person("d", "Dan", false, null),
        person("e", "Eve"),
        person("f", "Fay"),
      ],
      entries: [
        { user_id: "a", time_in: at("08:58"), time_out: at("18:02") },
        { user_id: "b", time_in: at("09:30"), time_out: at("17:00") },
        { user_id: "c", time_in: at("09:01"), time_out: null },
      ],
      leave: [leave("e"), leave("f", { start_half: "AFTERNOON" })],
    });

    expect(report.sheet.map((row) => [row.name, row.level])).toEqual([
      ["Ben", "attention"],
      ["Cara", "attention"],
      ["Eve", "leave"],
      ["Fay", "leave"],
      ["Ana", "fine"],
      ["Dan", "unknown"],
    ]);
    const byName = Object.fromEntries(report.sheet.map((row) => [row.name, row]));
    expect(byName.Ben).toMatchObject({ schedule: "09:00-18:00", timeIn: "09:30", timeOut: "17:00", status: ["Late 30m", "Out early · 1h"] });
    expect(byName.Cara).toMatchObject({ timeIn: "09:01", timeOut: "", status: ["No time-out"] });
    expect(byName.Eve).toMatchObject({ timeIn: "", status: ["On leave"] });
    expect(byName.Fay).toMatchObject({ status: ["On leave (PM)"] });
    expect(byName.Ana).toMatchObject({ timeIn: "08:58", timeOut: "18:02", status: ["On time"] });
    expect(byName.Dan).toMatchObject({ department: null, schedule: "No fixed hours", status: ["No time record"] });
  });
});

describe("P15-08 leave is marked", () => {
  it("names the type on the sheet and lists leave after the exceptions in the email", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana"), person("b", "Ben"), person("c", "Cara")],
      entries: [{ user_id: "c", time_in: at("09:30"), time_out: at("18:00") }],
      leave: [leave("a", { type_name: "Annual Leave" }), leave("b", { end_half: "MORNING", type_name: "Sick Leave" })],
    });

    const status = Object.fromEntries(report.sheet.map((row) => [row.name, row.status]));
    expect(status.Ana).toEqual(["On leave: Annual Leave"]);
    expect(status.Ben).toEqual(["On leave (AM): Sick Leave"]);

    expect(report.body.facts).toEqual([
      { label: "Cara", value: "Late · 30m late, in at 09:30 (start 09:00) · Design" },
      { label: "Ana", value: "On leave · Full day — Annual Leave · Design" },
      { label: "Ben", value: "On leave · Half day (morning) — Sick Leave · Design" },
    ]);
    expect(report.subject).toContain("2 on leave");
  });

  it("says only 'On leave' when the type may not be shown, and leave alone is still a clean day", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana")],
      entries: [],
      leave: [leave("a", { type_name: null })],
    });
    expect(report.sheet[0].status).toEqual(["On leave"]);
    expect(report.sheet[0].level).toBe("leave");
    expect(report.body.heading).toBe("A clean day");
    expect(report.body.facts).toEqual([{ label: "Ana", value: "On leave · Full day · Design" }]);
  });
});

describe("P15-08 the leave calendar decides", () => {
  it("marks pending leave as leave, not absent, and says it is pending", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana"), person("b", "Ben")],
      entries: [],
      leave: [leave("a", { type_name: "Annual Leave" })],
      // Ana also has a pending request: the approved one wins, listed once.
      pendingLeave: [leave("a", { type_name: "Other" }), leave("b", { type_name: "Sick Leave" })],
    });

    expect(report.absent).toBe(0);
    expect(report.onLeave).toBe(2);
    expect(Object.fromEntries(report.sheet.map((row) => [row.name, row.status]))).toEqual({
      Ana: ["On leave: Annual Leave"],
      Ben: ["Leave (pending): Sick Leave"],
    });
    expect(report.sheet.every((row) => row.level === "leave")).toBe(true);
    expect(report.body.facts).toEqual([
      { label: "Ana", value: "On leave · Full day — Annual Leave · Design" },
      { label: "Ben", value: "On leave · Awaiting approval · Full day — Sick Leave · Design" },
    ]);
  });

  it("does not call a morning off late, or an afternoon off early", () => {
    const report = buildDailyAttendanceReport({
      date: DATE,
      people: [person("a", "Ana"), person("b", "Ben")],
      entries: [
        { user_id: "a", time_in: at("13:05"), time_out: at("18:00") },
        { user_id: "b", time_in: at("09:00"), time_out: at("12:30") },
      ],
      leave: [leave("a", { end_half: "MORNING" }), leave("b", { start_half: "AFTERNOON" })],
    });

    expect(report.late).toBe(0);
    expect(Object.fromEntries(report.sheet.map((row) => [row.name, row.status]))).toEqual({
      Ana: ["On leave (AM)"],
      Ben: ["On leave (PM)"],
    });
  });
});
