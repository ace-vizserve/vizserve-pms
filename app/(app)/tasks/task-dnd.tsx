"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type CollisionDetection,
  type DragOverEvent,
  type DragEndEvent,
  type Over,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import type { RowProps } from "@/components/data-table";
import { TableRow } from "@/components/ui/table";
import type { DropTarget } from "@/lib/task-drop";
import { cn } from "@/lib/utils";

/**
 * P7-82 — THE ONLY FILE ON THE TASK LIST THAT IMPORTS `@dnd-kit`, the same
 * containment `board-dnd.tsx` and the timesheet's `row-dnd.tsx` keep.
 *
 * ⚠️ IT REPORTS WHERE THE ROW LANDED; IT DOES NOT DECIDE WHAT THAT MEANS. The
 * drop goes to `planTaskDrop` in `lib/task-drop.ts`, which is pure and tested.
 *
 * SORTABLE, LIKE THE TIMESHEET: the rows slide out of the way as you drag, one
 * `SortableContext` per status group. On top of that, the MIDDLE of a row means
 * "make it a subtask of this one" — see `makeCollision` — so dropping there makes
 * the dragged task its subtask instead of moving it.
 *
 * ⚠️ TWO CONTEXTS, AND THE SPLIT IS THE PERFORMANCE. The first cut had one, and
 * the tables read it to know whether dragging was on — so every change of
 * target mid-drag re-rendered all eight tables and every cell in them, which is
 * what made the drag stutter. `Enabled` never changes during a drag and is all
 * the tables read; `Live` changes constantly and only the titles read it.
 */

type DragInfo = {
  id: string;
  title: string;
  hasChildren: boolean;
  /** Under a parent, on screen or not — so it cannot take subtasks (P7-09). */
  isChild: boolean;
  parentId: string | null;
};

const EnabledContext = createContext(false);
const LiveContext = createContext<{ active: DragInfo | null; target: DropTarget | null }>({
  active: null,
  target: null,
});

/** False outside the list — the board and anything else render rows without it. */
export function useTaskDndEnabled() {
  return useContext(EnabledContext);
}

const NEST = "nest:";

/**
 * The share of a row's height, top and bottom, that means "put it here". The
 * middle is "make it a subtask of this one".
 */
const EDGE = 0.25;

/*
 * ⚠️ NEST IS DECIDED BY WHERE THE POINTER IS INSIDE A ROW, NOT BY A HITBOX ON
 * THE TITLE, and that was a bug fix.
 *
 * dnd-kit measures every droppable once, when the drag starts; the sliding is
 * a CSS transform it applies afterwards. So a hitbox on the title stayed where
 * the title WAS while the title itself slid a row away — the second task
 * nested under a parent had to chase a target that kept moving.
 *
 * Here both halves use those same original rects. The middle of a row is
 * "nest": that is not a sortable position, so every row slides back — and the
 * row being aimed at returns to exactly where the pointer is. The edges are a
 * move, and the rows slide. The keyboard has no pointer, so it only moves.
 */
function makeCollision(
  info: (id: string) => DragInfo | null,
): CollisionDetection {
  return (args) => {
    const rows = args.droppableContainers.filter(
      (container) => !String(container.id).startsWith(NEST),
    );

    const point = args.pointerCoordinates;
    if (point) {
      const under = pointerWithin({ ...args, droppableContainers: rows })[0];
      const rect = under ? args.droppableRects.get(under.id) : undefined;
      const moving = info(String(args.active.id));
      const onto = under ? info(String(under.id)) : null;

      if (
        under &&
        rect &&
        moving &&
        onto &&
        onto.id !== moving.id &&
        !onto.isChild &&
        !moving.hasChildren &&
        moving.parentId !== onto.id &&
        point.y > rect.top + rect.height * EDGE &&
        point.y < rect.bottom - rect.height * EDGE
      ) {
        return [{ id: `${NEST}${onto.id}` }];
      }
    }

    return closestCenter({ ...args, droppableContainers: rows });
  };
}

type SortableData = { sortable?: { containerId: string | number; index: number } };

function targetOf(active: Active, over: Over | null): DropTarget | null {
  if (!over) return null;

  const id = String(over.id);
  if (id.startsWith(NEST)) return { kind: "nest", id: id.slice(NEST.length) };
  if (id === String(active.id)) return null;

  // In one group, the sortable's own indices say which way it is going.
  const from = (active.data.current as SortableData | undefined)?.sortable;
  const to = (over.data.current as SortableData | undefined)?.sortable;
  if (from && to && from.containerId === to.containerId) {
    return { kind: "row", id, placement: from.index < to.index ? "after" : "before" };
  }

  // Across groups, the middle of the row decides.
  const rect = active.rect.current.translated;
  const y = rect ? rect.top + rect.height / 2 : over.rect.top;
  return { kind: "row", id, placement: y < over.rect.top + over.rect.height / 2 ? "before" : "after" };
}

