import { addDays, daysBetween, startOfWeek, toAppDateString } from "@/lib/dates";
import type { AttendanceSummary } from "@/lib/attendance-summary";
import type { VizservePmsTaskStatus } from "@/lib/database.types";

/**
 * P15-02 — PERFORMANCE: the figures a lead reads to judge a department or a
 * person. Pure functions over rows the loader (`lib/performance-server.ts`)
 * already scoped, so every number here is testable without a database.
 *
 * ⚠️ EVERY RATE CARRIES ITS DENOMINATOR. "80% on time" over five dated tasks and
 * over two hundred are different claims, and about a third of tasks have no due
 * date at all. A rate is `{ hit, of }` and the screen prints both; a rate with
 * `of === 0` is "not measurable", never 0% and never 100%.
 *
 * ⚠️ NO SINGLE SCORE. Each measure stands on its own, compared with the
 * department's average and with the previous period. A blended score hides
 * which of the twelve things went wrong.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type WorkKind = "client" | "internal" | "personal";

export type PerfTask = {
  id: string;
  title: string;
  status: VizservePmsTaskStatus;
  departmentId: string;
  listId: string | null;
  dueDate: string | null;
  createdAt: string;
  /** Last touched — any edit or move. The "stale" test reads this. */
  updatedAt: string;
  /** Everyone doing it: the PIC column plus the assignee table. */
  doers: string[];
  qaId: string | null;
  kind: WorkKind;
  priority: string | null;
  estimateMinutes: number | null;
};

export type PerfMove = {
  taskId: string;
  from: VizservePmsTaskStatus | null;
  to: VizservePmsTaskStatus;
  actorId: string | null;
  at: string;
};

export type PerfEntry = { userId: string; taskId: string; minutes: number; workDate: string };

export type PerfWeek = {
  userId: string;
  weekStart: string;
  status: "SUBMITTED" | "RETURNED" | "APPROVED";
  submittedAt: string | null;
};

export type PerfPunch = { userId: string; workDate: string; timeIn: string | null; timeOut: string | null };

export type Period = { from: string; to: string };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export type Rate = { hit: number; of: number };

export function percent(rate: Rate): number | null {
  return rate.of === 0 ? null : Math.round((rate.hit / rate.of) * 100);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

const DONE: VizservePmsTaskStatus[] = ["COMPLETED", "COMPLETED_NO_RESPONSE"];
const QA: VizservePmsTaskStatus[] = ["FOR_QA", "QA_IN_PROGRESS"];

export function isDone(status: VizservePmsTaskStatus): boolean {
  return DONE.includes(status);
}

/** The app-zone day a timestamp falls on. */
function dayOf(at: string): string {
  return toAppDateString(new Date(at));
}

function inPeriod(day: string, period: Period): boolean {
  return day >= period.from && day <= period.to;
}

/** The period of equal length that ends the day before this one starts. */
export function previousPeriod(period: Period): Period {
  const length = (daysBetween(period.from, period.to) ?? 0) + 1;
  const to = addDays(period.from, -1) ?? period.from;
  return { from: addDays(to, -(length - 1)) ?? to, to };
}

/** A QA reviewer moving work back out of QA rather than on to the client or done. */
export function isQaReturn(move: Pick<PerfMove, "from" | "to">): boolean {
  return (
    move.from !== null &&
    QA.includes(move.from) &&
    !QA.includes(move.to) &&
    move.to !== "FOR_CLIENT_APPROVAL" &&
    !isDone(move.to)
  );
}

function hoursBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 3_600_000;
}

// ---------------------------------------------------------------------------
// Delivery & quality — for any set of tasks (a department, or one person's)
// ---------------------------------------------------------------------------

/** Where time goes between creation and completion. */
export const STAGE_BUCKETS = [
  { key: "work", label: "Doing the work", statuses: ["OPEN", "ONGOING"] },
  { key: "info", label: "Waiting for info", statuses: ["WAITING_FOR_INFO"] },
  { key: "qaQueue", label: "Waiting for QA", statuses: ["FOR_QA"] },
  { key: "qa", label: "In QA", statuses: ["QA_IN_PROGRESS"] },
  { key: "client", label: "With the client", statuses: ["FOR_CLIENT_APPROVAL"] },
] as const satisfies readonly { key: string; label: string; statuses: VizservePmsTaskStatus[] }[];

export type StageKey = (typeof STAGE_BUCKETS)[number]["key"];

export type Delivery = {
  completed: number;
  onTime: Rate;
  /** Median days from created to its last completion in the period. */
  cycleDays: number | null;
  /** Of the tasks completed that went through QA, how many passed first time. */
  firstPass: Rate;
  qaReturns: number;
  /** Mean hours per completed task spent in each stage. */
  stageHours: Record<StageKey, number | null>;
  /** Completed per ISO week (Monday), oldest first. */
  throughput: { weekStart: string; completed: number }[];
  /** Logged ÷ estimated, median over completed tasks that had an estimate. */
  estimateRatio: number | null;
  estimated: number;
};

