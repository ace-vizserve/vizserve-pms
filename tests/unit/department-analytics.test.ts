import { describe, expect, it } from "vitest";

import {
  OUTSIDE_NAME,
  summariseWorkload,
  type WorkloadAssignment,
  type WorkloadPerson,
  type WorkloadTask,
} from "@/lib/department-analytics";
import { TERMINAL_STATUSES } from "@/lib/schemas/tasks";

/**
 * P11-14 — the per-person roll-up behind /analytics.
 *
 * Pins who counts as "on" a task (the named assignee OR a join row, once), and
 * that the department totals count tasks rather than people-on-tasks.
 */

const TODAY = "2026-09-11";
const DEPT = "dept-1";

function task(overrides: Partial<WorkloadTask> = {}): WorkloadTask {
  return {
    id: "t1",
    status: "OPEN",
    department_id: DEPT,
    due_date: null,
    assignee_id: null,
    ...overrides,
  };
}

function person(id: string, full_name: string): WorkloadPerson {
  return { id, full_name, department_id: DEPT };
}

function summarise(
  tasks: WorkloadTask[],
  assignments: WorkloadAssignment[] = [],
  roster: WorkloadPerson[] = [],
  nameOf: Map<string, string> = new Map(),
) {
  return summariseWorkload({ tasks, assignments, roster, nameOf, today: TODAY });
}

function rowOf(summary: ReturnType<typeof summarise>, id: string) {
  const row = summary.rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe("summariseWorkload — who is on a task", () => {
  const roster = [person("ana", "Ana"), person("ben", "Ben")];

  it("counts the named assignee", () => {
    const summary = summarise([task({ assignee_id: "ana" })], [], roster);
    expect(rowOf(summary, "ana").total).toBe(1);
    expect(rowOf(summary, "ben").total).toBe(0);
  });

  it("counts extra assignees from the join table — internal tasks have no PIC", () => {
    const summary = summarise([task()], [{ task_id: "t1", user_id: "ben" }], roster);
    expect(rowOf(summary, "ben").total).toBe(1);
    expect(summary.unassigned).toBe(0);
  });

  it("counts somebody named AND in the join table once", () => {
    const summary = summarise(
      [task({ assignee_id: "ana" })],
      [{ task_id: "t1", user_id: "ana" }],
      roster,
    );
    expect(rowOf(summary, "ana").total).toBe(1);
  });

  it("ignores join rows for tasks outside the list", () => {
    const summary = summarise([task()], [{ task_id: "elsewhere", user_id: "ana" }], roster);
    expect(rowOf(summary, "ana").total).toBe(0);
  });

  it("keeps roster people with nothing on their plate", () => {
    const summary = summarise([], [], roster);
    expect(summary.rows.map((row) => row.id).sort()).toEqual(["ana", "ben"]);
  });

  it("names somebody outside the roster from the lookup, or falls back", () => {
    const summary = summarise(
      [task({ id: "t1", assignee_id: "cal" }), task({ id: "t2", assignee_id: "dee" })],
      [],
      roster,
      new Map([["cal", "Cal"]]),
    );
    expect(rowOf(summary, "cal").name).toBe("Cal");
    expect(rowOf(summary, "dee").name).toBe(OUTSIDE_NAME);
    expect(rowOf(summary, "dee").departmentId).toBeNull();
  });
});

describe("summariseWorkload — the bands", () => {
  it("puts OPEN in not started and every other live status in active", () => {
    const summary = summarise(
      [
        task({ id: "a", status: "OPEN", assignee_id: "ana" }),
        task({ id: "b", status: "ONGOING", assignee_id: "ana" }),
        task({ id: "c", status: "FOR_QA", assignee_id: "ana" }),
      ],
      [],
      [person("ana", "Ana")],
    );
    const ana = rowOf(summary, "ana");
    expect(ana).toMatchObject({ total: 3, notStarted: 1, active: 2, completed: 0 });
  });

  it("counts both endings as completed", () => {
    const tasks = TERMINAL_STATUSES.map((status, index) =>
      task({ id: `done-${index}`, status, assignee_id: "ana" }),
    );
    const ana = rowOf(summarise(tasks, [], [person("ana", "Ana")]), "ana");
    expect(ana.completed).toBe(TERMINAL_STATUSES.length);
    expect(ana.notStarted + ana.active).toBe(0);
  });
});

describe("summariseWorkload — overdue", () => {
  const roster = [person("ana", "Ana")];

  it("counts live work past its due date", () => {
    const summary = summarise([task({ due_date: "2026-09-10", assignee_id: "ana" })], [], roster);
    expect(rowOf(summary, "ana").overdue).toBe(1);
  });

  it("does not count work due today", () => {
    const summary = summarise([task({ due_date: TODAY, assignee_id: "ana" })], [], roster);
    expect(rowOf(summary, "ana").overdue).toBe(0);
  });

  it("does not count finished work that was delivered late", () => {
    const summary = summarise(
      [task({ status: "COMPLETED", due_date: "2026-01-01", assignee_id: "ana" })],
      [],
      roster,
    );
    expect(rowOf(summary, "ana").overdue).toBe(0);
  });
});

describe("summariseWorkload — totals", () => {
  it("counts a shared task once in the totals and once per person", () => {
    const summary = summarise(
      [task({ assignee_id: "ana" })],
      [{ task_id: "t1", user_id: "ben" }],
      [person("ana", "Ana"), person("ben", "Ben")],
    );
    expect(summary.totals.total).toBe(1);
    expect(rowOf(summary, "ana").total).toBe(1);
    expect(rowOf(summary, "ben").total).toBe(1);
  });

  it("counts tasks with nobody on them as unassigned, still in the totals", () => {
    const summary = summarise([task()], [], [person("ana", "Ana")]);
    expect(summary.unassigned).toBe(1);
    expect(summary.totals.total).toBe(1);
  });

  it("sorts the busiest person first, then by name", () => {
    const summary = summarise(
      [task({ id: "a", assignee_id: "ben" })],
      [],
      [person("cal", "Cal"), person("ana", "Ana"), person("ben", "Ben")],
    );
    expect(summary.rows.map((row) => row.name)).toEqual(["Ben", "Ana", "Cal"]);
  });
});
