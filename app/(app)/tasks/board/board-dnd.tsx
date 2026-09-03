"use client";

import * as React from "react";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
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

const BoardDragContext = createContext<DragState>({ allowed: null });

export function BoardDnd({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<{ id: string; title: string } | null>(null);
  const [, startMove] = useTransition();

  const sensors = useSensors(
    /*
     * An 8px activation distance, so a click is still a click.
     *
     * The card holds a link and a row of hover actions; without this every
     * attempt to open a task would begin a drag instead, and the link would
     * never fire.
     */
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // §5.3 — every interaction has to be reachable by keyboard. dnd-kit gives
    // this for free and hand-rolled HTML5 drag does not, which is most of why
    // the dependency is here at all.
    useSensor(KeyboardSensor),
  );

  function onDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { allowed?: string[]; title?: string } | undefined;
    setAllowed(data?.allowed ?? []);
    setDragging({ id: String(event.active.id), title: data?.title ?? "" });
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
        router.refresh();
        return;
      }

      router.refresh();
    });
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setAllowed(null);
        setDragging(null);
      }}
    >
      <BoardDragContext.Provider value={{ allowed }}>{children}</BoardDragContext.Provider>

      {/* A plain label rather than a clone of the card: the real card stays put
          until the server confirms, so a full-fidelity ghost would read as the
          move having already happened. */}
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="pointer-events-none max-w-64 truncate rounded-md border bg-card px-2.5 py-1.5 text-sm font-medium shadow-overlay">
            {dragging.title}
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

  return (
    <div
      ref={setNodeRef}
      className={cn(className, "relative", isDragging && "opacity-40")}
    >
      {/*
       * A DEDICATED HANDLE, not the whole card.
       *
       * The card holds a link, a status control and four hover actions. Making
       * the card itself draggable puts dnd-kit's listeners above all of them,
       * and the keyboard sensor would steal Space and the arrow keys from the
       * status dropdown. A handle keeps drag in one place that does nothing else.
       *
       * It is a real <button>, so it is tabbable and the keyboard sensor has
       * something to attach to — which is the whole accessibility story here.
       */}
      {allowed.length > 0 ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Move ${title}`}
          className={cn(
            "absolute top-1.5 left-0.5 z-10 flex size-5 cursor-grab items-center justify-center rounded-sm",
            "text-foreground-faint hover:bg-accent hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            "active:cursor-grabbing",
            // Hidden until wanted, on the same rule as the row actions — but
            // always present for a keyboard, which has no hover.
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
