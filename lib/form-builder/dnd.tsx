"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
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
import { addsFieldOnKey, showsInsertGuide } from "@/lib/form-builder/canvas";
import type { FieldType } from "@/lib/schemas/forms";

/**
 * P7-66 Phase 4a — THE ONLY FILE IN THE REPO THAT IMPORTS `@dnd-kit`
 * FOR THE FORM BUILDER.
 *
 * Same containment rule `lib/form-builder/components.tsx` follows for
 * `@coltorapps/builder-react`, and for the same reason: a drag library spread
 * across eight components is one that cannot be swapped. The builder screen sees
 * four components and one payload type, in this app's vocabulary rather than the
 * library's. (`app/(app)/tasks/board/board-dnd.tsx` imports `@dnd-kit/core` too,
 * for the task board — a different surface with its own containment.)
 *
 * ⚠️ THE SHAPE IS COLTORAPPS' OWN DOCUMENTED INTEGRATION —
 * https://builder.coltorapps.com/docs/guides/drag-and-drop — which is why
 * dnd-kit rather than anything else: `DndContext` + `SortableContext` +
 * `useSortable` per entity, and a drop that ends in `setEntityIndex`. Matching
 * the integration the builder library documents is worth more than dependency
 * freshness on the one interaction where getting the index wrong silently
 * reorders somebody's form. It covers a SINGLE HIERARCHICAL LEVEL only, which is
 * all we need: none of the eight entity types declares `childrenAllowed`.
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
 * So this file reports WHAT the browser decided — which card the pointer ended
 * over — and `lib/form-builder/canvas.ts` decides what follows. `arrayMove` is
 * never called. Drag and the buttons run the same rule, so they cannot disagree.
 *
 * ⚠️ DRAG IS AN ENHANCEMENT, NEVER THE ONLY PATH (WCAG 2.2 AA 2.1.1). The
 * up/down buttons and the palette's press-to-add do the whole job without a
 * pointer, and they are the tested path. dnd-kit's `KeyboardSensor` is wired as
 * well because it costs one line and routes through the same planner, but
 * nothing depends on it.
 *
 * ⚠️ AND THE KEYBOARD SENSOR REACHES THE CANVAS ONLY. It is a SORTABLE sensor:
 * `sortableKeyboardCoordinates` looks the active id up in `droppableContainers`
 * and returns `undefined` when it is not there. A palette entry is
 * `useDraggable` only, so a keyboard drag begun on one can never move — which
 * is why `PaletteDragButton` does not install the sensor's activator at all and
 * answers Enter and Space itself. See the note there; it was a real bug.
 */

/** What is being dragged. Read by the drop handler, never by the source. */
export type FieldDrag =
  /** A type from the palette. There is no entity yet. */
  | { kind: "new"; fieldType: FieldType }
  /** A card already on the canvas. */
  | { kind: "move"; entityId: string };

/**
 * The droppable past the last card.
 *
 * It is also the EMPTY canvas: a form with no fields has no card to drop onto,
 * and a palette that can only insert beside an existing field cannot add the
 * first one.
 */
export const CANVAS_END_ID = "vizserve-pms-form-canvas-end";

function readDrag(data: unknown): FieldDrag | null {
  if (typeof data !== "object" || data === null) return null;

  const candidate = data as Partial<FieldDrag>;
  if (candidate.kind === "new" && typeof candidate.fieldType === "string") {
    return { kind: "new", fieldType: candidate.fieldType };
  }
  if (candidate.kind === "move" && typeof candidate.entityId === "string") {
    return { kind: "move", entityId: candidate.entityId };
  }

  return null;
}

/**
 * The drag handle's props, handed down from the sortable item to the grip.
 *
 * Typed as ordinary button props so the card component never names a dnd-kit
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
  /** `overId` is a field id or `CANVAS_END_ID`. Nothing else can be dropped on. */
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
     * A card is CLICKED to select it and carries three buttons of its own;
     * without this, every attempt to open a field in the panel would begin a
     * drag and the click would never fire.
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
 * One card on the canvas: sortable, and the drop target for everything above it.
 *
 * `<li>` because the canvas is a list. The transform is dnd-kit's live preview
 * of where the card is going, so the person sees the new order before letting
 * go — which is what makes the drop predictable rather than a guess.
 *
 * ⚠️ THAT PREVIEW ONLY EXISTS FOR A REORDER, AND THE PALETTE GETS A RULE
 * INSTEAD. `SortableContext` sets `disableTransforms` the moment something is
 * dragged over the list that is not IN the list — `overIndex !== -1 &&
 * activeIndex === -1`, which is every palette drag, since a palette entry is
 * never in `itemIds`. So no card moved, nothing opened, and the person let go
 * with no idea where the field would land. The rule below is drawn in the gap
 * ABOVE the hovered card, which is exactly where `rootIndexForSlot` inserts.
 * `showsInsertGuide` is the decision and it is unit-tested; this only draws it.
 */
