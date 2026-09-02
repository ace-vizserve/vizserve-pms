"use client";

import { Archive, Copy, Info, Lock, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FieldBodyAttributes,
  FieldHeadAttributes,
  type FormBuilderStore,
} from "@/lib/form-builder/components";
import { FIELD_TYPE_LABELS } from "@/lib/form-builder/canvas";
import { suggestFieldKey, type FieldType } from "@/lib/schemas/forms";

/**
 * P7-66 — ONE QUESTION'S EDITOR, UNDER THE LIST.
 *
 * ⚠️ THERE IS NO SAVE BUTTON AND NO CANCEL, AND THAT IS THE POINT OF THE PHASE.
 *
 * The builder autosaves. What that removed is not two buttons — it is the state
 * they created. A whole-document save meant an open, half-typed question BLOCKED
 * every other action on the screen: archiving question B could not go through
 * while question A held an invalid key, so the list went unavailable the moment
 * anybody typed, and moving between questions discarded whatever the last one
 * held. Every one of those rules was correct given the button, and none of them
 * is needed without it.
 *
 * What replaced them:
 *   - edits go to the store as they are typed, exactly as before;
 *   - `unsavableReason` decides, synchronously and with no side effects, whether
 *     the DOCUMENT can be written at all;
 *   - when it can, a debounce fires one whole-document save;
 *   - the top bar says which of those three states the form is in.
 *
 * So selecting another question is free, the list never locks, and nothing is
 * discarded — because there is no uncommitted state to discard.
 *
 * ⚠️ THE ANSWER TYPE LOCKS ONCE THE QUESTION HAS ANSWERS, AND IT IS A DELETE
 * PLUS AN ADD UNDERNEATH. `@coltorapps/builder` has no `setEntityType` — checked
 * in its `.d.ts` — so `replaceFieldType` deletes the entity and adds a new one at
 * the same index. That is also what it is in the database, since the entity id
 * IS the `vizserve_pms_form_fields` row id, and
 * `vizserve_pms_form_field_protect` refuses to drop a field with data behind it.
 * So the control is disabled exactly where Postgres would refuse it.
 *
 * ⚠️ DELETE BECOMES ARCHIVE ON AN ANSWERED QUESTION, rather than being hidden or
 * failing. An archived question comes off the form and keeps its answers, which
 * is the only thing that CAN happen to a question people have answered (R5) —
 * so the button says so and does that.
 */

