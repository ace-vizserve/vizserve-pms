"use client";

import { createContext, useContext, useMemo, useOptimistic } from "react";

import type { VizservePmsTaskStatus } from "@/lib/database.types";

import { TaskStatusGroup } from "./status-group";
import { TaskGroupTable, type ListRow, type TaskLookups, type Viewer } from "./tasks-table";

/**
 * P11-05 — THE ROW MOVES WHEN YOU PICK, NOT TWO SECONDS LATER.
 *
 * ⚠️ THE CHIP WAS ALREADY OPTIMISTIC AND IT WAS NOT ENOUGH. Picking a new status
 * repainted the chip instantly and then the row sat in the wrong group for 2–3
 * seconds, because the buckets were built on the SERVER: nothing could move
 * until `/tasks` re-ran its ~14 queries and streamed back. Half-instant is worse
 * than not instant — the eye goes to the thing that did not move.
 *
 * So the bucketing happens here. The server still does the expensive half — the
 * query, the filters, and the parent/child nesting that gives each row its
 * `subRows` — and hands over a map it has already built. All this owns is which
 * heading a top-level row currently sits under, which is the one thing that has
 * to change the instant somebody clicks.
 *
 * ⚠️ TOP-LEVEL ROWS ONLY. A subtask is rendered inside its parent's table and
 * stays there whatever its own status is (P7-65), so re-bucketing children would
 * tear a task away from its parent. Their chips still repaint; their position
 * does not move, which is correct.
 *
 * ⚠️ THE OPTIMISTIC BASE IS THE PROP, so when the server payload finally lands
 * React drops every pending move and the buckets come from the database again.
 * Nothing here has to un-apply anything, and a refused move needs no rollback
 * code — the row simply returns to the group the server still says it is in.
 */

type Move = { id: string; status: VizservePmsTaskStatus };

/**
 * How a status control tells the list it has moved.
 *
 * Null outside this provider, which is the normal case for the task DETAIL page
 * and the board — both render the same control with no groups around it, and a
 * missing context must not be a crash.
 */
const MoveContext = createContext<((move: Move) => void) | null>(null);

export function useOptimisticMove() {
  return useContext(MoveContext);
}

export function TaskStatusGroups({
  groups,
  visibleStatuses,
  viewer,
  lookups,
  assignable,
}: {
  /** Built server-side, nesting and all. Keyed by status. */
  groups: Record<string, ListRow[]>;
  visibleStatuses: readonly VizservePmsTaskStatus[];
  viewer: Viewer;
  lookups: TaskLookups;
  assignable: { id: string; full_name: string }[];
}) {
  const flat = useMemo(
    () => visibleStatuses.flatMap((status) => groups[status] ?? []),
    [groups, visibleStatuses],
  );

  const [rows, applyMove] = useOptimistic(flat, (state: ListRow[], move: Move) =>
    state.map((row) => (row.id === move.id ? { ...row, status: move.status } : row)),
  );

  const grouped = useMemo(() => {
    const buckets = new Map<VizservePmsTaskStatus, ListRow[]>(
      visibleStatuses.map((status) => [status, []]),
    );
    for (const row of rows) buckets.get(row.status)?.push(row);
    return buckets;
  }, [rows, visibleStatuses]);

  return (
    <MoveContext value={applyMove}>
      <div className="flex flex-col gap-3">
        {visibleStatuses.map((status) => {
          const group = grouped.get(status) ?? [];

          return (
            <TaskStatusGroup
              key={status}
              status={status}
              count={group.length}
              // A stage with nothing in it opens to one line. Closing it by
              // default would hide the only thing it has to say.
              defaultOpen
            >
              {/*
                THE TABLE IS ALWAYS RENDERED, even for an empty stage, because
                the composer is a `<tr>` inside it — a stage with nothing in it
                is exactly where somebody wants to add the first task, and a
                paragraph cannot hold a row. The empty sentence moves into the
                table as its `empty` state.
              */}
              <TaskGroupTable
                group={group}
                status={status}
                viewer={viewer}
                lookups={lookups}
                assignable={assignable}
              />
            </TaskStatusGroup>
          );
        })}
      </div>
    </MoveContext>
  );
}
