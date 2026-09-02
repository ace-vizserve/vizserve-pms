"use client";

import {
  FIELD_TYPE_HINTS,
  FIELD_TYPE_LABELS,
  PALETTE_FIELD_TYPES,
} from "@/lib/form-builder/canvas";
import { PaletteDragButton } from "@/lib/form-builder/dnd";
import type { FieldType } from "@/lib/schemas/forms";

/**
 * P7-66 Phase 4a — the field types, as things you pick up.
 *
 * This replaces the old "Add field" button that expanded a `<Select>` of eight
 * enum values above the list. The types were always the first decision — the
 * type is FIXED once a field is saved, because the entity id is the
 * `vizserve_pms_form_fields` row id and changing a type is a delete and an
 * insert, which the R5 trigger refuses once the field has answers — so a palette
 * is the honest shape for it: choose what you are adding, then say where.
 *
 * ⚠️ EVERY ENTRY IS A REAL `<button>` AND PRESSING IT ADDS THE FIELD AT THE
 * END. Drag is the pointer affordance; the press is the whole feature without
 * one, and it is why this is not a div with a drag listener. WCAG 2.2 AA 2.1.1
 * is not satisfied by a drag gesture with no alternative — and 2.5.7 (Dragging
 * Movements) asks for exactly this: a single-pointer alternative to every drag.
 *
 * ⚠️ ENTER AND SPACE HAD TO BE TAKEN BACK OFF dnd-kit TO MAKE THAT TRUE. Both
 * were being swallowed by `KeyboardSensor`'s activator to start a keyboard drag
 * that could not move; the click never fired and the palette was unusable
 * without a mouse. `PaletteDragButton` now answers both itself — the reasoning
 * is written out there and the decision is `addsFieldOnKey` in `canvas.ts`.
 * Where the field lands afterwards is the card's own up/down buttons' job.
 */
export function FieldPalette({
  disabled,
  disabledReason,
  onAdd,
}: {
  disabled: boolean;
  /** Said out loud, because a disabled control that explains nothing is a dead end. */
  disabledReason: string | null;
  onAdd: (fieldType: FieldType) => void;
}) {
  return (
    <aside
      aria-label="Field types"
      className="rounded-lg border bg-card p-3 grade-surface shadow-raised-lg xl:sticky xl:top-18"
    >
      <h2 className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Field types
      </h2>
      <p className="mt-1 px-1 text-2xs text-muted-foreground">
        Drag one onto the form. Clicking it — or pressing Enter — adds it at
        the end.
      </p>

      <ul className="mt-3 space-y-1.5">
        {PALETTE_FIELD_TYPES.map((fieldType) => (
          <li key={fieldType}>
            <PaletteDragButton
              fieldType={fieldType}
              disabled={disabled}
              onClick={() => onAdd(fieldType)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {FIELD_TYPE_LABELS[fieldType]}
                </span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {FIELD_TYPE_HINTS[fieldType]}
                </span>
              </span>
            </PaletteDragButton>
          </li>
        ))}
      </ul>

      {disabledReason ? (
        <p className="mt-3 px-1 text-2xs text-muted-foreground">{disabledReason}</p>
      ) : null}
    </aside>
  );
}
