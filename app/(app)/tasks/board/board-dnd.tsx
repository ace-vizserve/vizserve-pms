"use client";

import * as React from "react";
import { createContext, useContext, useRef, useState, useTransition, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ChevronDown, GripVertical } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { cn } from "@/lib/utils";

import { transitionTask } from "../actions";

/**
 * P7-20 — dragging a card between columns.
 *
 * `app/(app)/tasks/board/page.tsx` used to carry the line "it is why there is no
 * dragging, which is the first thing anyone tries". This is that.
 *
 * ⚠️ THE LEGAL MOVES ARE NOT DECIDED HERE. Each card is handed the list of
 * statuses it may reach, computed on the server by `availableTransitions()` —
 * the same function the status dropdown uses, which in turn mirrors
 * `vizserve_pms_transition_task`. A board that worked out its own rules would be
 * a fourth copy of them.
 *
 * What that function says, and it surprises people:
 *
 *   * INTERNAL WORK MOVES ANYWHERE. `p7_13a` removed the transition-table
 *     lookup entirely for work with no client — any status to any status. Its
 *     own comment calls the result "a board card people drag about", so this
 *     feature is what that migration was for.
 *   * except FOR_CLIENT_APPROVAL, which is a dead end rather than a gate:
 *     `issue_approval_token` refuses a task with no request, so a card dropped
 *     there could never be finished or moved back.
 *   * CLIENT WORK STILL FOLLOWS ITS GATES. Every one of them has somebody
 *     outside the company on the other end.
 *
 * So a column that cannot accept the card dims and refuses the drop, rather than
 * taking it and springing back on a server error. A board that accepts a move it
 * knows will fail is a board people stop trusting.
 */

type DragState = {
  /** Statuses the card being dragged may reach, or null when nothing is dragging. */
  allowed: string[] | null;
};

/**
 * ⚠️ MEASURE THE COLUMNS ON EVERY FRAME OF A DRAG, not once when it starts.
 *
 * dnd-kit's default measures droppables at drag start and trusts those
 * rectangles for the rest of it. Every column on this board SCROLLS INSIDE
 * ITSELF — the board owns its own scrolling, see the page — so a reader who
 * drags to the bottom of a long column and lets it scroll is dropping against
 * rectangles taken before the scroll, and the card lands in whichever column
 * used to be under the pointer. `Always` re-measures, which costs a layout read
 * per frame on at most eight boxes.
 */
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } } as const;

/**
 * How far the pointer travels before the gesture is a drag rather than a click.
 *
 * ⚠️ ONE CONSTANT, READ TWICE — by the sensor that decides to start dragging,
 * and by the click guard in `BoardCard` that decides whether the click which
 * follows was part of one. Two numbers here would mean a window in which the
 * card moves AND the link fires.
 */
const DRAG_DISTANCE = 8;

/**
 * Things inside a card that a POINTER-DOWN must never start a drag from.
 *
 * The card is the drag surface now (see `BoardCard`), and it is also a card
 * with a status badge that opens a menu, a rename popover, a priority flag, a
 * subtask composer and a delete dialog on it. `DRAG_DISTANCE` already keeps a
 * plain CLICK a click — but a 9px wobble while pressing the rename button would
 * begin dragging the task instead of opening the field, and these controls open
 * on POINTER-DOWN, before the guard below ever sees a click.
 *
 * ⚠️ THE TITLE LINK IS DELIBERATELY NOT IN THIS LIST. It is the largest thing
 * on a card and the first thing a hand reaches for, so excluding it would
 * leave "drag the whole card" meaning "drag the card's margins". An anchor
 * navigates on CLICK, which is late enough for the guard to cancel it, and
 * dnd-kit kills the browser's own link-dragging (`dragstart → preventDefault`)
 * the moment the pointer goes down.
 */
const CONTROL_SELECTOR = "button,input,textarea,select,[role='button'],[contenteditable='true']";

const BoardDragContext = createContext<DragState>({ allowed: null });

