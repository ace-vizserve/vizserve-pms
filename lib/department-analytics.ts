import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { INITIAL_TASK_STATUS, isTaskOverdue, isTerminal } from "@/lib/schemas/tasks";

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
  /** Shown in the ring's hover panel, so a stage names its work. */
  title: string;
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

/**
 * WHAT IS ACTUALLY IN EACH SLICE — a few tasks per stage, for a ring's hover
 * panel. The count answers "how much"; this answers "which".
 *
 * ⚠️ A SAMPLE, NOT THE SLICE. It is capped, because the alternative is shipping
 * every task's title to the browser to fill a panel nobody may open — on a
 * department of 1,600 tasks that is the whole list, in the HTML, per ring. The
 * count beside it is the real figure and always the full one.
 *
 * MOST URGENT FIRST: overdue, then soonest due, then undated, then by title. A
 * panel showing four arbitrary titles is trivia; four the reader should look at
 * next is the reason to open it.
 */
export type StageSamples = Record<StageKey, StageSample[]>;

export type WorkloadRow = WorkloadCounts & {
  id: string;
  name: string;
  /** Null for somebody who is on these tasks but outside the roster. */
  departmentId: string | null;
  /** This person's own work, for their ring's hover panel. */
  samples: StageSamples;
};

/**
 * The same five counts, rolled up by department rather than by person.
 *
 * ⚠️ THESE ADD UP TO `totals`; THE PER-PERSON ROWS DO NOT. A task is filed in
 * exactly one department, so the department split is a true part-to-whole and
 * may be drawn as one — which is what /analytics' donuts rely on. A task three
 * people share lands on three `rows` and in exactly one `departments` entry.
 */
/** The three bands a ring is sliced into, in the order they are drawn. */
export type StageKey = "notStarted" | "active" | "completed";

/** One task, as the hover panel lists it. */
export type StageSample = {
  id: string;
  title: string;
  dueDate: string | null;
  overdue: boolean;
};

export type WorkloadDepartment = WorkloadCounts & {
  departmentId: string;
  /** The department's own work, for its ring's hover panel. */
  samples: StageSamples;
};

/** How many tasks a stage's hover panel names before it says "and N more". */
export const STAGE_SAMPLE_LIMIT = 4;

function stageOf(task: WorkloadTask): StageKey {
  if (isTerminal(task.status)) return "completed";
  return task.status === INITIAL_TASK_STATUS ? "notStarted" : "active";
}

/**
 * Urgent first. Overdue outranks everything; then the soonest due date; an
 * undated task sorts last, because "no date" is not "due far away"; then title,
 * so the order never depends on which row Postgres returned first.
 */
function byUrgency(a: StageSample, b: StageSample): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
}

export type WorkloadSummary = {
  rows: WorkloadRow[];
  totals: WorkloadCounts;
  /** One entry per department in scope, including any with no tasks at all. */
  departments: WorkloadDepartment[];
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

  // `today` is passed through rather than read here: this function is handed
  // the day so it can be tested, and two reads of the clock in one tally can
  // disagree near midnight.
  if (isTaskOverdue(task, today)) counts.overdue += 1;
}

