/**
 * P7-82 — what a drop on the task list MEANS. Pure, so it can be tested without
 * a pointer, and so `task-dnd.tsx` only has to report where the row landed.
 *
 * Two gestures:
 *
 *   ON A TITLE   → the dragged task becomes that task's subtask.
 *   BETWEEN ROWS → it takes that place. Between two subtasks it joins their
 *                  parent; between two top-level rows it leaves any parent it
 *                  had.
 *
 * The one-level rule and the same-department rule are the P7-09 trigger's, and
 * the database says no in its own words. What is refused HERE is only what can
 * be known from the screen, so the person hears it before the round trip.
 */

export type DropRow = {
  id: string;
  title: string;
  status: string;
  parent_task_id: string | null;
  subRows?: DropRow[];
};

export type DropTarget =
  | { kind: "nest"; id: string }
  | { kind: "row"; id: string; placement: "before" | "after" };

export type DropPlan =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | {
      kind: "apply";
      /** Present when the parent changes. `null` lifts a subtask out. */
      parent?: { id: string; parentId: string | null };
      /** The siblings, top to bottom, after the move. */
      order?: { parentId: string | null; status: string | null; ids: string[] };
    };

type Located = { row: DropRow; parent: DropRow | null };

function locate(rows: DropRow[], id: string): Located | null {
  for (const row of rows) {
    if (row.id === id) return { row, parent: null };
    for (const child of row.subRows ?? []) {
      if (child.id === id) return { row: child, parent: row };
    }
  }
  return null;
}

function place(ids: string[], moving: string, anchor: string, placement: "before" | "after") {
  const rest = ids.filter((id) => id !== moving);
  const at = rest.indexOf(anchor);
  rest.splice(at + (placement === "after" ? 1 : 0), 0, moving);
  return rest;
}

/**
 * @param rows The TOP-LEVEL rows on screen, every status group, each carrying
 *   its `subRows` — the same array the status groups are built from.
 */
export function planTaskDrop(rows: DropRow[], activeId: string, target: DropTarget): DropPlan {
  const active = locate(rows, activeId);
  const over = locate(rows, target.id);
  if (!active || !over || activeId === target.id) return { kind: "none" };

  const hasChildren = (active.row.subRows?.length ?? 0) > 0;

  if (target.kind === "nest") {
    if (over.parent || over.row.parent_task_id) {
      return { kind: "error", message: "A subtask cannot have subtasks of its own." };
    }
    if (hasChildren) {
      return {
        kind: "error",
        message: `“${active.row.title}” has subtasks, so it cannot become one.`,
      };
    }
    if (active.parent?.id === over.row.id) return { kind: "none" };

    return { kind: "apply", parent: { id: activeId, parentId: over.row.id } };
  }

  // Between two subtasks: join their parent, at that place.
  if (over.parent) {
    const parent = over.parent;
    if (parent.id === activeId) return { kind: "none" };

    const joining = active.parent?.id !== parent.id;
    if (joining && hasChildren) {
      return {
        kind: "error",
        message: `“${active.row.title}” has subtasks, so it cannot become one.`,
      };
    }

    return {
      kind: "apply",
      ...(joining ? { parent: { id: activeId, parentId: parent.id } } : {}),
      order: {
        parentId: parent.id,
        status: null,
        ids: place(
          (parent.subRows ?? []).map((row) => row.id),
          activeId,
          target.id,
          target.placement,
        ),
      },
    };
  }

  // Between two top-level rows. A status group is a status: the row cannot be
  // dragged into another one, because that would be a status change and those
  // go through the state machine, not a drag.
  if (active.row.status !== over.row.status) {
    return {
      kind: "error",
      message: "Drag within the same status to reorder. Change the status to move it to another group.",
    };
  }

  const siblings = rows.filter((row) => row.status === over.row.status).map((row) => row.id);

  return {
    kind: "apply",
    ...(active.parent ? { parent: { id: activeId, parentId: null } } : {}),
    order: {
      parentId: null,
      status: over.row.status,
      ids: place(siblings, activeId, target.id, target.placement),
    },
  };
}
