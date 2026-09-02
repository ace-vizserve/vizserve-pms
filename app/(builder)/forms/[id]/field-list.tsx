"use client";

import { useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { FIELD_TYPE_LABELS, type CanvasField } from "@/lib/form-builder/canvas";
import { FieldDragHandle, SortableFieldRow } from "@/lib/form-builder/dnd";

/**
 * P7-66 — THE LEFT RAIL: the questions as a list, for putting them in order.
 *
 * ⚠️ THIS IS THE THIRD SHAPE THIS SCREEN HAS HAD, and the reason is worth
 * keeping. The first put the editor inside the row; the second was Elementor —
 * a palette of types on the left, SUMMARY cards in the middle ("Long text ·
 * Required"), an attributes panel on the right. Both were rejected for the same
 * underlying reason: the middle of the screen showed a description of the form
 * rather than the form. What was asked for is Google Forms — the live form in
 * the middle, and a panel on the left for sorting.
 *
 * So this rail has ONE job. It is not a preview and it is not an editor: it is
 * the running order, compact enough to see a fifteen-question form at once,
 * which is exactly what the live form in the main column cannot do. Clicking a
 * row opens that question over there.
 *
 * THREE WAYS TO MOVE ONE FIELD, and they are not three rules:
 *   - the grip, dragged (`SortableFieldRow`);
 *   - the up/down buttons, which are the KEYBOARD path and are not going
 *     anywhere — WCAG 2.2 AA 2.1.1, and they are the tested one;
 *   - dnd-kit's keyboard sensor, off the same grip.
 * All three end in `planEntityReorder`. See `lib/form-builder/canvas.ts`.
 *
 * SELECTION IS NOT CARRIED BY COLOUR ALONE. The selected row takes an accent
 * fill AND a 3px brand rail down its leading edge AND `aria-current`, so it
 * survives greyscale and a screen reader both — and it is the same mark the
 * question wears in the main column, so the two read as one selection.
 */
function FieldRow({
  field,
  index,
  count,
  selected,
  busy,
  pending,
  onSelect,
  onMove,
  onArchive,
}: {
  field: CanvasField;
  /** Position among the fields the user can SEE, not in `root`. */
  index: number;
  count: number;
  selected: boolean;
  /** A save is in flight, or the form holds unsaved edits. */
  busy: boolean;
  /**
   * ⚠️ A SAVE IS IN FLIGHT. Narrower than `busy` ON PURPOSE — see the select
   * button below. `busy` would also cover `dirty`, and selecting another field
   * while one is half-typed is a documented, deliberate discard, not a bug.
   */
  pending: boolean;
  onSelect: () => void;
  onMove: (direction: "up" | "down") => void;
  onArchive: () => void;
}) {
  const { label, required } = field.entity.attributes;
  // Named to the user by its label; "this field" only until it has one.
  const name = label || "this field";

  return (
    <SortableFieldRow id={field.id} disabled={busy} className="list-none">
      <div
        className={cn(
          "relative flex items-center gap-0.5 overflow-hidden rounded-md border transition-colors",
          selected
            ? "border-primary bg-accent"
            : "border-transparent hover:border-accent-border hover:bg-accent/50",
        )}
      >
        {/* The non-colour half of "this one is open in the form". */}
        {selected ? (
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-primary" />
        ) : null}

        <FieldDragHandle label={`Drag to reorder ${name}`} />

        {/*
          ⚠️ `disabled` WHILE A SAVE IS IN FLIGHT, RESTORING THE GUARD THE FIRST
          BUILDER HAD ON ITS Edit BUTTON.

          `onSelect` runs `resetBuilderStore(store, savedSchema)`, and mid-save
          `savedSchema` is still the PRE-save document. The save then advances
          it, leaving the store on the old order and `savedSchema` on the new
          one: the list shows a stale order, `dirty` sticks true with nothing
          typed behind it, and the next save writes the old order straight back
          over the rows. One click during a reorder save was enough.

          `pending`, not `busy`: the list is deliberately still selectable while
          `dirty`, where switching fields discards the edit and says so.
        */}
        <button
          type="button"
          disabled={pending}
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          className="min-w-0 flex-1 rounded-sm px-1 py-1 text-left disabled:cursor-default"
        >
          <span className="flex items-baseline gap-1">
            <span className="text-2xs tabular-nums text-foreground-faint">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {label || "Untitled question"}
              {required ? (
                <span className="ml-0.5 text-destructive" aria-label="required">
                  *
                </span>
              ) : null}
            </span>
          </span>
          <span className="block truncate pl-4 text-2xs text-muted-foreground">
            {FIELD_TYPE_LABELS[field.entity.type]}
          </span>
        </button>

        {/*
          ⚠️ THE KEYBOARD PATH. Backed by `planEntityReorder`, including its
          "nearest VISIBLE neighbour" rule that steps over an archived field.
          Drag is an enhancement over this, never a replacement for it.
        */}
        <div className="flex shrink-0 flex-col">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Move ${name} up`}
            disabled={busy || index === 0}
            onClick={() => onMove("up")}
          >
            <ChevronUp />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Move ${name} down`}
            disabled={busy || index === count - 1}
            onClick={() => onMove("down")}
          >
            <ChevronDown />
          </Button>
        </div>

        {/*
          Archive, never delete. Historical requests and staff responses store
          answers under this field's key, so removing the row would orphan them —
          and `vizserve_pms_form_field_protect` refuses the delete outright once
          one exists.
        */}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Archive ${name}`}
          disabled={busy}
          onClick={onArchive}
        >
          <Archive />
        </Button>
      </div>
    </SortableFieldRow>
  );
}

export function FieldList({
  active,
  archived,
  selectedId,
  busy,
  pending,
  onSelect,
  onMove,
  onArchive,
  onRestore,
}: {
  active: ReadonlyArray<CanvasField>;
  archived: ReadonlyArray<CanvasField>;
  selectedId: string | null;
  busy: boolean;
  pending: boolean;
  onSelect: (entityId: string) => void;
  onMove: (entityId: string, direction: "up" | "down") => void;
  onArchive: (entityId: string) => void;
  onRestore: (entityId: string) => void;
}) {
  /*
   * ⚠️ COLLAPSED, AND IT STARTS THAT WAY. An archived question is not part of
   * the form — nobody will ever be asked it again — so it has no business
   * taking space above the questions that are. It is kept reachable rather than
   * prominent, because the only thing anybody comes here to do with one is put
   * it back.
   */
  const [showArchived, setShowArchived] = useState(false);

  return (
    <aside
      aria-label="Questions"
      className="rounded-lg border bg-card p-2 grade-surface shadow-raised-lg lg:sticky lg:top-18 lg:max-h-[calc(100svh-5.5rem)] lg:overflow-y-auto"
    >
      <h2 className="px-2 py-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        Questions ({active.length})
      </h2>

      {active.length === 0 ? (
        <p className="px-2 py-1 text-2xs text-balance text-muted-foreground">
          The order of your questions will show here.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {active.map((field, index) => (
            <FieldRow
              key={field.id}
              field={field}
              index={index}
              count={active.length}
              selected={selectedId === field.id}
              busy={busy}
              pending={pending}
              onSelect={() => onSelect(field.id)}
              onMove={(direction) => onMove(field.id, direction)}
              onArchive={() => onArchive(field.id)}
            />
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <Collapsible
          open={showArchived}
          onOpenChange={setShowArchived}
          className="mt-2 border-t pt-2"
        >
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <Archive className="size-3 shrink-0" aria-hidden />
            <span>Archived ({archived.length})</span>
            <ChevronDown
              aria-hidden
              className={cn(
                "ml-auto size-3 shrink-0 transition-transform duration-150",
                showArchived && "rotate-180",
              )}
            />
          </CollapsibleTrigger>

          <CollapsibleContent>
            {/* Archived rather than deleted: existing requests and responses
                still store answers under these keys, so removing them would
                orphan data. */}
            <p className="px-2 pt-1.5 text-2xs text-balance text-muted-foreground">
              Not on the form. Kept because answers were filed under them.
            </p>
            <ul className="space-y-0.5 pt-1">
              {archived.map((field) => (
                <li key={field.id} className="flex items-center gap-1 px-1">
                  <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                    {field.entity.attributes.label || field.entity.attributes.key}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Restore ${field.entity.attributes.label || "this field"}`}
                    disabled={busy}
                    onClick={() => onRestore(field.id)}
                  >
                    <ArchiveRestore />
                  </Button>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </aside>
  );
}
