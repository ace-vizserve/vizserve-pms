"use client";

import { startTransition, useCallback, useMemo, useOptimistic } from "react";
import { useRouter } from "next/navigation";

import { toast } from "@/components/ui/toast";
import { planTaskDrop, type DropTarget } from "@/lib/task-drop";

import type { VizservePmsTaskStatus } from "@/lib/database.types";

import { OptimisticMoveContext, placeholderId, type OptimisticMove } from "./optimistic-move";

import { TaskStatusGroup } from "./status-group";
import { reorderTasks, setTaskParent } from "./actions";
import { TaskGroupSortable, TaskListDnd } from "./task-dnd";
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

  const [rows, applyMove] = useOptimistic(flat, (state: ListRow[], move: OptimisticMove) => {
    if (move.kind === "move") {
      return state.map((row) => (row.id === move.id ? { ...row, status: move.status } : row));
    }

    /*
     * A deleted row goes now.
     *
     * ⚠️ THE GROUP COUNT FOLLOWS BY ITSELF, because the heading counts what is
     * in the bucket rather than holding its own number. That is the whole
     * argument for bucketing here instead of on the server: one array is the
     * source of the rows AND of the count beside them, so they cannot disagree.
     */
    if (move.kind === "remove") {
      return state.filter((row) => row.id !== move.id);
    }

    /* Every cell on the row reads from this array, so one patch reaches all of
       them — including the two places `InlinePriority` is rendered. */
    if (move.kind === "patch") {
      return state.map((row) => (row.id === move.id ? { ...row, ...move.fields } : row));
    }

    /*
     * P7-82 — a drag. The same slots, refilled in the new order, so rows of
     * other statuses between them do not move.
     */
    if (move.kind === "order") {
      const byId = (list: ListRow[]) => new Map(list.map((row) => [row.id, row]));

      if (move.parentId) {
        return state.map((row) => {
          if (row.id !== move.parentId || !row.subRows) return row;
          const children = byId(row.subRows);
          return {
            ...row,
            subRows: move.ids.flatMap((id) => children.get(id) ?? []),
          };
        });
      }

      const rowsById = byId(state);
      const wanted = new Set(move.ids);
      const queue = move.ids.flatMap((id) => rowsById.get(id) ?? []);
      let next = 0;
      return state.map((row) => (wanted.has(row.id) ? (queue[next++] ?? row) : row));
    }

    /*
     * A row for a task that does not exist yet.
     *
     * ⚠️ IT CARRIES ONLY WHAT WAS TYPED. Everything else — the assignee's
     * name, the reference, the counts — is resolved server-side and would be a
     * guess here, so the placeholder shows the title and nothing else rather
     * than inventing fields that change when the real row lands.
     */
    return [
      ...state,
      {
        id: placeholderId(state.length),
        title: move.title,
        status: move.status,
        depth: 0,
        /* Not invented — the composer cannot create client-backed work; that
           only ever arrives through a request. Stated because `taskCategory`
           reads it, and `undefined !== null` would put the client-work accent
           edge on a row that has no client. */
        request_id: null,
      } as unknown as ListRow,
    ];
  });

  const router = useRouter();

  /* P7-82 — what the drag layer needs to label a row it picks up. */
  const info = useCallback(
    (id: string) => {
      for (const row of rows) {
        if (row.id === id) {
          return {
            id,
            title: row.title,
            hasChildren: (row.subRows?.length ?? 0) > 0,
            // A finished subtask sits at the top level of its own group, but
            // it is still a subtask and still cannot take any.
            isChild: row.parent_task_id !== null,
            parentId: row.parent_task_id,
          };
        }
        const child = row.subRows?.find((one) => one.id === id);
        if (child) {
          return { id, title: child.title, hasChildren: false, isChild: true, parentId: row.id };
        }
      }
      return null;
    },
    [rows],
  );

  /*
   * P7-82 — a drop. `planTaskDrop` decides what it means; this carries it out.
   *
   * ⚠️ THE FIRST REORDER SWITCHES THE LIST TO "MANUAL". Sorted by due date, a
   * dragged row would jump straight back to where its date puts it, which reads
   * as the drag failing. The reorder is saved from the order on screen, so the
   * manual order starts out as exactly what the person was looking at.
   */
  function onDrop(activeId: string, target: DropTarget) {
    const plan = planTaskDrop(rows, activeId, target);
    if (plan.kind === "none") return;
    if (plan.kind === "error") {
      toast.error(plan.message);
      return;
    }

    startTransition(async () => {
      if (plan.order && !plan.parent) applyMove({ kind: "order", ...plan.order });

      if (plan.parent) {
        const result = await setTaskParent(plan.parent.id, {
          parent_task_id: plan.parent.parentId,
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        if (!plan.order) {
          toast.success(plan.parent.parentId ? "Moved in as a subtask" : "No longer a subtask");
        }
      }

      if (plan.order) {
        const result = await reorderTasks(plan.order.ids);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }

        const params = new URLSearchParams(window.location.search);
        if (params.get("sort") !== "manual") {
          params.set("sort", "manual");
          params.delete("dir");
          router.replace(`/tasks?${params.toString()}`, { scroll: false });
          toast.success("Sorted by Manual — your order is kept");
        }
      }
    });
  }

  const grouped = useMemo(() => {
    const buckets = new Map<VizservePmsTaskStatus, ListRow[]>(
      visibleStatuses.map((status) => [status, []]),
    );
    for (const row of rows) buckets.get(row.status)?.push(row);
    return buckets;
  }, [rows, visibleStatuses]);

  return (
    <OptimisticMoveContext value={applyMove}>
      <TaskListDnd info={info} onDrop={onDrop}>
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
              <TaskGroupSortable
                id={`group-${status}`}
                itemIds={group.flatMap((row) => [
                  row.id,
                  ...(row.subRows ?? []).map((child) => child.id),
                ])}>
                <TaskGroupTable
                  group={group}
                  status={status}
                  viewer={viewer}
                  lookups={lookups}
                  assignable={assignable}
                />
              </TaskGroupSortable>
            </TaskStatusGroup>
          );
        })}
      </div>
      </TaskListDnd>
    </OptimisticMoveContext>
  );
}
