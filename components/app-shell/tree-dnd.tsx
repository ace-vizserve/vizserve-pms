"use client";

import { useOptimistic, useTransition, type CSSProperties, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import { toast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";

/**
 * P7-72 — THE ONLY FILE THAT IMPORTS `@dnd-kit` FOR THE PROJECT TREE, in the
 * rail (`nav-projects.tsx`) and on /tasks/lists (`list-manager.tsx`).
 *
 * The same containment `board-dnd.tsx` and `timesheet/row-dnd.tsx` keep for
 * their own surfaces: the rail sees a provider, a hook and a grip in this app's
 * vocabulary, never dnd-kit's.
 *
 * ⚠️ IT REPORTS THE DROP; IT DOES NOT DECIDE WHAT FOLLOWS. `onDrop` gets the two
 * ids, and `useDragOrder` below works out the new order and saves it.
 *
 * ONE PROVIDER PER SIBLING SET — a department's folders, one folder's lists, a
 * department's folderless lists. A row can therefore only be dropped among its
 * own siblings: moving a folder between departments strands its lists, and
 * moving a list between folders is a filing decision that belongs on
 * /tasks/lists, not a side effect of a drag that overshot.
 *
 * Providers NEST (lists inside a sortable folder). dnd-kit keeps each
 * `DndContext` separate, and every activator is its own grip rather than the
 * row, so a press on a list's grip never picks up the folder around it.
 */
export function TreeDndProvider({
  itemIds,
  onDrop,
  children,
}: {
  itemIds: readonly string[];
  onDrop: (activeId: string, overId: string) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // 8px, matching the board and the timesheet: the grip sits inside a row full
    // of links, and a press should stay a press.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const activeId = event.active.id;
    const overId = event.over?.id;

    // No `over`, or dropped where it started: nothing moved, nothing to save.
    if (typeof activeId !== "string" || typeof overId !== "string" || activeId === overId) return;

    onDrop(activeId, overId);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={[...itemIds]} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export type SortableTreeItem = {
  ref: (node: HTMLElement | null) => void;
  style: CSSProperties;
  isDragging: boolean;
  grip: ReactNode;
};

/**
 * The row's half. Returns what the row spreads onto its own `<li>`, plus the grip
 * already wired to it — so the row never touches a listener.
 *
 * `gripClassName` places the grip and says when it shows. It is the CALLER'S,
 * because the hover group differs by level: a folder's `<li>` contains its lists,
 * so a list grip keyed on the folder's group would light every list grip in the
 * folder whenever its heading was hovered.
 */
export function useSortableTreeItem(
  id: string,
  label: string,
  gripClassName: string,
): SortableTreeItem {
  const { attributes, listeners, transform, transition, setNodeRef, setActivatorNodeRef, isDragging } =
    useSortable({ id });

  return {
    ref: setNodeRef,
    style: { transform: CSS.Translate.toString(transform), transition },
    isDragging,
    grip: (
      /*
       * A real `<button>` beside the row's own control rather than listeners ON
       * it: the keyboard sensor claims Space and Enter, which are exactly the
       * keys that open a folder and follow a list's link.
       *
       * `touch-none` so a finger drags the row instead of scrolling the rail.
       */
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move ${label}`}
        className={cn(
          "flex shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-foreground-muted outline-hidden focus-visible:ring-2 active:cursor-grabbing",
          gripClassName,
          isDragging && "opacity-100",
        )}>
        <GripVertical className="size-3.5" aria-hidden />
      </button>
    ),
  };
}

/**
 * The rail's grip: a 20px control laid over the row and revealed on hover, like
 * the `+` beside it. Callers add the position and the hover group.
 */
export const SIDEBAR_GRIP =
  "absolute size-5 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 focus-visible:ring-sidebar-ring";

/**
 * P7-72 — one sibling set's order, as the reader last dragged it. Shared by the
 * rail and /tasks/lists, so a drag in either place saves the same way.
 *
 * OPTIMISTIC, because rows that jump back for the length of a round trip and
 * then forward again read as a drop that failed. `useOptimistic` holds the new
 * order for the life of the transition — which includes the revalidated render
 * arriving — and falls back to the server's order on its own if the save fails.
 */
export function useDragOrder<T extends { id: string }>(
  items: T[],
  save: (ids: string[]) => Promise<ActionResult<null>>,
) {
  const [order, setOrder] = useOptimistic(items.map((item) => item.id));
  const [, startTransition] = useTransition();

  const byId = new Map(items.map((item) => [item.id, item]));
  // An id the server no longer returns (archived elsewhere mid-drag) is dropped
  // rather than rendered as a hole.
  const ordered = order.flatMap((id) => byId.get(id) ?? []);

  function onDrop(activeId: string, overId: string) {
    const from = order.indexOf(activeId);
    const to = order.indexOf(overId);
    if (from === -1 || to === -1) return;

    const next = [...order];
    next.splice(to, 0, ...next.splice(from, 1));

    startTransition(async () => {
      setOrder(next);
      const result = await save(next);
      if (!result.ok) toast.error(result.error);
    });
  }

  return { order, ordered, onDrop };
}