export function SortableFieldCard({
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
  const { active, attributes, listeners, transform, transition, setNodeRef, isDragging, isOver } =
    useSortable({
      id,
      disabled,
      data: { kind: "move", entityId: id } satisfies FieldDrag,
    });

  const insertAbove = showsInsertGuide(readDrag(active?.data.current), isOver ? id : null, id);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // The card the pointer picked up stays in place and dims; the overlay is
      // the thing that follows the cursor. Two moving copies of one card is the
      // effect that makes a drag feel broken.
      className={cn("relative", className, isDragging && "opacity-40")}
    >
      {/*
        The insertion rule, centred in the 8px gap the canvas leaves between
        cards (`space-y-2`, so -4px clears it exactly). `aria-hidden` because it
        is a pointer-only affordance duplicating what the drag overlay already
        names, and the keyboard path never produces one.
      */}
      {insertAbove ? (
        <span
          aria-hidden
          className="absolute inset-x-0 -top-1 h-0.5 rounded-sm bg-primary"
        />
      ) : null}

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
 * of omission as the card's own select button (see `field-card.tsx`). The
 * `disabled` flag rides down through the context beside the listeners so the
 * two can never disagree.
 *
 * `buttonVariants` is not used because this is a bare icon target inside a card
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

/**
 * The strip past the last card, and the empty canvas.
 *
 * A render prop rather than a `data-` attribute: the zone looks completely
 * different empty, hovered and idle, and passing the boolean out keeps every one
 * of those three in the component that owns the copy.
 */
export function CanvasEndDropZone({
  children,
}: {
  children: (isOver: boolean) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: CANVAS_END_ID });

  return <div ref={setNodeRef}>{children(isOver)}</div>;
}

/**
 * A palette entry — drag it onto the canvas, or PRESS IT to add at the end.
 *
 * The press is not a fallback; it is the keyboard path, and it is why this is a
 * `<button>` with a real accessible name rather than a div with a drag listener.
 * dnd-kit's pointer sensor has an 8px activation distance, so a click is still a
 * click.
 *
 * ⚠️ ONLY THE POINTER ACTIVATOR IS INSTALLED, AND THAT IS A FIX, NOT A
 * SIMPLIFICATION. `{...listeners}` also carries `KeyboardSensor`'s `onKeyDown`,
 * which `preventDefault()`s Enter and Space and starts a keyboard drag — a drag
 * that could then never move, because `sortableKeyboardCoordinates` returns
 * `undefined` for an `active.id` that is not a droppable container and a
 * palette entry is `useDraggable` only. The sensor's own guard ("ignore the key
 * unless the target IS the activator node") does not save it either: it is
 * skipped when `setActivatorNodeRef` was never called. Net effect, until this
 * fix: Enter and Space did nothing whatsoever and Escape was the only way out.
 *
 * So `onKeyDown` is declared AFTER the spread, which is what makes it win, and
 * it does the thing the button says it does. `addsFieldOnKey` is the decision,
 * in `canvas.ts`, where it is unit-tested.
 *
 * ⚠️ `attributes` IS DELIBERATELY NOT SPREAD. It carries
 * `aria-roledescription="draggable"` and an `aria-describedby` pointing at
 * dnd-kit's screen-reader instructions — "press the space bar to pick up a
 * draggable item" — which is now precisely wrong here: space ADDS the field.
 * Everything else `attributes` supplies (`role="button"`, `tabIndex`,
 * `aria-disabled`) a native disabled-able `<button>` already has.
 *
 * A raw `<button>` rather than the `Button` primitive, matching
 * `app/(app)/tasks/board/board-dnd.tsx`: the listeners have to land on the DOM
 * node dnd-kit holds a ref to, and the element is a two-line tile rather than a
 * control on the button scale. It carries the same tokens by hand — a real
 * border, `grade-surface`, `shadow-raised` — so it still reads as raised, and
 * the global `:focus-visible` ring applies unchanged.
 */
export function PaletteDragButton({
  fieldType,
  disabled,
  onClick,
  children,
}: {
  fieldType: FieldType;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${fieldType}`,
    disabled,
    data: { kind: "new", fieldType } satisfies FieldDrag,
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      {...listeners}
      onKeyDown={(event) => {
        if (!addsFieldOnKey(event.key)) return;
        // Both halves matter. `preventDefault` takes the key back off dnd-kit's
        // activator AND off the browser's own click synthesis, so `onClick`
        // fires exactly once — here — for Enter and for Space alike.
        event.preventDefault();
        onClick();
      }}
      className={cn(
        "flex w-full touch-none items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-left grade-surface shadow-raised transition-colors",
        "hover:border-accent-border hover:bg-accent",
        "active:cursor-grabbing active:shadow-none",
        "disabled:pointer-events-none disabled:opacity-50",
        isDragging && "opacity-40",
      )}
    >
      <GripVertical className="size-3.5 shrink-0 text-foreground-faint" aria-hidden />
      {children}
    </button>
  );
}
