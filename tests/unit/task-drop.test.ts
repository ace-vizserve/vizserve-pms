import { describe, expect, it } from "vitest";

import { planTaskDrop, type DropRow } from "@/lib/task-drop";

/** P7-82. What each drop on the task list means. */

const row = (id: string, status = "OPEN", subRows?: DropRow[]): DropRow => ({
  id,
  title: id.toUpperCase(),
  status,
  parent_task_id: null,
  subRows,
});

const child = (id: string, parent: string, status = "OPEN"): DropRow => ({
  id,
  title: id.toUpperCase(),
  status,
  parent_task_id: parent,
});

const rows = [
  row("a"),
  row("b", "OPEN", [child("b1", "b"), child("b2", "b")]),
  row("c"),
  row("d", "ONGOING"),
];

describe("planTaskDrop — between rows", () => {
  it("moves a top-level row within its group", () => {
    expect(planTaskDrop(rows, "c", { kind: "row", id: "a", placement: "before" })).toEqual({
      kind: "apply",
      order: { parentId: null, status: "OPEN", ids: ["c", "a", "b"] },
    });
    expect(planTaskDrop(rows, "a", { kind: "row", id: "c", placement: "after" })).toEqual({
      kind: "apply",
      order: { parentId: null, status: "OPEN", ids: ["b", "c", "a"] },
    });
  });

  it("reorders subtasks inside their parent", () => {
    expect(planTaskDrop(rows, "b2", { kind: "row", id: "b1", placement: "before" })).toEqual({
      kind: "apply",
      order: { parentId: "b", status: null, ids: ["b2", "b1"] },
    });
  });

  it("nests a row dropped between subtasks under their parent", () => {
    expect(planTaskDrop(rows, "a", { kind: "row", id: "b1", placement: "after" })).toEqual({
      kind: "apply",
      parent: { id: "a", parentId: "b" },
      order: { parentId: "b", status: null, ids: ["b1", "a", "b2"] },
    });
  });

  it("lifts a subtask out when it is dropped between top-level rows", () => {
    expect(planTaskDrop(rows, "b1", { kind: "row", id: "c", placement: "after" })).toEqual({
      kind: "apply",
      parent: { id: "b1", parentId: null },
      order: { parentId: null, status: "OPEN", ids: ["a", "b", "c", "b1"] },
    });
  });

  it("refuses a drag into another status group", () => {
    expect(planTaskDrop(rows, "a", { kind: "row", id: "d", placement: "before" }).kind).toBe(
      "error",
    );
  });

  it("does nothing on itself", () => {
    expect(planTaskDrop(rows, "a", { kind: "row", id: "a", placement: "after" })).toEqual({
      kind: "none",
    });
  });
});

describe("planTaskDrop — on a title", () => {
  it("makes the dragged task a subtask", () => {
    expect(planTaskDrop(rows, "a", { kind: "nest", id: "c" })).toEqual({
      kind: "apply",
      parent: { id: "a", parentId: "c" },
    });
  });

  it("works across status groups — a subtask lives with its parent", () => {
    expect(planTaskDrop(rows, "d", { kind: "nest", id: "a" })).toEqual({
      kind: "apply",
      parent: { id: "d", parentId: "a" },
    });
  });

  it("refuses a subtask as the new parent — one level only", () => {
    expect(planTaskDrop(rows, "a", { kind: "nest", id: "b1" }).kind).toBe("error");
  });

  it("refuses to nest a task that has subtasks of its own", () => {
    expect(planTaskDrop(rows, "b", { kind: "nest", id: "a" }).kind).toBe("error");
  });

  it("does nothing when it is already that task's subtask", () => {
    expect(planTaskDrop(rows, "b1", { kind: "nest", id: "b" })).toEqual({ kind: "none" });
  });
});