export function TaskListDnd({
  info,
  onDrop,
  children,
}: {
  info: (id: string) => DragInfo | null;
  onDrop: (activeId: string, target: DropTarget) => void;
  children: ReactNode;
}) {
  const [active, setActive] = useState<DragInfo | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  /* Remade only when `info` is, and `info` changes with the rows — which do not
     change mid-drag. So a drag keeps one collision function throughout. */
  const collision = useMemo(() => makeCollision(info), [info]);

  const sensors = useSensors(
    // 8px, as on the board and the timesheet: every row is full of controls,
    // and a press that twitches must still be a press.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // `onDragOver`, not `onDragMove`: it fires when the target CHANGES, not on
  // every pixel of pointer travel.
  function onOver(event: DragOverEvent) {
    setTarget(targetOf(event.active, event.over));
  }

  function onEnd(event: DragEndEvent) {
    const landed = targetOf(event.active, event.over);
    setActive(null);
    setTarget(null);
    // No target is a drop into empty space: an abandoned gesture, not a move.
    if (landed) onDrop(String(event.active.id), landed);
  }

  const title = (id: string | number) => info(String(id).replace(NEST, ""))?.title ?? "task";

  return (
    <EnabledContext value>
      <LiveContext value={{ active, target }}>
        <DndContext
          id="task-list-dnd"
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={(event) => setActive(info(String(event.active.id)))}
          onDragOver={onOver}
          onDragEnd={onEnd}
          onDragCancel={() => {
            setActive(null);
            setTarget(null);
          }}
          accessibility={{
            announcements: {
              onDragStart: ({ active: a }) => `Picked up ${title(a.id)}.`,
              onDragOver: ({ over }) =>
                over
                  ? String(over.id).startsWith(NEST)
                    ? `Over ${title(over.id)}. Drop to make it a subtask.`
                    : `Over ${title(over.id)}.`
                  : "Not over a task.",
              onDragEnd: ({ active: a, over }) =>
                over ? `Dropped ${title(a.id)}.` : `${title(a.id)} was not moved.`,
              onDragCancel: ({ active: a }) => `Cancelled. ${title(a.id)} was not moved.`,
            },
          }}>
          {children}

          {/* A chip under the pointer, while the row itself holds its new place
              in the list. A `<tr>` cannot be the overlay: it needs a whole
              second `<table>` round it, and it would be clipped by the group's
              scroll box the moment it left its own stage. */}
          <DragOverlay dropAnimation={null}>
            {active ? (
              <div className="flex max-w-80 cursor-grabbing items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm font-medium shadow-raised">
                <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{active.title}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </LiveContext>
    </EnabledContext>
  );
}

/** One status group's rows, top to bottom, subtasks after their parent. */
export function TaskGroupSortable({
  id,
  itemIds,
  children,
}: {
  id: string;
  itemIds: string[];
  children: ReactNode;
}) {
  return (
    <SortableContext id={id} items={itemIds} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

/* -------------------------------------------------------------------------- */
/* A row.                                                                      */
/* -------------------------------------------------------------------------- */

type HandleProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: (node: HTMLElement | null) => void;
};

const GripContext = createContext<HandleProps | null>(null);

/**
 * One task row. Picked up by its grip; slides aside for the rows around it.
 * `draggable` is false where the viewer may not change the task — it still
 * makes room, because another task can land beside it.
 *
 * ⚠️ `children` ARE THE FINISHED CELLS, built by the table. So a row
 * re-rendering as it slides does not re-render a single cell.
 */
export function DraggableTaskRow({
  id,
  draggable,
  row: { ref: rowRef, className, children, ...rowProps },
}: {
  id: string;
  draggable: boolean;
  /** What `DataTable` hands `renderRow` — its measuring ref and arming handlers. */
  row: RowProps;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: { draggable: !draggable, droppable: false } });

  return (
    <TableRow
      {...rowProps}
      ref={(node) => {
        setNodeRef(node);
        rowRef?.(node);
      }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        className,
        "align-top",
        // The gap it will drop into, held open and tinted — the chip under the
        // pointer is the thing being carried.
        isDragging && "relative z-10 opacity-40 [&>td]:bg-muted",
      )}>
      <GripContext.Provider
        value={
          draggable ? { ref: setActivatorNodeRef, ...attributes, ...listeners } : null
        }>
        {children}
      </GripContext.Provider>
    </TableRow>
  );
}

/**
 * The grip. A real button, so it is tabbable: space picks the row up, the arrow
 * keys move it, space drops it. 24px, WCAG 2.2 §2.5.8's floor. `touch-none` so a
 * finger drags the row instead of scrolling the page.
 */
export function TaskGrip({ title }: { title: string }) {
  const handle = useContext(GripContext);
  if (!handle) return <span className="block size-6 shrink-0" aria-hidden />;

  return (
    <button
      type="button"
      {...handle}
      aria-label={`Move ${title}. Drop on another task's title to make it a subtask.`}
      className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-foreground-faint opacity-60 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 active:cursor-grabbing">
      <GripVertical className="size-4" aria-hidden />
    </button>
  );
}

/**
 * The title, lit while a drop would make the dragged task its subtask. The
 * DECISION is `makeCollision`'s (the middle of the row); this only registers
 * the `nest:` id it answers with, and says so on screen.
 */
export function NestTarget({
  id,
  isChild,
  children,
}: {
  id: string;
  isChild: boolean;
  children: ReactNode;
}) {
  const { target } = useContext(LiveContext);
  const { setNodeRef } = useDroppable({ id: `${NEST}${id}`, disabled: isChild });
  const lit = !isChild && target?.kind === "nest" && target.id === id;

  return (
    <span
      ref={setNodeRef}
      className={cn(
        "relative -mx-1 flex min-w-0 items-center gap-2 rounded-sm px-1 transition-colors",
        lit && "bg-primary/10 ring-2 ring-primary",
      )}>
      {children}
      {lit ? (
        <span className="shrink-0 rounded-sm bg-primary px-1.5 py-0.5 text-2xs font-medium text-primary-foreground">
          Make subtask
        </span>
      ) : null}
    </span>
  );
}
