/**
 * P7-82 — what a drop on the task list MEANS. Pure, so it can be tested without
 * a pointer, and so `task-dnd.tsx` only has to report where the row landed.
 *
 * Three gestures:
 *
 *   ON A TITLE   → the dragged task becomes that task's subtask.
 *   BETWEEN ROWS → it takes that place. Between two subtasks it joins their
 *                  parent; between two top-level rows it leaves any parent it
 *                  had, and takes that group's status if it is another one.
 *   ON A HEADING → the top of that stage — the only way into an empty or
 *                  collapsed one. Same rules as between top-level rows.
 *
 * A status change here is only the PLAN. Whether the viewer may make that move
 * is `availableTransitions`, checked by the caller, and the state machine has
 * the last word.
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
  | { kind: "row"; id: string; placement: "before" | "after" }
  | { kind: "group"; status: string };

export type DropPlan =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | {
      kind: "apply";
      /** Present when the status changes — a drop into another stage. */
      status?: { id: string; to: string };
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
  if (!active) return { kind: "none" };

  if (target.kind === "group") {
    return intoStage(rows, active, target.status, (ids) => [activeId, ...ids]);
  }

  const over = locate(rows, target.id);
  if (!over || activeId === target.id) return { kind: "none" };

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

  // Between two top-level rows: that place, in that row's stage.
  return intoStage(rows, active, over.row.status, (ids) =>
    place(ids, activeId, target.id, target.placement),
  );
}

/**
 * The dragged task as a top-level row of `status`, where `arrange` puts it.
 *
 * A status group IS a status, so landing in another one is a status change.
 * A subtask is lifted out on the way; a parent moves alone — its subtasks stay
 * with it on screen and keep their own statuses (P7-65), as on the board.
 */
function intoStage(
  rows: DropRow[],
  active: Located,
  status: string,
  arrange: (siblingIds: string[]) => string[],
): DropPlan {
  const id = active.row.id;
  const siblings = rows
    .filter((row) => row.status === status && row.id !== id)
    .map((row) => row.id);

  return {
    kind: "apply",
    ...(active.row.status !== status ? { status: { id, to: status } } : {}),
    ...(active.parent ? { parent: { id, parentId: null } } : {}),
    order: { parentId: null, status, ids: arrange(siblings) },
  };
}