export function QuestionEditor({
  builderStore,
  entityId,
  type,
  label,
  fieldKey,
  answered,
  offerableTypes,
  busy,
  problem,
  error,
  onChangeType,
  onDuplicate,
  onRemove,
}: {
  builderStore: FormBuilderStore;
  entityId: string;
  type: FieldType;
  /** The live label, for the derived-key line. Read from the store's schema. */
  label: string;
  /**
   * The key CURRENTLY on the entity.
   *
   * ⚠️ ON AN ANSWERED QUESTION THIS IS THE ONLY TRUTH. The key is immutable once
   * data is filed under it, so it can legitimately disagree with anything the
   * label would derive today — someone renames "Notes" to "Anything else?" and
   * the answers stay under `note` forever. Showing a derivation there would name
   * a column that does not exist.
   */
  fieldKey: string;
  /**
   * Whether this question's answers are already stored — the form's submission
   * count, narrowed to fields that are real rows. See `QuestionList`.
   */
  answered: boolean;
  offerableTypes: ReadonlyArray<FieldType>;
  busy: boolean;
  /** Why the form is not saving yet, when the reason is THIS question's. */
  problem: string | null;
  /** A refusal that came back from the database for this question. */
  error: string | null;
  onChangeType: (type: FieldType) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const typeSelectId = `question-type-${entityId}`;

  const typeItems = Object.fromEntries(
    offerableTypes.map((value) => [value, FIELD_TYPE_LABELS[value]]),
  );

  /*
   * ⚠️ THE TYPE THE QUESTION ACTUALLY IS, EVEN WHEN IT IS NOT OFFERED. A client
   * form carrying a File upload question can be switched to INTERNAL
   * while it has no submissions, and that question is still on the form. Leaving
   * it out of the map would render the raw enum on the trigger — the exact thing
   * `check:select-items` exists to fail — and leaving it out of the OPTIONS would
   * make the select show a blank while claiming to show the current value.
   */
  if (!Object.hasOwn(typeItems, type)) typeItems[type] = FIELD_TYPE_LABELS[type];

  const shownTypes = offerableTypes.includes(type) ? offerableTypes : [...offerableTypes, type];

  return (
    <section
      aria-label="Edit question"
      className="mt-4 overflow-hidden rounded-lg border bg-card grade-raised shadow-raised-lg"
    >
      <div className="space-y-3.5 p-4">
        {/* The question and its required switch, side by side. */}
        <FieldHeadAttributes builderStore={builderStore} entityId={entityId} />

        <div className="space-y-1.5">
          <Label htmlFor={typeSelectId}>Answer type</Label>
          <Select
            items={typeItems}
            value={type}
            disabled={answered || busy}
            onValueChange={(value) => {
              if (value !== null && value !== type) onChangeType(value as FieldType);
            }}
          >
            <SelectTrigger id={typeSelectId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {shownTypes.map((value) => (
                <SelectItem key={value} value={value}>
                  {FIELD_TYPE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/*
          ⚠️ THE CHOICES ARE HERE, INLINE, DIRECTLY UNDER THE TYPE THAT CREATES
          THEM — never behind a tab or a second panel. A "Choose one" with its
          options somewhere else is a control whose most important content is the
          part you cannot see while deciding on it.
        */}
        <FieldBodyAttributes builderStore={builderStore} entityId={entityId} />

        {/*
          THE STORAGE KEY, STATED RATHER THAN ASKED FOR.

          There is no input: `deriveFieldKeys` mints it from the question and
          de-duplicates it against every key on the form, archived ones included.
          It is still worth SAYING, because it is what answers are filed under
          and it is what an export column is headed with — and because once it is
          fixed, this sentence is the only place the fact appears.
        */}
        <p className="flex items-start gap-1.5 pt-0.5 text-xs text-muted-foreground">
          {answered ? (
            <>
              <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>
                Type is fixed — answers are filed under “{fieldKey}”.
              </span>
            </>
          ) : (
            <span>
              Answers will be filed under “{keyPreview(label, fieldKey)}”, generated from the
              question.
            </span>
          )}
        </p>

        {/*
          ⚠️ WHY THE FORM IS NOT SAVING, WHERE THE PERSON IS LOOKING. With a Save
          button, this was the response to pressing it. Without one, an
          incomplete question means the top bar quietly reads "Unsaved changes"
          and nothing says why — so the reason belongs on the question it is
          about, and it is phrased as what to do rather than what is wrong.

          `role="status"`, not `alert`: it appears while somebody is typing and
          an assertive region would interrupt them mid-word.
        */}
        {problem ? (
          <p
            role="status"
            className="flex items-start gap-1.5 text-xs leading-relaxed text-warning"
          >
            <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
            {problem}
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-1 border-t px-3 py-2">
        <span className="flex-1" />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy}
          title="Duplicate"
          aria-label="Duplicate this question"
          onClick={onDuplicate}
        >
          <Copy />
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy}
          title={
            answered
              ? "Archive — it has answers, so it cannot be deleted"
              : "Delete this question"
          }
          aria-label={answered ? "Archive this question" : "Delete this question"}
          onClick={onRemove}
        >
          {/* Two different actions, so two different icons. A bin on a control
              that archives is a promise the database will not keep. */}
          {answered ? <Archive /> : <Trash2 />}
        </Button>
      </div>
    </section>
  );
}

/**
 * What an UNANSWERED question's key will be, as far as this line can know it.
 *
 * ⚠️ A PREVIEW, AND ON A BRAND-NEW QUESTION IT CAN STILL MOVE.
 * `deriveFieldKeys` de-duplicates at save time against every key on the form,
 * archived ones included — so a second question called "Notes" is actually filed
 * under `note_2` while this line says `note`. Running the whole derivation on
 * every keystroke, to show a suffix nobody acts on, is not worth the accuracy.
 *
 * ⚠️ THE KEY ALREADY ON THE ENTITY WINS WHENEVER THERE IS ONE. After the first
 * save that entity carries its real, de-duplicated key — including the `_2` this
 * function would not have predicted — and once it does, that is what the line
 * must say.
 *
 * A blank label derives nothing, rather than guessing: `suggestFieldKey("")`
 * returns the literal `field`, and naming a key the save will never mint is
 * worse than an ellipsis.
 */
function keyPreview(label: string, fieldKey: string): string {
  if (fieldKey !== "") return fieldKey;
  return label.trim() === "" ? "…" : suggestFieldKey(label);
}
