"use client";

import { Button } from "@/components/ui/button";
import { Chip } from "@/components/status-badge";
import { FIELD_TYPE_LABELS, type CanvasField } from "@/lib/form-builder/canvas";
import {
  FieldAttributesEditor,
  FieldPreview,
  type FormBuilderStore,
} from "@/lib/form-builder/components";

/**
 * P7-66 Phase 4a — EDIT FIELD, in a panel rather than inside the list.
 *
 * ⚠️ WHAT THIS REPLACED, AND WHAT IT DID NOT FIX.
 *
 * The old builder expanded the editor INSIDE the row and disabled every list
 * action while it was open — reorder, archive, restore and add all went grey the
 * moment somebody clicked Edit. The reason was never "two editors would be
 * confusing": it is that a save writes the WHOLE form, so archiving field B
 * cannot go through while field A holds a half-typed key. The save carries both.
 *
 * A panel is inherently one-at-a-time, so the *editor* half of that is gone. The
 * *invariant* is not, because it was never about the editor. It is now asked as
 * the real question — has anything actually CHANGED? (`sameFormSchema`) —
 * instead of the proxy question the old builder asked, which froze the list for
 * anyone who merely opened a field to look at it. Selecting is free; typing is
 * what locks the list, and only until it is saved or cancelled.
 *
 * THE TYPE IS NOT EDITABLE HERE, and that is storage, not simplification. The
 * entity id IS the `vizserve_pms_form_fields` row id, so changing a type is a
 * delete and an insert, which `vizserve_pms_form_field_protect` refuses once the
 * field has answers. It is chosen from the palette, which is why the palette is
 * a palette.
 */
export function FieldPanel({
  builderStore,
  field,
  isNew,
  pending,
  dirty,
  error,
  onSave,
  onCancel,
}: {
  builderStore: FormBuilderStore;
  /** `null` when nothing on the canvas is selected. */
  field: CanvasField | null;
  /** No row behind it yet, so its key is still open and Cancel discards it. */
  isNew: boolean;
  pending: boolean;
  dirty: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <aside
      aria-label="Edit field"
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 grade-surface shadow-raised-lg xl:sticky xl:top-18 xl:max-h-[calc(100svh-5.5rem)] xl:overflow-y-auto"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Edit field
        </h2>
        {field ? (
          <Chip
            tone="brand"
            label={FIELD_TYPE_LABELS[field.entity.type]}
            className="ml-auto"
          />
        ) : null}
      </div>

      {field === null ? (
        <p className="text-xs text-balance text-muted-foreground">
          Nothing selected. Click a question on the form to edit it, or drag a field type in
          from the left.
        </p>
      ) : (
        <>
          {/* Keyed on the entity id so switching fields REMOUNTS the editors.
              The options editor holds the raw text somebody is typing in its own
              state (see `normaliseOptionsText`); carrying that state across a
              change of field would show one field's option list under another
              field's label. */}
          <FieldAttributesEditor key={field.id} builderStore={builderStore} entityId={field.id} />

          {error ? (
            <p
              role="alert"
              className="rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button size="sm" onClick={onSave} loading={pending}>
              {isNew ? "Add field" : "Save field"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={pending}
              onClick={onCancel}
            >
              {isNew ? "Discard" : "Cancel"}
            </Button>
          </div>

          <p className="text-2xs text-muted-foreground">
            {dirty
              ? "Reordering, archiving and adding are unavailable until this field is saved or cancelled — a save writes the whole form at once."
              : "The type is fixed once the field is saved. To change it later, archive the field and add a new one — existing answers stay with the archived field."}
          </p>

          {/* The same components the client's browser renders, disabled. One
              map, so the preview cannot drift from the form. */}
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              How the client sees it
            </p>
            <FieldPreview builderStore={builderStore} entityId={field.id} />
          </div>
        </>
      )}
    </aside>
  );
}
