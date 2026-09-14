import { describe, expect, it } from "vitest";

import {
  OUTSIDE_NAME,
  STAGE_SAMPLE_LIMIT,
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
    title: "A task",
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
  departmentIds: string[] = [],
) {
  return summariseWorkload({ tasks, assignments, roster, departmentIds, nameOf, today: TODAY });
}

function departmentOf(summary: ReturnType<typeof summarise>, id: string) {
  const department = summary.departments.find((candidate) => candidate.departmentId === id);
  if (!department) throw new Error(`no department for ${id}`);
  return department;
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


/**
 * The per-department roll-up behind /analytics' rings. The property that makes a
 * ring honest is the one worth pinning: these add up to `totals`, where the
 * per-person rows deliberately do not.
 */
describe("summariseWorkload — per department", () => {
  const OTHER = "dept-2";

  it("splits the counts by the department a task is filed under", () => {
    const summary = summarise(
      [
        task({ id: "a", status: "OPEN" }),
        task({ id: "b", status: "ONGOING" }),
        task({ id: "c", status: TERMINAL_STATUSES[0], department_id: OTHER }),
      ],
      [],
      [],
      new Map(),
      [DEPT, OTHER],
    );

    expect(departmentOf(summary, DEPT)).toMatchObject({ total: 2, notStarted: 1, active: 1 });
    expect(departmentOf(summary, OTHER)).toMatchObject({ total: 1, completed: 1 });
  });

  it("counts a task shared by three people ONCE — the rings are a true part-to-whole", () => {
    const summary = summarise(
      [task({ id: "a", assignee_id: "ana" })],
      [
        { task_id: "a", user_id: "ben" },
        { task_id: "a", user_id: "cara" },
      ],
      [person("ana", "Ana"), person("ben", "Ben"), person("cara", "Cara")],
      new Map(),
      [DEPT],
    );

    // Three per-person rows of 1 each, and one task in the department.
    expect(summary.rows.filter((row) => row.total === 1)).toHaveLength(3);
    expect(departmentOf(summary, DEPT).total).toBe(1);
  });

  it("adds up to the totals, including tasks with nobody on them", () => {
    const summary = summarise(
      [
        task({ id: "a", assignee_id: "ana" }),
        task({ id: "b" }),
        task({ id: "c", department_id: OTHER }),
      ],
      [],
      [person("ana", "Ana")],
      new Map(),
      [DEPT, OTHER],
    );

    const summed = summary.departments.reduce((count, department) => count + department.total, 0);
    expect(summed).toBe(summary.totals.total);
    expect(summary.unassigned).toBe(2);
  });

  it("keeps a department with no tasks, so the page can draw an empty ring", () => {
    const summary = summarise([task()], [], [], new Map(), [DEPT, OTHER]);

    expect(departmentOf(summary, OTHER)).toMatchObject({ total: 0, notStarted: 0, completed: 0 });
  });

  it("keeps the order the ids were passed in, not the busiest first", () => {
    const summary = summarise(
      [task({ id: "a", department_id: OTHER }), task({ id: "b", department_id: OTHER })],
      [],
      [],
      new Map(),
      [DEPT, OTHER],
    );

    expect(summary.departments.map((department) => department.departmentId)).toEqual([DEPT, OTHER]);
  });

  it("still counts a task from outside the seeded list, rather than losing it", () => {
    const summary = summarise([task({ department_id: "dept-x" })], [], [], new Map(), [DEPT]);

    expect(departmentOf(summary, "dept-x").total).toBe(1);
    expect(summary.totals.total).toBe(1);
  });
});


/**
 * The sample behind the ring's hover panel. The cap and the ORDER are the whole
 * contract: a panel showing four arbitrary titles is trivia, and four the
 * reader should look at next is the reason to open it.
 */
describe("summariseWorkload — the hover sample", () => {
  function samplesOf(summary: ReturnType<typeof summarise>) {
    return departmentOf(summary, DEPT).samples;
  }

  it("files each task under the stage its status puts it in", () => {
    const summary = summarise(
      [
        task({ id: "a", title: "Open one", status: "OPEN" }),
        task({ id: "b", title: "Running", status: "ONGOING" }),
        task({ id: "c", title: "Finished", status: TERMINAL_STATUSES[0] }),
      ],
      [],
      [],
      new Map(),
      [DEPT],
    );

    const samples = samplesOf(summary);
    expect(samples.notStarted.map((sample) => sample.title)).toEqual(["Open one"]);
    expect(samples.active.map((sample) => sample.title)).toEqual(["Running"]);
    expect(samples.completed.map((sample) => sample.title)).toEqual(["Finished"]);
  });

  it("puts overdue first, then the soonest due date, then the undated", () => {
    const summary = summarise(
      [
        task({ id: "a", title: "No date", due_date: null }),
        task({ id: "b", title: "Due later", due_date: "2026-12-01" }),
        task({ id: "c", title: "Late", due_date: "2026-09-01" }),
        task({ id: "d", title: "Due soon", due_date: "2026-09-15" }),
      ],
      [],
      [],
      new Map(),
      [DEPT],
    );

    expect(samplesOf(summary).notStarted.map((sample) => sample.title)).toEqual([
      "Late",
      "Due soon",
      "Due later",
      "No date",
    ]);
  });

  it("never marks finished work overdue, however late it landed", () => {
    const summary = summarise(
      [task({ title: "Shipped late", status: TERMINAL_STATUSES[0], due_date: "2026-01-01" })],
      [],
      [],
      new Map(),
      [DEPT],
    );

    expect(samplesOf(summary).completed[0]).toMatchObject({ overdue: false });
  });

  it("caps the sample while the count stays whole", () => {
    const tasks = Array.from({ length: STAGE_SAMPLE_LIMIT + 3 }, (_, index) =>
      task({ id: `t${index}`, title: `Task ${index}`, due_date: `2026-09-0${index + 1}` }),
    );

    const summary = summarise(tasks, [], [], new Map(), [DEPT]);

    expect(samplesOf(summary).notStarted).toHaveLength(STAGE_SAMPLE_LIMIT);
    expect(departmentOf(summary, DEPT).notStarted).toBe(STAGE_SAMPLE_LIMIT + 3);
  });

  it("gives an empty department an empty sample for every stage, not undefined", () => {
    const summary = summarise([], [], [], new Map(), [DEPT]);

    expect(samplesOf(summary)).toEqual({ notStarted: [], active: [], completed: [] });
  });
});


/**
 * The same sample, per person — what /analytics hovers once a single department
 * is picked and the rings become one per team member.
 */
describe("summariseWorkload — the per-person sample", () => {
  it("gives each person on a shared task the same task in their own sample", () => {
    const summary = summarise(
      [task({ id: "a", title: "Shared work", assignee_id: "ana" })],
      [{ task_id: "a", user_id: "ben" }],
      [person("ana", "Ana"), person("ben", "Ben")],
      new Map(),
      [DEPT],
    );

    expect(rowOf(summary, "ana").samples.notStarted.map((s) => s.title)).toEqual(["Shared work"]);
    expect(rowOf(summary, "ben").samples.notStarted.map((s) => s.title)).toEqual(["Shared work"]);
    // And once in the department, which is the asymmetry the card warns about.
    expect(departmentOf(summary, DEPT).samples.notStarted).toHaveLength(1);
  });

  it("keeps a person's sample to their own work, not the department's", () => {
    const summary = summarise(
      [
        task({ id: "a", title: "Ana's", assignee_id: "ana" }),
        task({ id: "b", title: "Bens", assignee_id: "ben" }),
      ],
      [],
      [person("ana", "Ana"), person("ben", "Ben")],
      new Map(),
      [DEPT],
    );

    expect(rowOf(summary, "ana").samples.notStarted.map((s) => s.title)).toEqual(["Ana's"]);
    expect(departmentOf(summary, DEPT).samples.notStarted).toHaveLength(2);
  });

  it("gives somebody with nothing on an empty sample for every stage", () => {
    const summary = summarise([], [], [person("ana", "Ana")], new Map(), [DEPT]);

    expect(rowOf(summary, "ana").samples).toEqual({
      notStarted: [],
      active: [],
      completed: [],
    });
  });

  it("caps a person's sample the same way, while their count stays whole", () => {
    const tasks = Array.from({ length: STAGE_SAMPLE_LIMIT + 2 }, (_, index) =>
      task({ id: `t${index}`, title: `Task ${index}`, assignee_id: "ana" }),
    );

    const summary = summarise(tasks, [], [person("ana", "Ana")], new Map(), [DEPT]);

    expect(rowOf(summary, "ana").samples.notStarted).toHaveLength(STAGE_SAMPLE_LIMIT);
    expect(rowOf(summary, "ana").notStarted).toBe(STAGE_SAMPLE_LIMIT + 2);
  });
});
