"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FIELD_TYPE_HINTS, FIELD_TYPE_LABELS } from "@/lib/form-builder/canvas";
import type { FieldType } from "@/lib/schemas/forms";

/**
 * P7-66 — ADD QUESTION, as a dialog of types.
 *
 * ⚠️ THIS REPLACES THE PALETTE RAIL, and the reference it is copied from is
 * coltorapps' own basic-form-builder: one "Add Element" button opening a modal
 * that lists the types. The palette was the second layout Ace rejected, and it
 * was wrong for a reason worth stating rather than just deleting: a palette
 * implies you will reach for it repeatedly, like a toolbar. You do not. A form
 * gets eight questions in its life and each one's type is chosen ONCE and then
 * FIXED — the entity id is the `vizserve_pms_form_fields` row id, so changing a
 * type is a delete and an insert, which the R5 trigger refuses the moment the
 * field has an answer. A permanent rail for a rare, irreversible decision is
 * the wrong weight, and it cost a whole column of the screen that the live form
 * now has.
 *
 * ⚠️ NO DRAG, AND THEREFORE NOTHING TO MAKE ACCESSIBLE. The palette entries
 * were draggable, which is what swallowed Enter and Space (dnd-kit's keyboard
 * activator claimed both, for a drag that could never move) and needed
 * `addsFieldOnKey` to take them back. These are ordinary `<Button>`s in an
 * ordinary dialog: Tab reaches them, Enter and Space press them, Escape closes.
 * The whole class of bug is gone rather than worked around.
 *
 * WHERE THE QUESTION LANDS is the caller's decision, not this component's — see
 * `rootIndexForSlot`: directly below the question being edited, or at the end
 * when nothing is selected.
 */
export function AddQuestionDialog({
  fieldTypes,
  disabled,
  /** Said out loud, because a disabled control that explains nothing is a dead end. */
  disabledReason,
  onAdd,
}: {
  /**
   * ⚠️ PASSED IN RATHER THAN READ FROM `ADDABLE_FIELD_TYPES`, because the list
   * is not the same on both kinds of form — see `offerableFieldTypes` in
   * `field-builder.tsx`. A dialog that decided this itself would need to know
   * what the form is for, which is the caller's business.
   */
  fieldTypes: ReadonlyArray<FieldType>;
  disabled: boolean;
  disabledReason: string | null;
  onAdd: (fieldType: FieldType) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button variant="outline" className="w-full" disabled={disabled} />
          }
        >
          <Plus />
          Add question
        </DialogTrigger>

        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New question</DialogTitle>
            <DialogDescription>
              Choose what kind of answer you are asking for. This cannot be changed once the
              question is saved.
            </DialogDescription>
          </DialogHeader>

          <ul className="grid gap-1.5">
            {fieldTypes.map((fieldType) => (
              <li key={fieldType}>
                <Button
                  variant="outline"
                  className="h-auto w-full justify-start px-3 py-2 text-left"
                  onClick={() => {
                    setOpen(false);
                    onAdd(fieldType);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {FIELD_TYPE_LABELS[fieldType]}
                    </span>
                    <span className="block truncate text-2xs font-normal text-muted-foreground">
                      {FIELD_TYPE_HINTS[fieldType]}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      {disabledReason ? (
        <p className="text-center text-2xs text-balance text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}
