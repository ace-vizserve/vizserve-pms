import { describe, expect, it } from "vitest";

import { NO_DEPARTMENT, sumDays, summariseLeave, type LeaveReportStatRow } from "@/lib/leave-stats";

const row = (over: Partial<LeaveReportStatRow>): LeaveReportStatRow => ({
  user_id: "u1",
  full_name: "Ana",
  department_name: "VizBytes",
  leave_type_id: "vac",
  code: "VACATION",
  label: "Vacation",
  sort_order: 1,
  days_allocated: 0,
  days_used: 0,
  ...over,
});

describe("summariseLeave", () => {
  const rows = [
    row({ days_allocated: "10", days_used: "3.5" }),
    row({ leave_type_id: "sick", code: "SICK", label: "Sick", sort_order: 2, days_allocated: 5, days_used: 1 }),
    row({ user_id: "u2", full_name: "Ben", days_allocated: 10, days_used: 6 }),
    row({ user_id: "u2", full_name: "Ben", leave_type_id: "sick", code: "SICK", label: "Sick", sort_order: 2, days_allocated: 5 }),
    row({ user_id: "u3", full_name: "Cy", department_name: null, days_allocated: 10 }),
    row({ user_id: "u3", full_name: "Cy", department_name: null, leave_type_id: "sick", code: "SICK", label: "Sick", sort_order: 2 }),
  ];
  const stats = summariseLeave(rows);

  it("totals allocated, used and remaining, half days included", () => {
    expect(stats.regularAllocated).toBe(40);
    expect(stats.used).toBe(10.5);
    expect(stats.regularRemaining).toBe(29.5);
    expect(stats.regularUsedPercent).toBe(26);
  });

  it("leaves life-event leave out of the allocation figures but not out of days taken", () => {
    const withMaternity = summariseLeave([
      ...rows,
      row({ leave_type_id: "mat", code: "MATERNITY", label: "Maternity", sort_order: 3, days_allocated: 105, days_used: 2 }),
    ]);
    expect(withMaternity.regularAllocated).toBe(40);
    expect(withMaternity.regularUsedPercent).toBe(26);
    expect(withMaternity.used).toBe(12.5);
  });

  it("counts people once, however many types they have", () => {
    expect(stats.people).toBe(3);
    expect(stats.peopleWhoTookLeave).toBe(2);
  });

  it("orders types by their list order", () => {
    expect(stats.byType.map((type) => type.label)).toEqual(["Vacation", "Sick"]);
    expect(stats.byType[0]).toMatchObject({ allocated: 30, used: 9.5, remaining: 20.5, usedPercent: 32 });
  });

  it("rolls people up by department, someone without one included", () => {
    expect(stats.byDepartment).toEqual([
      { name: "VizBytes", people: 2, used: 10.5, perPerson: 5.3 },
      { name: NO_DEPARTMENT, people: 1, used: 0, perPerson: 0 },
    ]);
  });

  it("lists only people who took leave, most first", () => {
    expect(stats.topTakers.map((person) => [person.name, person.used])).toEqual([
      ["Ben", 6],
      ["Ana", 4.5],
    ]);
  });

  it("answers null, not zero percent, when nothing was allocated", () => {
    expect(summariseLeave([row({ days_used: 2 })]).regularUsedPercent).toBeNull();
  });
});

describe("sumDays", () => {
  it("adds string and number days", () => {
    expect(sumDays([{ days: "1.5" }, { days: 2 }])).toBe(3.5);
  });
});