export function BoardDnd({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<{
    id: string;
    title: string;
    /** The card's own footprint, measured at the moment it was picked up. */
    width: number;
    height: number;
  } | null>(null);
  const [, startMove] = useTransition();

  const sensors = useSensors(
    /*
     * An 8px activation distance, so a click is still a click.
     *
     * The card holds a link and a row of actions; without this every attempt to
     * open a task would begin a drag instead, and the link would never fire.
     *
     * ⚠️ AND IT CARRIES MORE WEIGHT SINCE P12-18, when the whole card became
     * the drag surface rather than a 20px grip. Every press anywhere on a card
     * is now a potential drag, and this distance is the only thing standing
     * between "I clicked the task" and "I moved the task" — the pointer has to
     * travel 8px before dnd-kit claims the gesture.
     */
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE } }),
    // §5.3 — every interaction has to be reachable by keyboard. dnd-kit gives
    // this for free and hand-rolled HTML5 drag does not, which is most of why
    // the dependency is here at all.
    useSensor(KeyboardSensor),
  );

  function onDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { allowed?: string[]; title?: string } | undefined;

    // dnd-kit measured the card to start the drag, so its rect is already here
    // — nothing below reads the DOM.
    const rect = event.active.rect.current.initial;

    setAllowed(data?.allowed ?? []);
    setDragging({
      id: String(event.active.id),
      title: data?.title ?? "",
      width: rect?.width ?? 240,
      height: rect?.height ?? 72,
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const data = event.active.data.current as
      | { allowed?: string[]; status?: string; title?: string }
      | undefined;
    setAllowed(null);
    setDragging(null);

    const target = event.over ? String(event.over.id) : null;
    if (!target || target === data?.status) return;

    // Belt and braces. The column already refused the drop, so reaching this is
    // a bug rather than a user action — but silently transitioning would then be
    // the server's problem instead of ours.
    if (!data?.allowed?.includes(target)) return;

    const taskId = String(event.active.id);

    startMove(async () => {
      /*
       * ⚠️ `comment` OMITTED, not `null`.
       *
       * `transitionPayloadSchema` types it `.optional()`, not `.nullable()`, so
       * `{ comment: null }` fails zod and the action answers "Check the
       * highlighted fields" — a form error, on a drag with no form and no field
       * to highlight. That is exactly how it read in the log.
       */
      const result = await transitionTask(taskId, { to_status: target });

      if (!result.ok) {
        toast.error(result.error);
        // Nothing to roll back: the card never moved in the DOM. The server is
        // the only thing that decides where it sits, and `router.refresh()`
        // below re-reads it.
        return;
      }

    });
  }

  return (
    <DndContext
      sensors={sensors}
      measuring={MEASURING}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setAllowed(null);
        setDragging(null);
      }}
    >
      <BoardDragContext.Provider value={{ allowed }}>{children}</BoardDragContext.Provider>

      {/*
        P12-18 — A CARD-SHAPED GHOST, AND IT USED TO BE A BARE LABEL.

        The note here read: "a plain label rather than a clone of the card,
        because the real card stays put until the server confirms and a
        full-fidelity ghost would read as the move having already happened".
        That reasoning held while the drag started from a 20px grip. Now that
        the whole card is the handle, a 28px-tall strip of text under the
        pointer reads as having grabbed the TITLE off the card and left the card
        behind — which is exactly what it looked like.

        So the ghost takes the card's own measured footprint: same width, same
        height, so the space it will occupy is visible while choosing a column.
        It is still deliberately NOT a copy of the card's contents — the dashed
        edge and the single line say "this is where it would go", not "this has
        moved". The real card stays in place at 40% until the server confirms.
      */}
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div
            style={{ width: dragging.width, height: dragging.height }}
            className="pointer-events-none flex items-start rounded-md border-2 border-dashed border-primary/60 bg-card/95 p-2.5 pl-5 text-sm font-medium shadow-overlay">
            {/* Three lines at most: a long title in a tall card would otherwise
                fill the ghost and turn it back into a block of text. */}
            <span className="line-clamp-3">{dragging.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export function BoardColumn({
  status,
  className,
  children,
  ...rest
}: {
  status: string;
  className?: string;
  children: ReactNode;
  /*
   * ⚠️ `...rest` IS LOAD-BEARING, and its absence would not have been caught.
   *
   * The page passes `aria-label="Waiting for QA column"` — the column's only
   * accessible name. TypeScript does NOT flag it as an excess prop, because JSX
   * attributes containing a hyphen bypass excess-property checking entirely (so
   * that `data-*` and `aria-*` keep working). Without this spread the label was
   * accepted, dropped on the floor, and every column announced as nothing.
   */
} & Omit<React.ComponentProps<"section">, "className" | "children">) {
  const { allowed } = useContext(BoardDragContext);
  const { setNodeRef, isOver } = useDroppable({ id: status });

  const dragging = allowed !== null;
  const blocked = dragging && !allowed.includes(status);

  return (
    <section
      {...rest}
      ref={setNodeRef}
      // ⚠️ NOT `aria-disabled`. The column is not disabled — it is a valid
      // destination for other cards, and only this one cannot go there.
      data-blocked={blocked || undefined}
      className={cn(
        className,
        "transition-[opacity,box-shadow]",
        // Dimmed rather than hidden: a column that vanishes mid-drag moves every
        // other column sideways under the pointer.
        blocked && "pointer-events-none opacity-40",
        isOver && !blocked && "ring-2 ring-ring",
      )}
    >
      {children}
    </section>
  );
}

export function BoardCard({
  taskId,
  title,
  status,
  allowed,
  className,
  children,
}: {
  taskId: string;
  title: string;
  status: string;
  /** From `availableTransitions()` on the server. Empty means "cannot move". */
  allowed: string[];
  className?: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: taskId,
    data: { allowed, status, title },
    disabled: allowed.length === 0,
  });

  /*
   * P12-18 — THE WHOLE CARD DRAGS, and the split below is what makes that safe.
   *
   * It used to be the grip alone, and the note here argued for it: "making the
   * card itself draggable puts dnd-kit's listeners above all of them, and the
   * keyboard sensor would steal Space and the arrow keys from the status
   * dropdown". That is true of `attributes` and of `onKeyDown` — and of nothing
   * else. So they are the only things that stay on the grip.
   *
   *   `attributes`   role, tabIndex, aria-*, and `aria-roledescription`. On the
   *                  card it would make every card a tabbable "draggable item"
   *                  wrapping six other tab stops.
   *   `onKeyDown`    the KeyboardSensor's activator. Key events BUBBLE, so on
   *                  the card a Space or an arrow pressed inside the status
   *                  menu, the rename field or the subtask composer would
   *                  arrive here and start a drag.
   *   everything     `onPointerDown`. Safe on the card, gated by
   *   else           `CONTROL_SELECTOR` so a press on a control is never a drag.
   *
   * The result: a pointer drags from anywhere on the card, a keyboard drags
   * from the grip, and the two are the same drag.
   */
  /* dnd-kit types the map as `Record<string, Function>` — it cannot know which
     event each key belongs to — so the two that are pulled out by name are
     asserted back to the handlers they are. */
  const { onKeyDown, onPointerDown, ...cardListeners } = listeners ?? {};
  const keyboardActivator = onKeyDown as React.KeyboardEventHandler<HTMLButtonElement> | undefined;
  const pointerActivator = onPointerDown as React.PointerEventHandler<HTMLDivElement> | undefined;

  const draggable = allowed.length > 0;

  /**
   * Where the pointer went down, kept until the click that ends the gesture.
   *
   * ⚠️ THIS IS WHAT LETS THE TITLE BE BOTH A LINK AND A DRAG SURFACE, and
   * without it the card cannot have both. dnd-kit does stop the click that
   * follows a drag — `stopPropagation` at document capture, which is enough to
   * kill React's own handler and therefore `next/link`'s navigation — but an
   * anchor's DEFAULT ACTION is not propagation and survives it. The result is a
   * card dragged by its title that lands in the new column and then navigates
   * to the task anyway, leaving the board entirely.
   *
   * A ref rather than state: nothing renders from it, and setting state on
   * every pointer-down would re-render every card on the board.
   */
  const pressedAt = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={setNodeRef}
      {...(draggable ? cardListeners : null)}
      onPointerDown={
        draggable
          ? (event) => {
              const target = event.target as HTMLElement;

              pressedAt.current = { x: event.clientX, y: event.clientY };

              /* ⚠️ THE GRIP IS EXEMPT, AND MUST BE. It is a <button>, so the
                 guard below would refuse to drag from the one control that
                 exists to drag — the press bubbles up to here, because the grip
                 no longer carries `onPointerDown` itself. */
              if (!target.closest("[data-drag-handle]")) {
                // `closest` from the actual target, so a press on the icon
                // INSIDE a button counts as a press on the button.
                if (target.closest(CONTROL_SELECTOR)) return;
              }

              pointerActivator?.(event);
            }
          : undefined
      }
      onClickCapture={
        draggable
          ? (event) => {
              const from = pressedAt.current;

              pressedAt.current = null;
              if (!from) return;

              // The gesture moved. Whatever it ended on — the title link, or a
              // control the drag never started from — it was not a click.
              if (
                Math.abs(event.clientX - from.x) > DRAG_DISTANCE ||
                Math.abs(event.clientY - from.y) > DRAG_DISTANCE
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }
          : undefined
      }
      className={cn(
        className,
        "relative",
        // ⚠️ NOT `cursor-grab` ON THE CARD'S OWN CLASS ALONE — the link and the
        // buttons inside set their own cursor, so the pointer still tells the
        // truth over a control. A card with nowhere legal to go keeps the
        // default cursor, because it cannot be dragged at all.
        draggable && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      {/*
       * THE GRIP IS NOW THE KEYBOARD'S HANDLE AND THE POINTER'S HINT.
       *
       * It is a real <button>, so it is tabbable and the KeyboardSensor has
       * something to attach to — which is the whole accessibility story here,
       * and the reason it survives the card becoming draggable rather than
       * being deleted with the rest of the handle-only design.
       */}
      {draggable ? (
        <button
          type="button"
          {...attributes}
          // ⚠️ THE KEYBOARD ACTIVATOR ONLY, never `{...listeners}` again. The
          // card already holds the pointer half; spreading the whole map here
          // too would register `onPointerDown` twice on one press — the card's
          // handler and this one, nested — which dnd-kit reads as a second
          // activation.
          onKeyDown={keyboardActivator}
          // Read by the card's pointer guard above — without it the card
          // refuses to start a drag from its own handle.
          data-drag-handle
          aria-label={`Move ${title}`}
          className={cn(
            "absolute top-1.5 left-0.5 z-10 flex size-5 cursor-grab items-center justify-center rounded-sm",
            "text-foreground-faint hover:bg-accent hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            "active:cursor-grabbing",
            // ⚠️ STILL HOVER-REVEALED, where the action strip beside it is not
            // (P12-18). The strip's buttons are the only way to reach what they
            // do; this one is a second route to something the whole card
            // already does, and a grip permanently drawn on every card would
            // advertise the handle-only behaviour that no longer exists.
            // Always present for a keyboard, which has no hover — and for a
            // keyboard it is not a second route but the only one.
            "opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100",
          )}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
      ) : null}

      {children}
    </div>
  );
}

/**
 * P7-09 — a parent card with its subtasks folded underneath it.
 *
 * The board used to drop subtasks entirely (`!task.parent_task_id`), so a card
 * saying "10 subtasks" was the only trace of ten pieces of work — countable and
 * unreachable. They render nested now, on the same rule the list follows: a
 * subtask lives under its parent whatever its own status, and leaves only when
 * it is finished.
 *
 * ⚠️ SUBTASKS ARE NOT DRAGGABLE, and that is the point rather than a shortcut.
 * Their stage follows the piece of work they belong to; dragging one to another
 * column is exactly the move the parent grouping exists to prevent. They keep
 * their status control, because finishing one is a real thing to do.
 *
 * COLLAPSED BY DEFAULT. Ten subtask cards expanded is a column nobody can scan,
 * and the count is what most people came for.
 */
export function BoardTaskGroup({
  count,
  label,
  parent,
  children,
}: {
  count: number;
  label: string;
  parent: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  if (count === 0) return <>{parent}</>;

  return (
    <div className="flex flex-col gap-1.5">
      {parent}

      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="ml-2 flex items-center gap-1 self-start rounded-sm px-1 py-0.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
        />
        {count} {count === 1 ? "subtask" : "subtasks"}
        {/* The parent's name in the accessible name, because "10 subtasks" is
            what six of these buttons in one column all say. */}
        <span className="sr-only"> of {label}</span>
      </button>

      {/* Indented by a left rule rather than padding alone — with several
          parents in one column, whitespace on its own stops saying which card a
          group belongs to. */}
      {open ? <div className="ml-2 flex flex-col gap-1.5 border-l pl-2">{children}</div> : null}
    </div>
  );
}
