"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
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
 * P7-66 — THE ONLY FILE IN THE REPO THAT IMPORTS `@dnd-kit` FOR THE FORM
 * BUILDER.
 *
 * Same containment rule `lib/form-builder/components.tsx` follows for
 * `@coltorapps/builder-react`, and for the same reason: a drag library spread
 * across eight components is one that cannot be swapped. The builder screen sees
 * three components and one payload type, in this app's vocabulary rather than
 * the library's. (`app/(app)/tasks/board/board-dnd.tsx` imports `@dnd-kit/core`
 * too, for the task board — a different surface with its own containment.)
 *
 * ⚠️ DRAG IS REORDERING, AND NOTHING ELSE, SINCE THE GOOGLE-FORMS REWORK.
 *
 * It used to be two features wearing one coat: reordering a card, and dragging a
 * TYPE in from a palette to create a field. The palette is gone — a question's
 * type is now chosen in the Add question dialog, because the type is FIXED after
 * the first save and is therefore a decision rather than a gesture — and with it
 * went `PaletteDragButton`, the `{ kind: "new" }` payload, `CanvasEndDropZone`
 * and the insertion rule those needed. Everything they existed to work around
 * went with them: the palette's swallowed Enter/Space, the end zone that had to
 * exist because a palette could not add the first field to an empty form, and
 * `SortableContext`'s `disableTransforms` on a drag whose source is not in the
 * list. What is left is one sortable list, which is what dnd-kit is good at.
 *
 * ⚠️ AND IT LIVES IN THE FIELD LIST, NOT ON THE FORM. The main column renders
 * the live form, where a question is CLICKED to edit it; a click target that is
 * also a drag target is a mis-click waiting to happen. Sorting is the left
 * rail's single job, which is why the rail exists.
 *
 * ⚠️ THE SHAPE IS COLTORAPPS' OWN DOCUMENTED INTEGRATION —
 * https://builder.coltorapps.com/docs/guides/drag-and-drop — which is why
 * dnd-kit rather than anything else: `DndContext` + `SortableContext` +
 * `useSortable` per entity, and a drop that ends in `setEntityIndex`. It covers
 * a SINGLE HIERARCHICAL LEVEL only, which is all we need: none of the eight
 * entity types declares `childrenAllowed`.
 *
 * ⚠️ WHAT THE GUIDE DOES THAT WE DO NOT. Its `handleDragEnd` computes
 * `root.findIndex(id === over.id)` and calls `setEntityIndex` with it. Two
 * things are wrong with that here, and both are silent:
 *
 *   - `root` holds ARCHIVED fields too, and they render in a separate list. A
 *     `root` index is therefore not the position anybody is looking at.
 *   - it is a second ordering rule, sitting beside `planEntityReorder`, which
 *     the up/down buttons use and which is tested.
 *
 * So this file reports WHAT the browser decided — which row the pointer ended
 * over — and `lib/form-builder/canvas.ts` decides what follows. `arrayMove` is
 * never called. Drag and the buttons run the same rule, so they cannot disagree.
 *
 * ⚠️ DRAG IS AN ENHANCEMENT, NEVER THE ONLY PATH (WCAG 2.2 AA 2.1.1, and 2.5.7
 * on dragging movements). The up/down buttons do the whole job without a
 * pointer, and they are the tested path. dnd-kit's `KeyboardSensor` is wired as
 * well because it costs one line and routes through the same planner — and
 * unlike the palette it can actually work here, because every draggable in this
 * context IS a sortable item and therefore a droppable container
 * `sortableKeyboardCoordinates` can find.
 */

/** What is being dragged: a row of the field list, and never anything else. */
export type FieldDrag = { entityId: string };

function readDrag(data: unknown): FieldDrag | null {
  if (typeof data !== "object" || data === null) return null;

  const candidate = data as Partial<FieldDrag>;

  return typeof candidate.entityId === "string" ? { entityId: candidate.entityId } : null;
}

/**
 * The drag handle's props, handed down from the sortable item to the grip.
 *
 * Typed as ordinary button props so the row component never names a dnd-kit
 * type. It is spread onto a real `<button>`, which is what makes the grip
 * focusable and gives the keyboard sensor something to start from.
 */
type HandleProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

const DragHandleContext = createContext<HandleProps>({});

export function FieldDndProvider({
  /** The sortable ids, in the order they are rendered. Active fields only. */
  itemIds,
  /** Dragging is off while the form holds unsaved edits — see `sameFormSchema`. */
  disabled,
  /** `overId` is always a field id: the only droppables are the rows themselves. */
  onDrop,
  /** What the cursor carries. Rendered in a portal above everything. */
  renderOverlay,
  children,
}: {
  itemIds: ReadonlyArray<string>;
  disabled: boolean;
  onDrop: (drag: FieldDrag, overId: string) => void;
  renderOverlay: (drag: FieldDrag) => ReactNode;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<FieldDrag | null>(null);

  const sensors = useSensors(
    /*
     * An 8px activation distance, matching the task board.
     *
     * A row is CLICKED to open the question it names, and carries three buttons
     * of its own; without this, every attempt to open a field would begin a drag
     * and the click would never fire.
     */
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart(event: DragStartEvent) {
    setDragging(readDrag(event.active.data.current));
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null);

    const drag = readDrag(event.active.data.current);
    const overId = event.over?.id;

    // No `over` is a drop into empty space — a cancelled gesture, not a move to
    // position zero. Doing nothing is the only correct reading of it.
    if (!drag || typeof overId !== "string") return;

    onDrop(drag, overId);
  }

  return (
    <DndContext
      id="form-field-dnd"
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <SortableContext
        id="form-field-sortable"
        items={Array.from(itemIds)}
        strategy={verticalListSortingStrategy}
        disabled={disabled}
      >
        {children}
      </SortableContext>

      {/* `dropAnimation={null}`: the store re-renders the list in its new order
          the moment the save is planned, so an animation flying the overlay back
          to a stale position would be showing the previous order. */}
      <DragOverlay dropAnimation={null}>
        {dragging ? renderOverlay(dragging) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * One row of the field list: sortable, and its own drop target.
 *
 * `<li>` because the list is a list. The transform is dnd-kit's live preview of
 * where the row is going, so the person sees the new order before letting go —
 * which is what makes the drop predictable rather than a guess. Every draggable
 * here is in `itemIds`, so `verticalListSortingStrategy` previews every drag;
 * there is no case left where it silently does not, which is what the deleted
 * insertion rule was drawing by hand.
 */
export function SortableFieldRow({
  id,
  disabled,
  className,
  children,
}: {
  id: string;
  disabled: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { attributes, listeners, transform, transition, setNodeRef, isDragging } = useSortable({
    id,
    disabled,
    data: { entityId: id } satisfies FieldDrag,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // The row the pointer picked up stays in place and dims; the overlay is
      // the thing that follows the cursor. Two moving copies of one row is the
      // effect that makes a drag feel broken.
      className={cn("relative", className, isDragging && "opacity-40")}
    >
      <DragHandleContext.Provider value={{ ...attributes, ...listeners, disabled }}>
        {children}
      </DragHandleContext.Provider>
    </li>
  );
}

/**
 * The grip. A real `<button>`, so it is tabbable and the keyboard sensor has
 * something to start from — the same reasoning as the task board's grip.
 *
 * ⚠️ IT IS `disabled` WHENEVER DRAGGING IS. `useSortable` returns `undefined`
 * listeners on a disabled item, so without this the grip stayed in the tab
 * order as a control that focuses, looks live and does nothing — the same class
 * of omission as the row's own select button (see `field-list.tsx`). The
 * `disabled` flag rides down through the context beside the listeners so the
 * two can never disagree.
 *
 * `buttonVariants` is not used because this is a bare icon target inside a list
 * row rather than an action; it carries the global focus ring from
 * `@layer base` and a 24px hit area, which is WCAG 2.2 §2.5.8's floor.
 */
export function FieldDragHandle({ label }: { label: string }) {
  const handle = useContext(DragHandleContext);

  return (
    <button
      type="button"
      {...handle}
      aria-label={label}
      className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-foreground-faint hover:text-foreground-muted active:cursor-grabbing disabled:cursor-default disabled:opacity-50"
    >
      <GripVertical className="size-4" aria-hidden />
    </button>
  );
}
