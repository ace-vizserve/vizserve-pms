import { describe, expect, it } from "vitest";

import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  comparePriority,
  taskPrioritySchema,
} from "@/lib/schemas/tasks";

/**
 * P7-11 — priority, in TypeScript.
 *
 * `tests/db/tasks.test.ts` proves Postgres sorts these the same way. These
 * cases prove the in-memory half agrees, because two orderings of the same four
 * values is exactly the drift this codebase keeps writing mirror tests to catch.
 */

describe("TASK_PRIORITIES", () => {
  it("is declared low to high", () => {
    // THE LOAD-BEARING ORDER. The SQL enum is declared in this sequence, and
    // `order by priority desc` in the database and `comparePriority` here are
    // both only correct because of it. Reversing the constant would invert
    // every priority sort in the app without a single type error.
    expect(TASK_PRIORITIES).toEqual(["LOW", "NORMAL", "HIGH", "URGENT"]);
  });

  it("labels every value", () => {
    for (const priority of TASK_PRIORITIES) {
      expect(TASK_PRIORITY_LABELS[priority]).toBeTruthy();
    }
  });
});

describe("taskPrioritySchema", () => {
  it("accepts null, because null is a value here", () => {
    // The picker's "Clear". Not an absence to be defaulted away — most tasks
    // have no priority and that is the ordinary state.
    expect(taskPrioritySchema.parse(null)).toBeNull();
  });

  it("accepts each declared value", () => {
    for (const priority of TASK_PRIORITIES) {
      expect(taskPrioritySchema.parse(priority)).toBe(priority);
    }
  });

  it("rejects a plausible value that is not in the enum", () => {
    // "CRITICAL" and "MEDIUM" are what people reach for from other trackers.
    expect(() => taskPrioritySchema.parse("CRITICAL")).toThrow();
    expect(() => taskPrioritySchema.parse("MEDIUM")).toThrow();
  });
});

describe("comparePriority", () => {
  it("puts the most urgent first", () => {
    const sorted = ["NORMAL", "URGENT", "LOW", "HIGH"].sort((a, b) =>
      comparePriority(a as never, b as never),
    );

    expect(sorted).toEqual(["URGENT", "HIGH", "NORMAL", "LOW"]);
  });

  it("sorts unranked tasks below LOW, not above it", () => {
    // The bug this exists to prevent: ranking null as 0 would TIE it with LOW,
    // and ranking it as "unset means normal" would float every unranked task
    // into the middle of the list. It belongs at the bottom.
    expect(comparePriority("LOW", null)).toBeLessThan(0);
    expect(comparePriority(null, "LOW")).toBeGreaterThan(0);
  });

  it("is stable between two unranked tasks", () => {
    // Zero, so whatever ordering the caller already had survives — otherwise a
    // list of unranked tasks would reshuffle on every render.
    expect(comparePriority(null, null)).toBe(0);
  });

  it("matches the declared order exactly", () => {
    // Walks the constant rather than restating it, so adding a fifth value with
    // no thought about where it ranks fails here rather than in a screen.
    for (let i = 1; i < TASK_PRIORITIES.length; i++) {
      expect(comparePriority(TASK_PRIORITIES[i]!, TASK_PRIORITIES[i - 1]!)).toBeLessThan(0);
    }
  });
});
