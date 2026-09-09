"use client";

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
 * So the bucketing happens here. Everything expensive — the query, the filters,
 * the parent/child nesting that gives each row its `subRows` — happens before
 * this component, and all it owns is which heading a top-level row currently
 * sits under.
 *
 * ------------------------------------------------------------------------
 * ⚠️ P12-10 — THE `useOptimistic` AND ITS CONTEXT ARE GONE, AND NOTHING ABOUT
 * THE BEHAVIOUR CHANGED.
 *
 * This file used to hold a `useOptimistic` reducer over the flattened rows and
 * publish its dispatch through `OptimisticMoveContext`, so a status control
 * three components down could say "this row moved" before the server agreed.
 * That context is now the QUERY CACHE: `onMutate` patches the row inside
 * `qk.taskList` / `qk.taskView`, this component re-renders from the patched
 * entry, and the row lands under its new heading on the same tick.
 *
 * ⚠️ WHICH ALSO RETIRES THE IMPORT-CYCLE HAZARD THE CONTEXT CARRIED. It lived in
 * a leaf module of its own precisely because putting it HERE did not work: this
 * file imports the table, which imports the status control, which imported the
 * hook, which imported the context back. A bundler can hand a cycle two
 * evaluations of one module, so `createContext` ran twice, the provider
 * published to one context and `useContext` read the other, and the row silently
 * never moved. There is no context to place now, and `lib/query/task-cache.ts`
 * is a leaf that imports nothing but `./keys` and types.
 * ------------------------------------------------------------------------
 *
 * ⚠️ TOP-LEVEL ROWS ONLY. A subtask is rendered inside its parent's table and
 * stays there whatever its own status is (P7-65), so re-bucketing children would
 * tear a task away from its parent. Their chips still repaint; their position
 * does not move, which is correct.
 */

export function TaskStatusGroups({
  groups,
  visibleStatuses,
  viewer,
  lookups,
  assignable,
}: {
  /** Built from the cached rows, nesting and all. Keyed by status. */
  groups: Record<string, ListRow[]>;
  visibleStatuses: readonly VizservePmsTaskStatus[];
  viewer: Viewer;
  lookups: TaskLookups;
  assignable: { id: string; full_name: string }[];
}) {
  /*
   * ⚠️ `visibleStatuses` DECIDES WHICH HEADINGS EXIST, NOT `groups`. A status
   * filter draws one heading and the QA view draws two, while `groups` is keyed
   * by every status the enum has — so the map is walked in the caller's order
   * rather than the object's.
   *
   * The GROUP COUNT follows by itself, because the heading counts what is in the
   * bucket rather than holding a number of its own. One array is the source of
   * the rows AND of the count beside them, so they cannot disagree.
   */
  return (
    <div className="flex flex-col gap-3">
      {visibleStatuses.map((status) => {
        const group = groups[status] ?? [];

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
  );
}