export function delivery(
  tasks: PerfTask[],
  moves: PerfMove[],
  period: Period,
  /** All-time minutes logged per task, for estimate accuracy. */
  loggedByTask: Map<string, number> = new Map(),
): Delivery {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const movesByTask = new Map<string, PerfMove[]>();
  for (const move of moves) {
    if (!taskById.has(move.taskId)) continue;
    const list = movesByTask.get(move.taskId) ?? [];
    list.push(move);
    movesByTask.set(move.taskId, list);
  }
  for (const list of movesByTask.values()) list.sort((a, b) => a.at.localeCompare(b.at));

  // A task's LAST completion inside the period — a reopened-and-recompleted
  // task counts once, when it finally closed.
  const completedAt = new Map<string, string>();
  for (const [taskId, list] of movesByTask) {
    for (const move of list) {
      // A real completion is a MOVE to done. The ClickUp import created finished
      // tasks as finished, with no previous status; those are not completions.
      if (isDone(move.to) && move.from !== null && inPeriod(dayOf(move.at), period)) completedAt.set(taskId, move.at);
    }
  }

  const onTime: Rate = { hit: 0, of: 0 };
  const firstPass: Rate = { hit: 0, of: 0 };
  const cycle: number[] = [];
  const stageTotals: Record<StageKey, number[]> = { work: [], info: [], qaQueue: [], qa: [], client: [] };
  const ratios: number[] = [];
  let qaReturns = 0;

  for (const [taskId, doneAt] of completedAt) {
    const task = taskById.get(taskId)!;
    const list = (movesByTask.get(taskId) ?? []).filter((move) => move.at <= doneAt);

    if (task.dueDate) {
      onTime.of += 1;
      if (dayOf(doneAt) <= task.dueDate) onTime.hit += 1;
    }

    cycle.push(hoursBetween(task.createdAt, doneAt) / 24);

    const returns = list.filter(isQaReturn).length;
    const wentThroughQa = list.some((move) => QA.includes(move.to));
    if (wentThroughQa) {
      firstPass.of += 1;
      if (returns === 0) firstPass.hit += 1;
    }

    // Time in each stage: from entering a status to the next move.
    const spent: Record<StageKey, number> = { work: 0, info: 0, qaQueue: 0, qa: 0, client: 0 };
    for (let index = 0; index < list.length; index += 1) {
      const move = list[index]!;
      const next = list[index + 1];
      if (!next) break;
      const bucket = STAGE_BUCKETS.find((stage) =>
        (stage.statuses as readonly VizservePmsTaskStatus[]).includes(move.to),
      );
      if (bucket) spent[bucket.key] += Math.max(0, hoursBetween(move.at, next.at));
    }
    for (const stage of STAGE_BUCKETS) stageTotals[stage.key].push(spent[stage.key]);

    if (task.estimateMinutes && task.estimateMinutes > 0) {
      const logged = loggedByTask.get(taskId) ?? 0;
      if (logged > 0) ratios.push(logged / task.estimateMinutes);
    }
  }

  for (const [taskId, list] of movesByTask) {
    for (const move of list) {
      if (isQaReturn(move) && inPeriod(dayOf(move.at), period) && taskById.has(taskId)) qaReturns += 1;
    }
  }

  const weeks = new Map<string, number>();
  for (let week = startOfWeek(period.from); week && week <= period.to; week = addDays(week, 7)) {
    weeks.set(week, 0);
  }
  for (const doneAt of completedAt.values()) {
    const week = startOfWeek(dayOf(doneAt));
    if (week && weeks.has(week)) weeks.set(week, (weeks.get(week) ?? 0) + 1);
  }

  return {
    completed: completedAt.size,
    onTime,
    cycleDays: median(cycle),
    firstPass,
    qaReturns,
    stageHours: Object.fromEntries(
      STAGE_BUCKETS.map((stage) => [stage.key, mean(stageTotals[stage.key])]),
    ) as Record<StageKey, number | null>,
    throughput: [...weeks.entries()].map(([weekStart, completed]) => ({ weekStart, completed })),
    estimateRatio: median(ratios),
    estimated: ratios.length,
  };
}

// ---------------------------------------------------------------------------
// Workload — open work right now
// ---------------------------------------------------------------------------

export type Workload = {
  open: number;
  overdue: number;
  /** Mean days past due, over the overdue ones. */
  overdueDays: number | null;
  dueSoon: number;
  /** Open tasks by age since created. */
  age: { fresh: number; month: number; old: number };
  /** Open and untouched for 14 days or more. */
  stale: number;
  unassigned: number;
};

