import { describe, expect, it } from "vitest";

import {
  NEEDS_YOU_ORDER,
  bucketTask,
  emptyNeedsYouMessage,
  needsYouRank,
} from "@/lib/dashboard";
import { TERMINAL_STATUSES } from "@/lib/schemas/tasks";

/**
 * Slice I's only new logic.
 *
 * `today` is a fixed string in every case here, never `todayInAppZone()`. A test
 * that reads the real clock passes at 09:00 Manila and fails at 01:00 UTC, which
 * is the exact class of bug `lib/dates.ts` exists to prevent — and the DTR suite
 * already had one (`4e0caea`, "make the shift-inversion test clock-independent").
 */
const TODAY = "2026-08-19";

describe("bucketTask", () => {
  it("puts a task due today in `today`, not in `week`", () => {
    expect(bucketTask({ status: "ONGOING", due_date: TODAY, start_date: null }, TODAY)).toBe(
      "today",
    );
  });

  it("puts yesterday in `overdue`", () => {
    expect(
      bucketTask({ status: "ONGOING", due_date: "2026-08-18", start_date: null }, TODAY),
    ).toBe("overdue");
  });

  it("splits `week` from `later` at seven days", () => {
    // The boundary in both directions, because an off-by-one here silently moves
    // a whole day's work off the page.
    expect(
      bucketTask({ status: "ONGOING", due_date: "2026-08-26", start_date: null }, TODAY),
    ).toBe("week");
    expect(
      bucketTask({ status: "ONGOING", due_date: "2026-08-27", start_date: null }, TODAY),
    ).toBe("later");
  });

  it("never buckets a terminal task, whichever ending it had", () => {
    // Both, from the constant rather than two hand-written strings: COMPLETED and
    // COMPLETED_NO_RESPONSE are deliberately distinct and a test naming only one
    // would pass while the other kept appearing on the dashboard.
    for (const status of TERMINAL_STATUSES) {
      expect(bucketTask({ status, due_date: "2026-01-01", start_date: null }, TODAY)).toBeNull();
    }
  });

  it("falls back to `start_date` when there is no due date", () => {
    expect(
      bucketTask({ status: "OPEN", due_date: null, start_date: "2026-08-21" }, TODAY),
    ).toBe("week");
  });

  it("reads a past start date as `today`, never as overdue", () => {
    // A day you failed to begin on is not a missed deadline. Calling it overdue
    // would put a permanent red row under anyone who plans a month ahead.
    expect(
      bucketTask({ status: "OPEN", due_date: null, start_date: "2026-07-01" }, TODAY),
    ).toBe("today");
  });

  it("prefers the due date when both are set", () => {
    expect(
      bucketTask({ status: "ONGOING", due_date: "2026-08-18", start_date: "2026-09-01" }, TODAY),
    ).toBe("overdue");
  });

  it("returns `none` for a task with neither date", () => {
    // The ordinary state for most internal work, and NOT the same as `later`:
    // undated work must not sort in among things that have a real deadline.
    expect(bucketTask({ status: "ONGOING", due_date: null, start_date: null }, TODAY)).toBe(
      "none",
    );
  });

  it("returns `none` for an unparseable date rather than throwing", () => {
    // Dates reach this from the database, so they are well-formed in practice —
    // but a bucket function that throws takes the whole dashboard down with it.
    expect(bucketTask({ status: "ONGOING", due_date: "not-a-date", start_date: null }, TODAY)).toBe(
      "none",
    );
  });
});

describe("needsYouRank", () => {
  it("ranks a returned timesheet week above everything else", () => {
    // The only state where a named person has stopped and is waiting on this
    // user, which outranks any deadline.
    for (const kind of NEEDS_YOU_ORDER) {
      if (kind === "returned") continue;
      expect(needsYouRank("returned")).toBeLessThan(needsYouRank(kind));
    }
  });

  it("ranks overdue work above work due today", () => {
    expect(needsYouRank("overdue")).toBeLessThan(needsYouRank("today"));
  });

  it("ranks a task starting today last", () => {
    for (const kind of NEEDS_YOU_ORDER) {
      if (kind === "starting") continue;
      expect(needsYouRank("starting")).toBeGreaterThan(needsYouRank(kind));
    }
  });
});

describe("emptyNeedsYouMessage", () => {
  it("says how much open work there is rather than claiming an all-clear", () => {
    expect(emptyNeedsYouMessage(3)).toBe("Nothing is due. 3 tasks are open.");
  });

  it("agrees with itself in the singular", () => {
    expect(emptyNeedsYouMessage(1)).toBe("Nothing is due. One task is open.");
  });

  it("distinguishes an empty queue from an empty system", () => {
    expect(emptyNeedsYouMessage(0)).toBe("Nothing is due, and you have no open tasks.");
  });
});
