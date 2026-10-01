import { describe, expect, it } from "vitest";

import {
  compliance,
  delivery,
  isQaReturn,
  percent,
  previousPeriod,
  reviewers,
  timeFigures,
  workload,
  type PerfMove,
  type PerfTask,
} from "@/lib/performance";

const period = { from: "2026-09-01", to: "2026-09-30" };

function task(overrides: Partial<PerfTask> = {}): PerfTask {
  return {
    id: "t1",
    title: "A task",
    status: "COMPLETED",
    departmentId: "d1",
    listId: null,
    dueDate: "2026-09-10",
    createdAt: "2026-09-01T01:00:00Z",
    updatedAt: "2026-09-05T01:00:00Z",
    doers: ["u1"],
    qaId: "q1",
    kind: "internal",
    priority: null,
    estimateMinutes: null,
    ...overrides,
  };
}

// Timestamps at 01:00Z are 09:00 in Manila — the same calendar day.
const move = (to: PerfMove["to"], from: PerfMove["from"], at: string, actorId = "u1", taskId = "t1"): PerfMove => ({
  taskId,
  from,
  to,
  actorId,
  at,
});

describe("delivery", () => {
  const moves: PerfMove[] = [
    move("OPEN", null, "2026-09-01T01:00:00Z"),
    move("ONGOING", "OPEN", "2026-09-02T01:00:00Z"),
    move("FOR_QA", "ONGOING", "2026-09-03T01:00:00Z"),
    move("QA_IN_PROGRESS", "FOR_QA", "2026-09-03T05:00:00Z", "q1"),
    move("ONGOING", "QA_IN_PROGRESS", "2026-09-03T06:00:00Z", "q1"),
    move("FOR_QA", "ONGOING", "2026-09-04T01:00:00Z"),
    move("QA_IN_PROGRESS", "FOR_QA", "2026-09-04T02:00:00Z", "q1"),
    move("COMPLETED", "QA_IN_PROGRESS", "2026-09-05T01:00:00Z", "q1"),
  ];

  it("counts a completion in the period, on time against the due date", () => {
    const result = delivery([task()], moves, period);
    expect(result.completed).toBe(1);
    expect(result.onTime).toEqual({ hit: 1, of: 1 });
    expect(result.cycleDays).toBe(4);
  });

  it("is late when completed after the due date", () => {
    const result = delivery([task({ dueDate: "2026-09-04" })], moves, period);
    expect(result.onTime).toEqual({ hit: 0, of: 1 });
  });

  it("leaves an undated task out of the on-time denominator", () => {
    const result = delivery([task({ dueDate: null })], moves, period);
    expect(result.onTime).toEqual({ hit: 0, of: 0 });
    expect(percent(result.onTime)).toBeNull();
  });

  it("fails first pass when QA sent it back, and counts the return", () => {
    const result = delivery([task()], moves, period);
    expect(result.firstPass).toEqual({ hit: 0, of: 1 });
    expect(result.qaReturns).toBe(1);
  });

  it("measures time in each stage", () => {
    const result = delivery([task()], moves, period);
    // FOR_QA: 4h (09-03 01→05) + 1h (09-04 01→02).
    expect(result.stageHours.qaQueue).toBe(5);
    // QA_IN_PROGRESS: 1h + 23h.
    expect(result.stageHours.qa).toBe(24);
  });

  it("ignores a completion outside the period", () => {
    const result = delivery([task()], moves, { from: "2026-10-01", to: "2026-10-31" });
    expect(result.completed).toBe(0);
  });

  it("puts the completion in its week", () => {
    const result = delivery([task()], moves, period);
    const week = result.throughput.find((row) => row.weekStart === "2026-08-31");
    expect(week?.completed).toBe(1);
  });

  it("compares logged time with the estimate", () => {
    const result = delivery([task({ estimateMinutes: 120 })], moves, period, new Map([["t1", 180]]));
    expect(result.estimateRatio).toBe(1.5);
    expect(result.estimated).toBe(1);
  });
});

describe("isQaReturn", () => {
  it("is a move from QA back to work, not on to the client or done", () => {
    expect(isQaReturn({ from: "QA_IN_PROGRESS", to: "ONGOING" })).toBe(true);
    expect(isQaReturn({ from: "QA_IN_PROGRESS", to: "FOR_CLIENT_APPROVAL" })).toBe(false);
    expect(isQaReturn({ from: "QA_IN_PROGRESS", to: "COMPLETED" })).toBe(false);
    expect(isQaReturn({ from: "FOR_QA", to: "QA_IN_PROGRESS" })).toBe(false);
  });
});