export const STALE_DAYS = 14;
export const DUE_SOON_DAYS = 7;

export function workload(tasks: PerfTask[], today: string): Workload {
  // P16-03 — a cancelled task is neither open nor done; it leaves the figures.
  const open = tasks.filter((task) => !isDone(task.status) && task.status !== "CANCELLED");
  const overdue = open.filter((task) => task.dueDate !== null && task.dueDate < today);
  const soonEnd = addDays(today, DUE_SOON_DAYS) ?? today;

  const age = { fresh: 0, month: 0, old: 0 };
  let stale = 0;
  for (const task of open) {
    const days = daysBetween(dayOf(task.createdAt), today) ?? 0;
    if (days <= 7) age.fresh += 1;
    else if (days <= 30) age.month += 1;
    else age.old += 1;
    if ((daysBetween(dayOf(task.updatedAt), today) ?? 0) >= STALE_DAYS) stale += 1;
  }

  return {
    open: open.length,
    overdue: overdue.length,
    overdueDays: mean(overdue.map((task) => daysBetween(task.dueDate!, today) ?? 0)),
    dueSoon: open.filter((task) => task.dueDate !== null && task.dueDate >= today && task.dueDate <= soonEnd)
      .length,
    age,
    stale,
    unassigned: open.filter((task) => task.doers.length === 0).length,
  };
}

// ---------------------------------------------------------------------------
// QA reviewers
// ---------------------------------------------------------------------------

export type ReviewerRow = { userId: string; reviews: number; waitHours: number | null; returns: number };

/**
 * Per reviewer: reviews finished, how long work waited in "For QA" before they
 * picked it up (median hours), and how many they sent back. Attributed to the
 * person who MADE the move, not to whoever is in the QA column now.
 */
export function reviewers(moves: PerfMove[], period: Period): ReviewerRow[] {
  const byTask = new Map<string, PerfMove[]>();
  for (const move of moves) {
    const list = byTask.get(move.taskId) ?? [];
    list.push(move);
    byTask.set(move.taskId, list);
  }

  const rows = new Map<string, { reviews: number; waits: number[]; returns: number }>();
  const row = (id: string) => {
    const existing = rows.get(id) ?? { reviews: 0, waits: [], returns: 0 };
    rows.set(id, existing);
    return existing;
  };

  for (const list of byTask.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    for (let index = 0; index < list.length; index += 1) {
      const move = list[index]!;
      if (!move.actorId || !inPeriod(dayOf(move.at), period)) continue;
      const previous = list[index - 1];

      if (move.from === "FOR_QA" && previous?.to === "FOR_QA") {
        row(move.actorId).waits.push(hoursBetween(previous.at, move.at));
      }
      if (move.from === "QA_IN_PROGRESS") {
        row(move.actorId).reviews += 1;
        if (isQaReturn(move)) row(move.actorId).returns += 1;
      }
    }
  }

  return [...rows.entries()]
    .map(([userId, value]) => ({
      userId,
      reviews: value.reviews,
      waitHours: median(value.waits),
      returns: value.returns,
    }))
    .filter((value) => value.reviews > 0 || value.waitHours !== null)
    .sort((a, b) => b.reviews - a.reviews);
}

// ---------------------------------------------------------------------------
// Time — hours, the split, and timesheet compliance
// ---------------------------------------------------------------------------

export type TimeFigures = {
  minutes: number;
  byKind: Record<WorkKind, number>;
  /** Clocked-in minutes, less each person's unpaid break, on days they punched. */
  clockedMinutes: number;
  /** Logged ÷ clocked, over days with both. */
  accounted: Rate;
};

export function timeFigures(
  entries: PerfEntry[],
  punches: PerfPunch[],
  kindOf: Map<string, WorkKind>,
  breakOf: Map<string, number>,
  period: Period,
): TimeFigures {
  const inside = entries.filter((entry) => inPeriod(entry.workDate, period));
  const byKind: Record<WorkKind, number> = { client: 0, internal: 0, personal: 0 };
  for (const entry of inside) byKind[kindOf.get(entry.taskId) ?? "internal"] += entry.minutes;

  let clocked = 0;
  const loggedOnDay = new Map<string, number>();
  for (const entry of inside) {
    const key = `${entry.userId}:${entry.workDate}`;
    loggedOnDay.set(key, (loggedOnDay.get(key) ?? 0) + entry.minutes);
  }

  const accounted: Rate = { hit: 0, of: 0 };
  for (const punch of punches) {
    if (!inPeriod(punch.workDate, period) || !punch.timeIn || !punch.timeOut) continue;
    const span = Math.round((Date.parse(punch.timeOut) - Date.parse(punch.timeIn)) / 60_000);
    if (span <= 0) continue;
    const worked = Math.max(0, span - (breakOf.get(punch.userId) ?? 0));
    clocked += worked;
    accounted.of += worked;
    accounted.hit += Math.min(worked, loggedOnDay.get(`${punch.userId}:${punch.workDate}`) ?? 0);
  }

  return {
    minutes: inside.reduce((total, entry) => total + entry.minutes, 0),
    byKind,
    clockedMinutes: clocked,
    accounted,
  };
}

