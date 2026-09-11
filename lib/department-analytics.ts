import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { daysBetween } from "@/lib/dates";
import { INITIAL_TASK_STATUS, isTerminal } from "@/lib/schemas/tasks";

/**
 * P11-14 — DEPARTMENT ANALYTICS: how much work each person is carrying, and how
 * much of it is finished.
 *
 * Pure, and handed `today`, so the one rule in it worth arguing about — who
 * counts as "on" a task — has a test that does not depend on the clock:
 * `tests/unit/department-analytics.test.ts`.
 *
 * ⚠️ A PERSON IS ON A TASK THROUGH EITHER OF TWO COLUMNS, AND COUNTS ONCE.
 * `assignee_id` is the named person and `vizserve_pms_task_assignees` is
 * everybody else working it (P7-13). Internal tasks have no PIC at all
 * (P7-43), so reading `assignee_id` alone — which is what
 * `vizserve_pms_department_capacity` does — would drop most internal work from
 * the count. The two are unioned per task, so somebody named AND in the join
 * table is not counted twice.
 *
 * ⚠️ THE TOTALS COUNT TASKS, NOT PEOPLE-ON-TASKS. A task three people share is
 * one task in the department and one task on each of their rows, so the rows
 * deliberately do not add up to the totals.
 */

export type WorkloadTask = {
  id: string;
  status: VizservePmsTaskStatus;
  department_id: string;
  due_date: string | null;
  assignee_id: string | null;
};

export type WorkloadAssignment = { task_id: string; user_id: string };

export type WorkloadPerson = {
  id: string;
  full_name: string;
  department_id: string | null;
};

export type WorkloadCounts = {
  total: number;
  /** `OPEN` — nobody has started it. */
  notStarted: number;
  /** Every live status past `OPEN`: ongoing, waiting, QA, with the client. */
  active: number;
  /** Either ending — `COMPLETED` or `COMPLETED_NO_RESPONSE`. */
  completed: number;
  /** Past its due date and still live, as of `today`. */
  overdue: number;
};

export type WorkloadRow = WorkloadCounts & {
  id: string;
  name: string;
  /** Null for somebody who is on these tasks but outside the roster. */
  departmentId: string | null;
};

export type WorkloadSummary = {
  rows: WorkloadRow[];
  totals: WorkloadCounts;
  /** Tasks with nobody on them at all — work no row would otherwise show. */
  unassigned: number;
};

/**
 * The name for somebody on a task whose user row this viewer cannot read — a
 * colleague from another department. Named rather than dropped, so the row's
 * counts still add up to something a lead can account for.
 */
export const OUTSIDE_NAME = "Outside your departments";

function zero(): WorkloadCounts {
  return { total: 0, notStarted: 0, active: 0, completed: 0, overdue: 0 };
}

function tally(counts: WorkloadCounts, task: WorkloadTask, today: string) {
  counts.total += 1;

  if (isTerminal(task.status)) {
    counts.completed += 1;
    // Overdue only counts on live work. A task delivered late is history, and
    // counting it would make the figure only ever grow.
    return;
  }

  if (task.status === INITIAL_TASK_STATUS) counts.notStarted += 1;
  else counts.active += 1;

  // `daysBetween`, not `isOverdue`: that one reads the real clock, and this
  // function is handed `today` so it can be tested.
  const days = task.due_date ? daysBetween(today, task.due_date) : null;
  if (days !== null && days < 0) counts.overdue += 1;
}

export function summariseWorkload({
  tasks,
  assignments,
  roster,
  nameOf,
  today,
}: {
  tasks: WorkloadTask[];
  /** Join rows. Any for a task not in `tasks` are ignored. */
  assignments: WorkloadAssignment[];
  /** Everybody who gets a row even with nothing on their plate. */
  roster: WorkloadPerson[];
  /** Names for people on a task who are not in the roster. */
  nameOf: ReadonlyMap<string, string>;
  today: string;
}): WorkloadSummary {
  const peopleOn = new Map<string, Set<string>>();
  for (const task of tasks) {
    peopleOn.set(task.id, new Set(task.assignee_id ? [task.assignee_id] : []));
  }
  for (const assignment of assignments) {
    peopleOn.get(assignment.task_id)?.add(assignment.user_id);
  }

  /*
   * The roster is seeded FIRST, with zeroes. A person with no tasks is the most
   * useful row on this page for a lead deciding who takes the next one, and a
   * table built only from tasks would never show them.
   */
  const rows = new Map<string, WorkloadRow>();
  for (const person of roster) {
    rows.set(person.id, {
      id: person.id,
      name: person.full_name,
      departmentId: person.department_id,
      ...zero(),
    });
  }

  const totals = zero();
  let unassigned = 0;

  for (const task of tasks) {
    tally(totals, task, today);

    const people = peopleOn.get(task.id) ?? new Set<string>();
    if (people.size === 0) {
      unassigned += 1;
      continue;
    }

    for (const userId of people) {
      let row = rows.get(userId);
      if (!row) {
        row = { id: userId, name: nameOf.get(userId) ?? OUTSIDE_NAME, departmentId: null, ...zero() };
        rows.set(userId, row);
      }
      tally(row, task, today);
    }
  }

  return {
    rows: [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    totals,
    unassigned,
  };
}
