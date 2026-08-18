import { isTerminal, type TaskStatus } from "@/lib/schemas/tasks";
import { daysBetween } from "@/lib/dates";

/**
 * SLICE I — the only new logic on the dashboard, extracted so it can be tested
 * without React.
 *
 * A dashboard answers "what needs me, now". Every other query on that page is a
 * read of a path the db suites already cover; this is the part that decides what
 * the page SAYS, so it is the part worth a unit test.
 *
 * `today` is always passed in, never read here. `lib/dates.ts` owns the Manila
 * clock and a module that called `todayInAppZone()` internally would be
 * untestable at exactly the boundaries that matter — a task due "today" is a
 * different task at 23:00 Manila than it is at 01:00 UTC.
 */

/**
 * Where a task sits relative to now.
 *
 * `none` is a real answer and not a gap: most internal work carries no due date
 * at all, and calling that "later" would sort undated work in among things that
 * genuinely have a deadline next week.
 */
export type TaskBucket = "overdue" | "today" | "week" | "later" | "none";

/**
 * The bucket a task belongs in.
 *
 * TERMINAL TASKS NEVER BUCKET. A completed task delivered three weeks late is
 * history, not an alarm, and a dashboard that lists it is a dashboard people
 * learn to scroll past. Callers get `null` rather than a bucket, so a caller that
 * forgets to filter cannot accidentally show one.
 *
 * `start_date` is the fallback when there is no due date, and that is the whole
 * reason P7-06 shipped it: "I am meant to begin this today" is as much a claim on
 * somebody's morning as "this is due today", and until now the board was the
 * column's only reader in the app. A start date is never OVERDUE though — a day
 * you failed to begin on is not a missed deadline, and marking it as one would
 * put a permanent red row under anybody who plans more than a week ahead.
 */
export function bucketTask(
  task: { status: TaskStatus; due_date: string | null; start_date: string | null },
  today: string,
): TaskBucket | null {
  if (isTerminal(task.status)) return null;

  if (task.due_date) {
    const days = daysBetween(today, task.due_date);
    if (days === null) return "none";
    if (days < 0) return "overdue";
    if (days === 0) return "today";
    return days <= 7 ? "week" : "later";
  }

  if (task.start_date) {
    const days = daysBetween(today, task.start_date);
    if (days === null) return "none";
    // A start date in the past reads as "today" rather than "overdue": it is
    // still waiting to be picked up, which is a nudge and not a breach.
    return days <= 0 ? "today" : days <= 7 ? "week" : "later";
  }

  return "none";
}

/**
 * The order the "Needs you" list is read in.
 *
 * BY URGENCY, NOT BY SOURCE, and the ranking is the design rather than an
 * implementation detail — grouping by table would put a returned timesheet week
 * (somebody is stopped, waiting on this person) below a task due next Friday
 * purely because timesheets sort after tasks alphabetically.
 *
 * `returned` leads everything on the page. It is the only state in the app where
 * a NAMED person has stopped and is waiting on this user, which is a stronger
 * claim than any deadline.
 */
export const NEEDS_YOU_ORDER = [
  "returned",
  "overdue",
  "qa",
  "approval",
  "today",
  "starting",
] as const;

export type NeedsYouKind = (typeof NEEDS_YOU_ORDER)[number];

/** Lower sorts first. Unknown kinds sink rather than throwing. */
export function needsYouRank(kind: NeedsYouKind): number {
  const index = NEEDS_YOU_ORDER.indexOf(kind);
  return index === -1 ? NEEDS_YOU_ORDER.length : index;
}

/**
 * How many rows the list draws before it stops.
 *
 * Eight, and then "and N more" linking to the filtered list. A dashboard that
 * scrolls is a list page wearing a hat — the cap is what keeps this page a
 * summary of what needs doing rather than a second copy of `/tasks`.
 */
export const NEEDS_YOU_LIMIT = 8;

/**
 * The true sentence for an empty queue.
 *
 * NEVER "No data", and never a cheerful all-clear: the numbers on this page are
 * policy-scoped, so "nothing is due" and "nothing was returned to you" are
 * different claims and only one of them is safe to make. Saying how much open
 * work exists alongside it is what stops an empty queue reading as an empty
 * system.
 */
export function emptyNeedsYouMessage(openTasks: number): string {
  if (openTasks === 0) return "Nothing is due, and you have no open tasks.";
  return openTasks === 1
    ? "Nothing is due. One task is open."
    : `Nothing is due. ${openTasks} tasks are open.`;
}
