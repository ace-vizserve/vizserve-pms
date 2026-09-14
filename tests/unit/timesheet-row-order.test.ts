import { describe, expect, it } from "vitest";

import {
  orderRows,
  parseRowOrder,
  planRowDrop,
  planRowMove,
} from "@/lib/timesheet-row-order";

/**
 * P6-02c — the timesheet grid's row order.
 *
 * The drag itself is dnd-kit's and is not worth testing. These are the rules
 * underneath it: what a stored order means, what a drop means, and what the menu
 * means — and the menu is the path that has to keep working for everybody who
 * cannot drag, so it is the path tested here.
 */

/** The shape `orderRows` needs, and nothing more. */
const row = (taskId: string, title: string) => ({ taskId, title });

describe("parseRowOrder", () => {
  it("reads a stored order", () => {
    expect(parseRowOrder(JSON.stringify(["b", "a"]))).toEqual(["b", "a"]);
  });

  it("treats nothing stored as no order", () => {
    expect(parseRowOrder(null)).toEqual([]);
    expect(parseRowOrder("")).toEqual([]);
  });

  it("ignores a key somebody else wrote", () => {
    // Not an array: another feature's key, or an older shape of this one.
    expect(parseRowOrder(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseRowOrder("{not json")).toEqual([]);
  });

  it("drops entries that are not ids, and keeps the rest", () => {
    expect(parseRowOrder(JSON.stringify(["a", 7, null, "b"]))).toEqual(["a", "b"]);
  });

  it("dedupes, because a repeated id is an ambiguous position", () => {
    expect(parseRowOrder(JSON.stringify(["a", "b", "a"]))).toEqual(["a", "b"]);
  });
});

describe("orderRows", () => {
  const rows = [row("a", "Alpha"), row("b", "Beta"), row("c", "Gamma")];

  it("is alphabetical when nothing is stored — the grid's behaviour before this existed", () => {
    expect(orderRows([rows[2]!, rows[0]!, rows[1]!], []).map((r) => r.taskId)).toEqual(["a", "b", "c"]);
  });

  it("follows the stored order", () => {
    expect(orderRows(rows, ["c", "a", "b"]).map((r) => r.taskId)).toEqual(["c", "a", "b"]);
  });

  it("⚠️ puts a row the order does not name LAST, not where its title would", () => {
    // The regression this exists to prevent: slotting "Alpha" in alphabetically
    // would move it the moment its first cell was filled, because that is when
    // the server starts returning it and the grid rebuilds — a row jumping under
    // the cursor that just typed into it.
    expect(orderRows(rows, ["c", "b"]).map((r) => r.taskId)).toEqual(["c", "b", "a"]);
  });

  it("sorts the unnamed rows among themselves alphabetically", () => {
    expect(orderRows(rows, []).map((r) => r.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("skips an id that is no longer on the week", () => {
    // The task was taken off the week. Its position stays in storage so it lands
    // back where it was if it returns, but it cannot conjure a row.
    expect(orderRows([rows[0]!, rows[1]!], ["c", "b", "a"]).map((r) => r.taskId)).toEqual(["b", "a"]);
  });

  it("does not mutate what it was given", () => {
    const given = [rows[2]!, rows[0]!];
    orderRows(given, ["a"]);
    expect(given.map((r) => r.taskId)).toEqual(["c", "a"]);
  });
});

describe("planRowDrop", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves a row down onto the row it was dropped on", () => {
    expect(planRowDrop(ids, "a", "c")).toEqual(["b", "c", "a", "d"]);
  });

  it("moves a row up onto the row it was dropped on", () => {
    expect(planRowDrop(ids, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("⚠️ changes nothing when the drop names nothing — a gesture somebody abandoned", () => {
    // Never position zero: dropping into empty space is a cancel, and reading it
    // as "move to the top" rearranges a week nobody asked to rearrange.
    expect(planRowDrop(ids, "c", "")).toEqual(ids);
    expect(planRowDrop(ids, "c", "gone")).toEqual(ids);
  });

  it("changes nothing when a row is dropped on itself", () => {
    expect(planRowDrop(ids, "b", "b")).toEqual(ids);
  });
});

describe("planRowMove", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves up and down by one", () => {
    expect(planRowMove(ids, "c", "up")).toEqual(["a", "c", "b", "d"]);
    expect(planRowMove(ids, "b", "down")).toEqual(["a", "c", "b", "d"]);
  });

  it("moves to the ends", () => {
    expect(planRowMove(ids, "d", "top")).toEqual(["d", "a", "b", "c"]);
    expect(planRowMove(ids, "a", "bottom")).toEqual(["b", "c", "d", "a"]);
  });

  it("refuses a move off either end", () => {
    // The menu disables these items; this is the second guard, not the first.
    expect(planRowMove(ids, "a", "up")).toEqual(ids);
    expect(planRowMove(ids, "a", "top")).toEqual(ids);
    expect(planRowMove(ids, "d", "down")).toEqual(ids);
    expect(planRowMove(ids, "d", "bottom")).toEqual(ids);
  });

  it("changes nothing for a row that is not there", () => {
    expect(planRowMove(ids, "gone", "top")).toEqual(ids);
  });

  it("⚠️ agrees with a drop on the same move", () => {
    // Two orderings that agree today are two that disagree later, which is why
    // the drag and the menu are planned by functions that run the same list.
    expect(planRowMove(ids, "a", "bottom")).toEqual(planRowDrop(ids, "a", "d"));
    expect(planRowMove(ids, "c", "up")).toEqual(planRowDrop(ids, "c", "b"));
  });
});