export function summariseWorkload({
  tasks,
  assignments,
  roster,
  departmentIds = [],
  nameOf,
  today,
}: {
  tasks: WorkloadTask[];
  /** Join rows. Any for a task not in `tasks` are ignored. */
  assignments: WorkloadAssignment[];
  /** Everybody who gets a row even with nothing on their plate. */
  roster: WorkloadPerson[];
  /**
   * Every department on screen — the same seeding argument as `roster`. A
   * department whose tasks all fall outside the chosen period still gets an
   * entry, so the page draws an explicitly empty chart for it rather than
   * dropping the department and leaving a lead wondering where their team went.
   */
  departmentIds?: string[];
  /** Names for people on a task who are not in the roster. */
  nameOf: ReadonlyMap<string, string>;
  today: string;
}): WorkloadSummary {
  /*
   * Sample buckets, keyed by department id AND by user id in the same map. The
   * two id spaces are both uuids and cannot collide, and a ring is a ring
   * whether it belongs to a department or to a person — /analytics draws one
   * per department, and one per team member once a department is picked.
   */
  const samples = new Map<string, StageSamples>();
  const sampleFor = (key: string) => {
    let entry = samples.get(key);
    if (!entry) {
      entry = { notStarted: [], active: [], completed: [] };
      samples.set(key, entry);
    }
    return entry;
  };
  for (const departmentId of departmentIds) sampleFor(departmentId);

  /** Sorted and cut to size. The buckets are collected whole and trimmed here. */
  const trim = (key: string): StageSamples => {
    const stages = sampleFor(key);
    return {
      notStarted: stages.notStarted.sort(byUrgency).slice(0, STAGE_SAMPLE_LIMIT),
      active: stages.active.sort(byUrgency).slice(0, STAGE_SAMPLE_LIMIT),
      completed: stages.completed.sort(byUrgency).slice(0, STAGE_SAMPLE_LIMIT),
    };
  };

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
      // Filled in at the end, once every task has been seen.
      samples: { notStarted: [], active: [], completed: [] },
    });
  }

  // Seeded first, for the same reason the roster is.
  const departments = new Map<string, WorkloadCounts>();
  for (const departmentId of departmentIds) departments.set(departmentId, zero());

  const totals = zero();
  let unassigned = 0;

  for (const task of tasks) {
    tally(totals, task, today);

    // A task filed outside `departmentIds` still gets an entry rather than
    // being dropped: it is already in `totals`, and a slice missing from the
    // split underneath would make the two disagree.
    let department = departments.get(task.department_id);
    if (!department) {
      department = zero();
      departments.set(task.department_id, department);
    }
    tally(department, task, today);

    /*
     * Collected in full and cut to size at the end — a running top-N would have
     * to re-sort on every task, and the whole list is already in memory.
     *
     * ONE OBJECT PER TASK, SHARED by the department's bucket and by every
     * person on it. The samples are never mutated after this, so three people
     * on one task cost three pointers rather than three copies.
     */
    const stage = stageOf(task);
    const sample: StageSample = {
      id: task.id,
      title: task.title,
      dueDate: task.due_date,
      // ⚠️ THE SHARED RULE, NOT A RESTATEMENT OF IT. Finished work is never
      // late however it landed, and a panel calling a delivered task overdue
      // would contradict the red figure beside the ring. This read the rule
      // inline until P12-02 — see `isTaskOverdue`, which is what `tally` above
      // and every other screen now ask.
      overdue: isTaskOverdue(task, today),
    };
    sampleFor(task.department_id)[stage].push(sample);

    const people = peopleOn.get(task.id) ?? new Set<string>();
    if (people.size === 0) {
      unassigned += 1;
      continue;
    }

    for (const userId of people) {
      let row = rows.get(userId);
      if (!row) {
        row = {
          id: userId,
          name: nameOf.get(userId) ?? OUTSIDE_NAME,
          departmentId: null,
          ...zero(),
          samples: { notStarted: [], active: [], completed: [] },
        };
        rows.set(userId, row);
      }
      tally(row, task, today);
      sampleFor(userId)[stage].push(sample);
    }
  }

  return {
    rows: [...rows.values()]
      .map((row) => ({ ...row, samples: trim(row.id) }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    totals,
    /*
     * INSERTION ORDER, NOT VOLUME. The caller passes `departmentIds` already
     * sorted by name, so the small multiples keep one stable order across every
     * filter change. Sorting by volume would slide a department out from under
     * the reader's cursor the moment they narrow the period.
     */
    departments: [...departments.entries()].map(([departmentId, counts]) => ({
      departmentId,
      ...counts,
      samples: trim(departmentId),
    })),
    unassigned,
  };
}
