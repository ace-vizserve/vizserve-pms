"use client";

import { Archive } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/status-badge";
import { FIELD_TYPE_LABELS, type CanvasField } from "@/lib/form-builder/canvas";
import {
  FieldAttributesEditor,
  FieldPreview,
  type FormBuilderStore,
} from "@/lib/form-builder/components";

/**
 * P7-66 — ONE QUESTION, ON THE FORM ITSELF.
 *
 * ⚠️ THE CANVAS SHOWS THE FORM, NOT A DESCRIPTION OF IT. This is the whole
 * point of the rework. The previous canvas rendered summary cards — a label, the
 * type, "Required" — which meant the middle of the builder was a table of
 * contents and the only way to see the form was to publish it. Now every
 * question draws the REAL control, and the person building it is looking at what
 * the person filling it in will see, continuously, while they type.
 *
 * ⚠️ AND THAT COSTS NOTHING TO BUILD, WHICH IS WHY IT IS AFFORDABLE.
 * `mode: "builder"` in `lib/form-builder/components.tsx` already renders every
 * control disabled — it was written for the old side-panel preview — so the
 * canvas and the live form are literally one component map. A preview that
 * cannot drift from the form, because it is the form.
 *
 * ⚠️ THE CLICK TARGET IS AN OVERLAY, AND THAT IS COLTORAPPS' OWN TREATMENT
 * (docs/src/builders/basic-form-builder/builder/component.tsx). The rendered
 * field sits in a `pointer-events-none` wrapper and an absolutely-positioned
 * `<button>` covers it, so clicking anywhere on the question selects it rather
 * than landing in a text input that is disabled anyway. Two things were added to
 * that reference, and both are accessibility rather than taste:
 *
 *   - THE OVERLAY HAS A NAME. The reference's button is empty, which is a
 *     control a screen reader announces as "button" and nothing else. This one
 *     says which question it edits.
 *   - THE OVERLAY IS A SIBLING, NEVER A PARENT. Nesting the rendered field
 *     inside the button would be interactive content inside interactive
 *     content — invalid HTML, and unpredictable for assistive technology.
 *
 * The disabled controls beneath are not in the tab order, so the overlay is the
 * single stop per question and Tab walks the form one question at a time.
 *
 * ⚠️ SELECTED MEANS EDITING, IN PLACE. Google Forms' shape and Ace's
 * instruction both: the question that is open swaps its rendered control for its
 * attribute editors, in the position it occupies on the form, with the rest of
 * the form still live above and below it. The alternative — a third column —
 * puts the editor a screen away from the field it edits and leaves the form the
 * narrowest thing on the page.
 */
export function QuestionCard({
  builderStore,
  field,
  index,
  selected,
  isNew,
  pending,
  dirty,
  error,
  busy,
  onSelect,
  onArchive,
  onSave,
  onCancel,
}: {
  builderStore: FormBuilderStore;
  field: CanvasField;
  /** Position among the fields the user can SEE, not in `root`. */
  index: number;
  selected: boolean;
  /** No row behind it yet, so its key is still open and Cancel discards it. */
  isNew: boolean;
  pending: boolean;
  dirty: boolean;
  error: string | null;
  /** A save is in flight, or the form holds unsaved edits. */
  busy: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { label } = field.entity.attributes;
  const name = label || "this question";

  if (selected) {
    return (
      <li
        className="list-none rounded-lg border border-primary bg-card p-4 grade-surface shadow-raised-lg"
        aria-current="true"
      >
        <div className="flex items-center gap-2 border-b pb-3">
          <span className="text-2xs tabular-nums text-foreground-faint">{index + 1}</span>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Editing
          </h3>
          <Chip tone="brand" label={FIELD_TYPE_LABELS[field.entity.type]} className="ml-auto" />
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

        {/*
          ⚠️ THE LIVE ONE, ABOVE THE EDITORS. Typing a label changes the question
          as you watch, which is the "the preview is live while editing" half of
          the instruction — the rest of the form, above and below this card,
          being the other half. Same component map as the real form, disabled.
        */}
        <div className="border-b py-4">
          <FieldPreview builderStore={builderStore} entityId={field.id} />
        </div>

        {/* Keyed on the entity id so switching questions REMOUNTS the editors.
            The options editor holds the raw text somebody is typing in its own
            state (see `normaliseOptionsText`); carrying that state across a
            change of field would show one question's option list under
            another's label. */}
        <div className="pt-4">
          <FieldAttributesEditor
            key={field.id}
            builderStore={builderStore}
            entityId={field.id}
          />
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" onClick={onSave} loading={pending}>
            {isNew ? "Add question" : "Save question"}
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

        <p className="mt-2 text-2xs text-muted-foreground">
          {dirty
            ? "Reordering, archiving and adding are unavailable until this question is saved or cancelled — a save writes the whole form at once."
            : "The type is fixed once the question is saved. To change it later, archive this one and add another — existing answers stay with the archived question."}
        </p>
      </li>
    );
  }

  return (
    <li className="relative list-none rounded-lg p-4">
      {/*
        The rendered field. `pointer-events-none` so the overlay below takes
        every click, and `onFocusCapture` stopped as well — the controls are
        disabled and therefore unfocusable today, but a future field type that
        renders something focusable would otherwise put a second tab stop inside
        a question the person has not opened.
      */}
      <div
        className="pointer-events-none"
        tabIndex={-1}
        onFocusCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <FieldPreview builderStore={builderStore} entityId={field.id} />
      </div>

      <button
        type="button"
        onClick={onSelect}
        disabled={pending}
        aria-label={`Edit ${name}`}
        className={cn(
          "absolute inset-0 rounded-lg border transition-colors",
          "border-transparent hover:border-accent-border hover:bg-accent/40",
          "disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent",
        )}
      />
    </li>
  );
}
