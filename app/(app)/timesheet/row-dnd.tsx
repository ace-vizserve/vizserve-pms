"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
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

import { cn } from "@/lib/utils";

/**
 * P6-02c — THE ONLY FILE IN THE REPO THAT IMPORTS `@dnd-kit` FOR THE TIMESHEET.
 *
 * The same containment `lib/form-builder/dnd.tsx` and the task board's
 * `board-dnd.tsx` each keep for their own surface, and for the same reason: a
 * drag library spread through a 2,000-line grid is one nobody can replace. The
 * grid sees three things — a provider, a sortable row, and a grip — in this
 * app's vocabulary rather than dnd-kit's.
 *
 * ⚠️ IT REPORTS THE DROP; IT DOES NOT DECIDE WHAT FOLLOWS. `arrayMove` is never
 * called here. `onDrop` hands the two ids to `planRowDrop` in
 * `lib/timesheet-row-order.ts`, which is also what the row menu calls — so the
 * hand and the menu cannot come to different conclusions about the same move.
 *
 * ⚠️ ROWS OF A TABLE, NOT ITEMS OF A LIST, and that costs one thing worth
 * knowing: a `<tr>` carrying a transform is still a `<tr>`, but the rows of the
 * expanded working underneath a task are separate `<tr>`s that this knows
 * nothing about. The grid closes them when a drag starts — see `onDragStart`
 * there — rather than let a row slide out from over its own entries.
 *
 * There is no `DragOverlay`. An overlay for a table row means rendering a lone
 * `<tr>` inside a portal, which needs a whole second `<table>` around it to be
 * valid HTML and to keep its column widths; the row moving under the pointer is
 * the same information without any of that.
 */

/** The drag handle's props, handed from the sortable row down to the grip. */
type HandleProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: (node: HTMLElement | null) => void;
};

const GripContext = createContext<HandleProps | null>(null);

export function RowDndProvider({
  /** The row ids, in the order they are rendered. */
  itemIds,
  /** Both ids are row ids: the only droppables are the rows themselves. */
  onDrop,
  /** Expanded rows are closed here — see the note above. */
  onDragStart,
  children,
}: {
  itemIds: readonly string[];
  onDrop: (activeId: string, overId: string) => void;
  onDragStart: () => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    /*
     * An 8px activation distance, matching the board and the form builder.
     *
     * The grip is a button and the row around it is full of inputs; without a
     * distance the smallest tremor on a press would begin a drag instead of
     * whatever was actually being pressed.
     */
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const activeId = event.active.id;
    const overId = event.over?.id;

    // No `over` is a drop into empty space — a gesture somebody abandoned, not a
    // move to the top. Doing nothing is the only correct reading of it.
    if (typeof activeId !== "string" || typeof overId !== "string") return;

    onDrop(activeId, overId);
  }

  return (
    <DndContext
      id="timesheet-row-dnd"
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={handleDragEnd}>
      <SortableContext
        id="timesheet-row-sortable"
        items={[...itemIds]}
        strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/**
 * One task row: draggable, and its own drop target.
 *
 * The transform is dnd-kit's live preview of where the row is going, so the new
 * order is visible before the button comes up rather than after. The row itself
 * moves — see the note about `DragOverlay` above — so it is LIFTED rather than
 * dimmed: `bg-muted` on its cells, because the first column is sticky and a
 * translucent fill lets the cells scrolling under it show straight through.
 */
export function SortableRow({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const { attributes, listeners, transform, transition, setNodeRef, setActivatorNodeRef, isDragging } =
    useSortable({ id });

  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        className,
        isDragging && "relative z-20 [&>td]:bg-muted [&>th]:bg-muted",
      )}>
      <GripContext.Provider value={{ ref: setActivatorNodeRef, ...attributes, ...listeners }}>
        {children}
      </GripContext.Provider>
    </tr>
  );
}

/**
 * The grip.
 *
 * A real `<button>`, so it is tabbable and the keyboard sensor has something to
 * start from — space to pick the row up, the arrow keys to move it, space again
 * to drop it, announced by dnd-kit as it goes. The row menu beside it does the
 * same job without any of that, and is the path this feature is TESTED through.
 *
 * `touch-none` because a grip that scrolls the page when a finger drags it is a
 * grip that does not work on a phone. 24px square is WCAG 2.2 §2.5.8's floor,
 * the same target the form builder's grip settled on.
 */
export function RowGrip({ label, className }: { label: string; className?: string }) {
  const handle = useContext(GripContext);

  // Rendered outside a `SortableRow` — which nothing does today, and a grip that
  // silently does nothing is worse than no grip.
  if (!handle) return null;

  return (
    <button
      type="button"
      {...handle}
      aria-label={label}
      className={cn(
        "flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-foreground-faint hover:text-foreground-muted active:cursor-grabbing",
        className,
      )}>
      <GripVertical className="size-4" aria-hidden />
    </button>
  );
}
