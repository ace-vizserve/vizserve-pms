"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** `id` is for the browser only — it keeps a row's identity while it is dragged. */
export type ApproverDraft = { id: string; name: string; email: string };

export const MAX_APPROVERS = 5;

/** Each row must be complete; an untouched blank row is simply dropped. */
export function approverProblem(rows: ApproverDraft[]): string | null {
  for (const row of rows) {
    const name = row.name.trim();
    const email = row.email.trim();
    if (!name && !email) continue;
    if (!name) return "Give each approver a name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "Give each approver a valid email.";
  }
  return null;
}

export function filledApprovers(rows: ApproverDraft[]): { name: string; email: string }[] {
  return rows
    .map((row) => ({ name: row.name.trim(), email: row.email.trim() }))
    .filter((row) => row.name || row.email);
}

/**
 * P16-06 — who signs the finished work off after the requester, in order.
 * The requester is step 1; each row here is the next step.
 */
export function ApproversField({
  rows,
  onChange,
  error,
}: {
  rows: ApproverDraft[];
  onChange: (rows: ApproverDraft[]) => void;
  error: string | null;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function update(id: string, patch: Partial<ApproverDraft>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  // P16-07 — the order IS the chain: dragging a row changes who signs when.
  function onDragEnd(event: DragEndEvent) {
    const from = rows.findIndex((row) => row.id === event.active.id);
    const to = rows.findIndex((row) => row.id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    onChange(arrayMove(rows, from, to));
  }

  return (
    <fieldset className="space-y-3">
      <legend className="mb-3 w-full border-b pb-2 text-sm font-semibold">Who approves the finished work</legend>
      <p className="text-xs text-muted-foreground">
        You approve first. Add anyone else who must sign it off — each gets their own email, in this order, after
        the one before approves. Drag a row to change the order.
      </p>

      <ol className="space-y-2">
        <li className="flex items-center gap-2 text-sm">
          <span className="w-11 shrink-0 text-right text-xs text-muted-foreground tabular-nums">1.</span>
          <span className="text-muted-foreground">You</span>
        </li>
        <DndContext
          id="public-approvers-dnd"
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}>
          <SortableContext id="public-approvers" items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
            {rows.map((row, index) => (
              <ApproverRow
                key={row.id}
                row={row}
                position={index + 2}
                onChange={(patch) => update(row.id, patch)}
                onRemove={() => onChange(rows.filter((other) => other.id !== row.id))}
              />
            ))}
          </SortableContext>
        </DndContext>
      </ol>

      {rows.length < MAX_APPROVERS ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...rows, { id: crypto.randomUUID(), name: "", email: "" }])}>
          <Plus />
          Add approver
        </Button>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function ApproverRow({
  row,
  position,
  onChange,
  onRemove,
}: {
  row: ApproverDraft;
  position: number;
  onChange: (patch: Partial<ApproverDraft>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-start gap-2 rounded-md bg-card", isDragging && "relative z-10 shadow-raised-lg")}>
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move approver ${position}`}
        className="mt-1.5 grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground hover:bg-accent active:cursor-grabbing">
        <GripVertical className="size-4" />
      </button>
      <span className="w-2 shrink-0 pt-2 text-xs text-muted-foreground tabular-nums">{position}.</span>
      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`approver-name-${row.id}`} className="sr-only">
            Approver {position} name
          </Label>
          <Input
            id={`approver-name-${row.id}`}
            placeholder="Name"
            value={row.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`approver-email-${row.id}`} className="sr-only">
            Approver {position} email
          </Label>
          <Input
            id={`approver-email-${row.id}`}
            type="email"
            placeholder="Email"
            value={row.email}
            onChange={(event) => onChange({ email: event.target.value })}
          />
        </div>
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove approver ${position}`} onClick={onRemove}>
        <X />
      </Button>
    </li>
  );
}