export type Compliance = {
  /** Weeks that had ended, in the period, with at least one working day not on leave. */
  expected: number;
  submitted: number;
  /** Submitted by the end of the following Monday. */
  onTime: number;
  returned: number;
  missing: number;
};

/**
 * Timesheet weeks per person.
 *
 * A week is EXPECTED once it has ended (its Sunday is before today) and it
 * overlaps the period, unless the person was not due to work any of it —
 * `workingDays(userId, weekStart)` answers that from the attendance roll-up.
 * ON TIME means submitted by the end of the Monday after the week.
 */
export function compliance(
  userId: string,
  weeks: PerfWeek[],
  period: Period,
  today: string,
  workingDays: (userId: string, weekStart: string) => number,
): Compliance {
  const mine = new Map(weeks.filter((week) => week.userId === userId).map((week) => [week.weekStart, week]));
  const result: Compliance = { expected: 0, submitted: 0, onTime: 0, returned: 0, missing: 0 };

  for (let week = startOfWeek(period.from); week && week <= period.to; week = addDays(week, 7)) {
    const sunday = addDays(week, 6)!;
    if (sunday >= today) continue;
    if (workingDays(userId, week) === 0) continue;

    result.expected += 1;
    const row = mine.get(week);
    if (!row) {
      result.missing += 1;
      continue;
    }
    if (row.status === "RETURNED") result.returned += 1;
    else result.submitted += 1;
    if (row.submittedAt && dayOf(row.submittedAt) <= addDays(week, 7)!) result.onTime += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per person — the People table and the person page
// ---------------------------------------------------------------------------

export type PersonFigures = {
  userId: string;
  name: string;
  departmentId: string | null;
  workload: Workload;
  delivery: Delivery;
  time: TimeFigures;
  compliance: Compliance;
  attendance: Pick<AttendanceSummary, "workingDays" | "present" | "onLeave" | "absent" | "late" | "lateMinutes" | "undertime" | "unscheduled"> | null;
  missingPunches: number;
  corrections: number;
  overtimeMinutes: number;
  reviews: number;
  rating: { average: number | null; count: number };
  clientRevisions: number;
};

/** The tasks a person is DOING — not the ones they only review. */
export function tasksDoneBy(tasks: PerfTask[], userId: string): PerfTask[] {
  return tasks.filter((task) => task.doers.includes(userId));
}

/** Department average of a per-person number, over people it applies to. */
export function averageOf(rows: PersonFigures[], pick: (row: PersonFigures) => number | null): number | null {
  return mean(rows.map(pick).filter((value): value is number => value !== null));
}

/** "+12%" / "−3 pts" style change against the previous period, or null. */
export function change(now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null;
  return now - before;
}

// ---------------------------------------------------------------------------
// When the records start — so a comparison is not made against nothing
// ---------------------------------------------------------------------------

/**
 * P15-02 — THE FIRST DAY EACH KIND OF RECORD EXISTS IN THIS APP, read from the
 * live data on 1 Oct 2026. Before these dates there is nothing to compare with:
 * the app went live on 24 Aug, ClickUp tasks were imported on 3 Sep without
 * their history, and the first client request came through the form on 23 Sep.
 * Comparing September with an August that holds no completions reads as a huge
 * improvement that never happened.
 */
export const RECORDS_START = {
  /** Task moves: completions, QA, cycle time. */
  tasks: "2026-09-03",
  /** Clock-ins, timesheets, leave, overtime, corrections. */
  time: "2026-08-24",
  /** Client requests, Gate 1, client answers and ratings. */
  client: "2026-09-23",
} as const;

/**
 * Null when the earlier period is mostly on record (80% of its days or more),
 * otherwise the sentence to show instead of a comparison.
 */
export function earlierNote(previous: Period, start: string): string | null {
  const length = (daysBetween(previous.from, previous.to) ?? 0) + 1;
  const firstTracked = previous.from > start ? previous.from : start;
  const tracked = firstTracked > previous.to ? 0 : (daysBetween(firstTracked, previous.to) ?? 0) + 1;
  if (length > 0 && tracked / length >= 0.8) return null;
  const [year, month, day] = start.split("-").map(Number);
  const label = new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `no records before ${label} to compare`;
}
