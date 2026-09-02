"use client";

import { Archive, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FIELD_TYPE_LABELS, type CanvasField } from "@/lib/form-builder/canvas";
import { FieldDragHandle, SortableFieldCard } from "@/lib/form-builder/dnd";

/**
 * P7-66 Phase 4a — one question on the canvas.
 *
 * COMPACT ON PURPOSE. It could have rendered the field's live preview, which
 * would look more like the form — but a canvas of full-height previews is a
 * canvas you cannot see six questions of at once, and reordering is the thing
 * this list exists for. The preview lives in the side panel, against the field
 * being edited, where it is looked at deliberately rather than continuously.
 *
 * THREE WAYS TO MOVE ONE FIELD, and they are not three rules:
 *   - the grip, dragged (`SortableFieldCard`);
 *   - the up/down buttons, which are the KEYBOARD path and are not going
 *     anywhere — WCAG 2.2 AA 2.1.1, and they are the tested one;
 *   - dnd-kit's keyboard sensor, off the same grip.
 * All three end in `planEntityReorder`. See `lib/form-builder/canvas.ts`.
 *
 * SELECTION IS NOT CARRIED BY COLOUR ALONE. The selected card takes an accent
 * fill AND a 3px brand rail down its leading edge AND `aria-current`, so it
 * survives greyscale and a screen reader both.
 */
export function FieldCard({
  field,
  index,
  count,
  selected,
  busy,
  pending,
  dragDisabled,
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
  dragDisabled: boolean;
  onSelect: () => void;
  onMove: (direction: "up" | "down") => void;
  onArchive: () => void;
}) {
  const { label, key, required } = field.entity.attributes;
  // Named to the user by its label; "this field" only until it has one.
  const name = label || "this field";

  return (
    <SortableFieldCard id={field.id} disabled={dragDisabled} className="list-none">
      <div
        className={cn(
          "relative flex items-center gap-1.5 overflow-hidden rounded-lg border bg-card p-2 grade-surface shadow-raised transition-colors",
          selected ? "border-primary bg-accent" : "hover:border-accent-border",
        )}
      >
        {/* The non-colour half of "this one is open in the panel". */}
        {selected ? (
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-primary" />
        ) : null}

        <FieldDragHandle label={`Drag to reorder ${name}`} />

        {/*
          ⚠️ `disabled` WHILE A SAVE IS IN FLIGHT, RESTORING THE GUARD THE OLD
          BUILDER HAD ON ITS Edit BUTTON.

          `onSelect` runs `resetBuilderStore(store, savedSchema)`, and mid-save
          `savedSchema` is still the PRE-save document. The save then advances
          it, leaving the store on the old order and `savedSchema` on the new
          one: the canvas shows a stale order, `dirty` sticks true with nothing
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
          className="min-w-0 flex-1 rounded-sm px-1 py-0.5 text-left disabled:cursor-default"
        >
          <span className="block truncate text-sm font-medium">
            {label || "Untitled field"}
            {required ? (
              <span className="ml-0.5 text-destructive" aria-label="required">
                *
              </span>
            ) : (
              <span className="ml-1.5 text-2xs font-normal text-muted-foreground">
                optional
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {FIELD_TYPE_LABELS[field.entity.type]}
            {key ? ` · ${key}` : null}
          </span>
        </button>

        {/*
          ⚠️ THE KEYBOARD PATH. Kept exactly as it was, backed by
          `planEntityReorder`, including its "nearest VISIBLE neighbour" rule
          that steps over an archived field. Drag is an enhancement over this,
          never a replacement for it.
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
          Archive, never delete. Historical requests store answers under this
          field's key, so removing the row would orphan them — and
          `vizserve_pms_form_field_protect` refuses the delete outright once one
          exists.
        */}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Archive ${name}`}
          disabled={busy}
          onClick={onArchive}
        >
          <Archive />
        </Button>
      </div>
    </SortableFieldCard>
  );
}