describe("previousPeriod", () => {
  it("is the same length, ending the day before", () => {
    expect(previousPeriod({ from: "2026-09-01", to: "2026-09-30" })).toEqual({
      from: "2026-08-02",
      to: "2026-08-31",
    });
  });
});

describe("workload", () => {
  it("counts open, overdue, due soon, age and stale", () => {
    const today = "2026-09-20";
    const result = workload(
      [
        task({ id: "a", status: "ONGOING", dueDate: "2026-09-15", createdAt: "2026-08-01T01:00:00Z", updatedAt: "2026-09-01T01:00:00Z" }),
        task({ id: "b", status: "OPEN", dueDate: "2026-09-25", createdAt: "2026-09-18T01:00:00Z", updatedAt: "2026-09-19T01:00:00Z", doers: [] }),
        task({ id: "c", status: "COMPLETED" }),
      ],
      today,
    );
    expect(result.open).toBe(2);
    expect(result.overdue).toBe(1);
    expect(result.overdueDays).toBe(5);
    expect(result.dueSoon).toBe(1);
    expect(result.age).toEqual({ fresh: 1, month: 0, old: 1 });
    expect(result.stale).toBe(1);
    expect(result.unassigned).toBe(1);
  });
});

describe("reviewers", () => {
  it("credits reviews, wait and returns to whoever made the move", () => {
    const rows = reviewers(
      [
        move("FOR_QA", "ONGOING", "2026-09-03T01:00:00Z"),
        move("QA_IN_PROGRESS", "FOR_QA", "2026-09-03T03:00:00Z", "q1"),
        move("ONGOING", "QA_IN_PROGRESS", "2026-09-03T04:00:00Z", "q1"),
      ],
      period,
    );
    expect(rows).toEqual([{ userId: "q1", reviews: 1, waitHours: 2, returns: 1 }]);
  });
});

describe("timeFigures", () => {
  it("splits hours by kind and compares them with clocked time less the break", () => {
    const result = timeFigures(
      [
        { userId: "u1", taskId: "c1", minutes: 240, workDate: "2026-09-02" },
        { userId: "u1", taskId: "i1", minutes: 120, workDate: "2026-09-02" },
      ],
      [{ userId: "u1", workDate: "2026-09-02", timeIn: "2026-09-02T00:00:00Z", timeOut: "2026-09-02T09:00:00Z" }],
      new Map([
        ["c1", "client"],
        ["i1", "internal"],
      ]),
      new Map([["u1", 60]]),
      period,
    );
    expect(result.minutes).toBe(360);
    expect(result.byKind).toEqual({ client: 240, internal: 120, personal: 0 });
    expect(result.clockedMinutes).toBe(480);
    expect(result.accounted).toEqual({ hit: 360, of: 480 });
  });
});

describe("compliance", () => {
  const always = () => 5;

  it("expects only weeks that have ended", () => {
    const result = compliance("u1", [], { from: "2026-09-01", to: "2026-09-30" }, "2026-09-16", always);
    // Weeks of 31 Aug and 7 Sep have ended by the 16th; 14 Sep has not.
    expect(result.expected).toBe(2);
    expect(result.missing).toBe(2);
  });

  it("is on time when submitted by the following Monday", () => {
    const result = compliance(
      "u1",
      [
        { userId: "u1", weekStart: "2026-08-31", status: "APPROVED", submittedAt: "2026-09-07T08:00:00Z" },
        { userId: "u1", weekStart: "2026-09-07", status: "SUBMITTED", submittedAt: "2026-09-16T08:00:00Z" },
      ],
      period,
      "2026-09-20",
      always,
    );
    expect(result).toMatchObject({ expected: 2, submitted: 2, onTime: 1, missing: 0 });
  });

  it("does not expect a week the person was not due to work", () => {
    const result = compliance("u1", [], period, "2026-09-20", (_, week) => (week === "2026-09-07" ? 0 : 5));
    expect(result.expected).toBe(1);
  });
});

describe("imported tasks", () => {
  it("does not count a task created already finished as a completion", () => {
    const result = delivery(
      [task()],
      [{ taskId: "t1", from: null, to: "COMPLETED", actorId: null, at: "2026-09-03T01:00:00Z" }],
      period,
    );
    expect(result.completed).toBe(0);
  });
});
