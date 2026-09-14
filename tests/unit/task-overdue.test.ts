import { describe, expect, it } from "vitest";

import { TASK_STATUSES, isTaskOverdue, isTerminal, type TaskStatus } from "@/lib/schemas/tasks";

/**
 * `isTaskOverdue` — the one definition of a late task.
 *
 * It exists because `isOverdue` in `lib/dates.ts` answers a question about a
 * DATE and cannot answer this one: it has no status to look at, so every caller
 * had to remember `&& !isTerminal(task.status)` on its own. Ten did and one did
 * not — `/tasks/board` is the only screen that renders the finished columns, so
 * a task completed after its due date drew a permanent red `· overdue` chip
 * there. These tests are what stop the twelfth caller getting it wrong.
 *
 * ⚠️ "OVERDUE" MEANS LATE RIGHT NOW, NEVER "WAS FINISHED LATE". Nothing in this
 * app asks the second question and there is no `completed_at` column to ask it
 * with. If a test here ever asserts that a COMPLETED task is overdue, the rule
 * has been reversed rather than extended.
 */

const TODAY = "2026-09-14";

function task(status: TaskStatus, due: string | null) {
  return { status, due_date: due };
}

describe("isTaskOverdue — live work only", () => {
  it("is false for every terminal status, however late the date", () => {
    // The whole reported bug, as an assertion. A year past due and finished is
    // still finished.
    for (const status of TASK_STATUSES.filter((each) => isTerminal(each))) {
      expect(isTaskOverdue(task(status, "2025-01-01"), TODAY)).toBe(false);
    }
  });

  it("is true for every live status past its due date", () => {
    // Derived from the enum rather than listed, so a ninth status is covered
    // the day it is added instead of the day somebody remembers this file.
    for (const status of TASK_STATUSES.filter((each) => !isTerminal(each))) {
      expect(isTaskOverdue(task(status, "2026-09-13"), TODAY)).toBe(true);
    }
  });

  it("lets an out-of-scope task be judged on its date alone", () => {
    // A null status is the timesheet's case: the row survives, the name of the
    // work does not. Unknown is not finished, so the date still decides.
    expect(isTaskOverdue({ status: null, due_date: "2026-09-13" }, TODAY)).toBe(true);
    expect(isTaskOverdue({ status: null, due_date: "2026-09-15" }, TODAY)).toBe(false);
  });
});

describe("isTaskOverdue — the date comparison", () => {
  it("does not call a task due today overdue", () => {
    // Strictly before. Somebody has the rest of the day, and a bar that turns
    // red the morning it is due is one people learn to ignore.
    expect(isTaskOverdue(task("ONGOING", TODAY), TODAY)).toBe(false);
  });

  it("calls yesterday overdue and tomorrow not", () => {
    expect(isTaskOverdue(task("ONGOING", "2026-09-13"), TODAY)).toBe(true);
    expect(isTaskOverdue(task("ONGOING", "2026-09-15"), TODAY)).toBe(false);
  });

  it("never calls a task with no due date overdue", () => {
    // A date nobody set is not a promise broken.
    expect(isTaskOverdue(task("ONGOING", null), TODAY)).toBe(false);
    expect(isTaskOverdue({ status: "ONGOING" }, TODAY)).toBe(false);
  });

  it("treats an unparseable date as no date rather than as late", () => {
    // `daysBetween` returns null, and null must not fall through to `< 0`.
    expect(isTaskOverdue(task("ONGOING", "banana"), TODAY)).toBe(false);
  });

  it("crosses a month and a year boundary without arithmetic drift", () => {
    // `parseDateOnly` pins a bare date to midday UTC precisely so a negative
    // offset cannot shift it onto the previous day.
    expect(isTaskOverdue(task("ONGOING", "2026-08-31"), "2026-09-01")).toBe(true);
    expect(isTaskOverdue(task("ONGOING", "2026-01-01"), "2025-12-31")).toBe(false);
    expect(isTaskOverdue(task("ONGOING", "2025-12-31"), "2026-01-01")).toBe(true);
  });

  it("reads the clock only when it is not given a day", () => {
    // The `today` parameter is what lets a tally pass one day through every
    // row. Two reads of the clock in one loop can disagree near midnight.
    expect(isTaskOverdue(task("ONGOING", "2000-01-01"))).toBe(true);
    expect(isTaskOverdue(task("ONGOING", "2099-01-01"))).toBe(false);
  });
});
