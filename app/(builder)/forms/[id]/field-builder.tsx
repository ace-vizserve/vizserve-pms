"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { FormSchema } from "@/lib/form-builder/builder";
import {
  ADDABLE_FIELD_TYPES,
  planEntityDrop,
  rootIndexForSlot,
  sameFormSchema,
  splitCanvasFields,
} from "@/lib/form-builder/canvas";
import {
  addFieldEntity,
  FieldRuntimeProvider,
  resetBuilderStore,
  useFormBuilderSchema,
  useFormBuilderStore,
  validateBuilderSchema,
} from "@/lib/form-builder/components";
import { FieldDndProvider, type FieldDrag } from "@/lib/form-builder/dnd";
import { planEntityReorder } from "@/lib/form-builder/schema";
import { planSchemaSave, type SchemaSaveAttempt } from "@/lib/form-builder/save-outcome";
import { suggestFieldKey, type FieldType, type FormPurpose } from "@/lib/schemas/forms";
import { saveSchema } from "@/app/(app)/forms/actions";
import { AddQuestionDialog } from "./add-question-dialog";
import { FieldList } from "./field-list";
import { QuestionCard } from "./question-card";

/**
 * P7-66 — the form builder, on `@coltorapps/builder`'s store.
 *
 * ⚠️ THE LAYOUT IS GOOGLE FORMS, AND IT IS THE THIRD ONE. Recording why, since
 * the first two were built and rejected:
 *
 *   1. an "add field" form that expanded above the list, and an editor that
 *      expanded inside a row;
 *   2. Elementor — a palette of eight type cards on the left, SUMMARY cards in
 *      the middle ("Long text · Required"), an attributes panel on the right.
 *
 * Both failed the same way: the middle of the screen, which is the whole screen,
 * showed a DESCRIPTION of the form instead of the form. What was asked for is
 * this:
 *
 *   QUESTIONS   │  the live form
 *   ⠿ 1 Company │  Company name *
 *   ⠿ 2 Budget  │  [ real input, disabled          ]
 *   ⠿ 3 Notes   │  ╔ Editing ─────────── Number ══╗
 *               │  ║ [ real input, disabled     ] ║
 *   Archived(1) │  ║ Label / Key / Help / Required║
 *               │  ╚══════════════════════════════╝
 *               │  Notes
 *               │  [ real textarea, disabled       ]
 *               │        ⊕ Add question
 *
 * Left rail sorts. Main column IS the form, drawn with the same components the
 * client's browser draws, and the question being edited swaps its control for
 * its attribute editors IN PLACE — so the preview stays live while editing,
 * which was the instruction. There is no third column and no palette: the type
 * is chosen once, in a dialog, because it is fixed after the first save.
 *
 * The mechanics of the card treatment are coltorapps' own reference builder's
 * (`docs/src/builders/basic-form-builder`): a real field in a
 * `pointer-events-none` wrapper under a `<button>` overlay. See
 * `question-card.tsx`.
 *
 * ⚠️ EVERYTHING HARD-WON IN THE EARLIER PHASES SURVIVES IT UNCHANGED.
 * `planSchemaSave` still decides what a refusal does to the store, the options
 * editor still keeps its raw draft separate from the normalised store, the field
 * type is still fixed once saved, and keys still lock once a form has
 * submissions.
 *
 * ⚠️ THE UP/DOWN BUTTONS ARE NOT GOING ANYWHERE. Drag is a POINTER-ONLY
 * ENHANCEMENT over a working keyboard path (WCAG 2.2 AA 2.1.1, and 2.5.7 on
 * dragging movements). Every route to a new order goes through
 * `planEntityReorder`; `arrayMove` is never called. See
 * `lib/form-builder/canvas.ts`.
 *
 * ⚠️ A SAVE WRITES THE WHOLE DOCUMENT. That is why the list actions go
 * unavailable while a question is half-typed — archiving question B cannot go
 * through while question A holds an invalid key, because the save carries both.
 * The question asked is whether the document has actually CHANGED
 * (`sameFormSchema`), so selecting is free and only typing locks anything.
 */
export function FieldBuilder({
  formId,
  purpose,
  initialSchema,
}: {
  formId: string;
  /**
   * ⚠️ WHAT THE FORM IS FOR DECIDES WHICH QUESTIONS CAN BE ASKED, and today
   * that is one type. See `offerableFieldTypes` below.
   */
  purpose: FormPurpose;
  /**
   * ⚠️ RECONCILED AGAINST THE ROWS BY THE LOADER, never the stored blob as
   * read. See `reconcileFormSchema` — a blob that Phase 1's dual-write failed to
   * write is exactly the one that would otherwise be projected back over the
   * rows and delete whatever it omits.
   */
  initialSchema: FormSchema;
}) {
  const router = useRouter();

  const builderStore = useFormBuilderStore(initialSchema);
  const schema = useFormBuilderSchema(builderStore);

  /**
   * The last document the database accepted.
   *
   * Cancel and a rejected mechanical change both put the store back on this, so
   * "what the builder shows" can only ever be the saved form plus the one edit
   * in progress.
   */
  const [savedSchema, setSavedSchema] = useState<FormSchema>(initialSchema);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Still stopping one impatient double-click from sending two saves. It is no
   * longer a guard rail over a race — `vizserve_pms_save_form_schema` is one
   * function call and therefore one transaction — so two overlapping saves can
   * no longer leave the rows and the blob disagreeing. The later one simply
   * wins.
   */
  const [pending, startTransition] = useTransition();

  /**
   * A field whose `key` is already a row, and therefore immutable (D20/R5).
   *
   * Derived from the SAVED schema rather than the live one, so a question added
   * a moment ago and not yet saved still has an editable key — there is no
   * stored answer to orphan yet. Postgres enforces the real rule either way.
   */
  const lockedEntityIds = useMemo(() => new Set(savedSchema.root), [savedSchema]);

  const runtime = useMemo(
    () => ({ mode: "builder" as const, lockedEntityIds }),
    [lockedEntityIds],
  );

  const { active, archived } = splitCanvasFields(schema);

  /**
   * ⚠️ THE ONE REASON THE LIST GOES UNAVAILABLE, and it is a question about the
   * DOCUMENT, not about the UI.
   *
   * A save writes the whole form. A mechanical change — archive, restore,
   * reorder, drop — therefore cannot go through while the store holds edits
   * nobody has committed: the save carries both, and it either commits the
   * half-typed question or is refused because of it. Neither is what the person
   * clicking Archive asked for.
   */
  const dirty = !sameFormSchema(schema, savedSchema);
  const listBusy = pending || dirty;

  /**
   * Validate, then save.
   *
   * The two refusals it can return are named separately only so a reader can see
   * that there are two of them; `planSchemaSave` treats them alike, because the
   * builder is left in the same state either way.
   */
  async function attemptSave(): Promise<SchemaSaveAttempt> {
    const validated = await validateBuilderSchema(builderStore);

    if (!validated.ok) return { outcome: "invalid", message: validated.message };

    const result = await saveSchema(formId, validated.schema);

    if (!result.ok) return { outcome: "refused", message: result.error };

    return { outcome: "saved", schema: validated.schema };
  }

  /**
   * Validate, save, and remember what was saved.
   *
   * `revertOnFailure` splits the two kinds of caller. A mechanical change —
   * archive, restore, reorder, drop — has nothing typed behind it, so a refusal
   * should leave the builder showing what the database actually holds. A
   * question editor does have something typed behind it, and throwing it away
   * because Postgres refused a `field_key` rename would delete the very work the
   * person now has to correct.
   */
  async function persist(message: string, revertOnFailure: boolean): Promise<boolean> {
    /*
     * ⚠️ BOTH REFUSALS ARE ONE OUTCOME. `validateBuilderSchema` refusing the
     * document and Postgres refusing it leave the builder in the same state —
     * showing a form the database does not hold — so `planSchemaSave` decides
     * what happens next for both, and `revertOnFailure` is honoured either way.
     */
    const effect = planSchemaSave(await attemptSave(), revertOnFailure);

    if (effect.kind === "failed") {
      setError(effect.message);
      if (effect.revert) {
        resetBuilderStore(builderStore, savedSchema);
        toast.error(effect.message);
      }
      return false;
    }

    setSavedSchema(effect.schema);
    setError(null);
    toast.success(message);
    // The rest of the page — the submission count, the "field keys are locked"
    // line — is server-rendered from the rows this save just rewrote.
    router.refresh();
    return true;
  }

  /**
   * Opens one question, discarding whatever the last one held.
   *
   * Stated rather than hidden: switching questions loses unsaved changes to the
   * one you were in. That is the price of a save that writes the whole document,
   * and the alternative — carrying an unfinished question into the next save —
   * is a save that fails for a reason the person is not looking at. It is also
   * why the list is unavailable while `dirty`: the only way to reach another
   * question's controls in that state is Save or Cancel.
   */
  function select(entityId: string | null) {
    resetBuilderStore(builderStore, savedSchema);
    setSelectedId(entityId);
    setError(null);
  }

  /** Applies an ordered list of `setEntityIndex` calls, then saves the form. */
  function applyMoves(moves: ReturnType<typeof planEntityReorder>) {
    if (moves.length === 0) return;

    // Applied front to back: `setEntityIndex` removes then re-inserts, so the
    // order of these calls is the order that makes them a move rather than
    // several independent ones. See `planEntityReorder`.
    for (const step of moves) builderStore.setEntityIndex(step.entityId, step.index);

    startTransition(async () => {
      await persist("Order saved", true);
    });
  }

  function move(entityId: string, direction: "up" | "down") {
    applyMoves(planEntityReorder(schema, entityId, direction));
  }

  function setArchived(entityId: string, isArchived: boolean) {
    builderStore.setEntityAttribute(entityId, "archived", isArchived);
    if (isArchived && selectedId === entityId) setSelectedId(null);

    startTransition(async () => {
      await persist(isArchived ? "Question archived" : "Question restored", true);
    });
  }

  /**
   * Adds a question of `type` BELOW the one being edited, and opens it.
   *
   * ⚠️ BELOW THE SELECTED ONE, NOT AT THE END. A form is written by working
   * down it; appending and then pressing the up arrow six times is not building
   * a form, it is fighting one. Nothing selected means the end, which is where
   * somebody adding their first questions is anyway.
   *
   * NOT SAVED IMMEDIATELY, and it cannot be: `keyAttribute` and `labelAttribute`
   * both refuse the empty strings a new entity carries, which is exactly the
   * "fill this in before it is a question" the editor then asks for.
   */
  function addField(type: FieldType) {
    const slot =
      selectedId === null ? active.length : active.findIndex((f) => f.id === selectedId) + 1;

    resetBuilderStore(builderStore, savedSchema);
    setSelectedId(addFieldEntity(builderStore, type, rootIndexForSlot(schema, slot)));
    setError(null);
  }

  /**
   * A drop, resolved.
   *
   * ⚠️ EVERY DECISION HERE IS `lib/form-builder/canvas.ts`'s, which is pure and
   * tested. What this function contributes is only the translation of dnd-kit's
   * `over.id` into a position among the questions the user can SEE — a `root`
   * index would be wrong the moment a field is archived.
   */
  function handleDrop(drag: FieldDrag, overId: string) {
    // Belt and braces: the sortable context is disabled while `listBusy`, so a
    // drop should not be able to arrive. If one did, it would be a whole-form
    // save carrying a half-typed question.
    if (listBusy) return;

    const to = active.findIndex((field) => field.id === overId);
    if (to < 0) return;

    applyMoves(planEntityDrop(schema, drag.entityId, to));
  }

  function saveSelectedField() {
    const entityId = selectedId;
    if (entityId === null) return;

    const isNew = !lockedEntityIds.has(entityId);
    const entity = Object.hasOwn(schema.entities, entityId)
      ? schema.entities[entityId]
      : undefined;

    /*
     * ⚠️ A BLANK KEY IS DERIVED FROM THE LABEL, which is what the old builder
     * did as you typed. Nobody should have to invent a storage identifier to
     * ask a question, and `keyAttribute` refuses an empty one — so without this
     * the first save of every question would be a refusal over a box the person
     * had no reason to fill in.
     *
     * ⚠️ ONLY ON A NEW FIELD, AND ONLY WHEN IT IS BLANK. The key is what every
     * historical answer is filed under (§1); re-deriving an existing one from a
     * retyped label would orphan them, and Postgres refuses the rename anyway.
     */
    if (isNew && entity !== undefined && entity.attributes.key === "") {
      builderStore.setEntityAttribute(
        entityId,
        "key",
        suggestFieldKey(entity.attributes.label),
      );
    }

    startTransition(async () => {
      await persist(isNew ? "Question added" : "Question saved", false);
    });
  }

  /**
   * ⚠️ NO FILE QUESTION ON A STAFF FORM, BECAUSE THERE IS NOWHERE TO PUT THE
   * FILE.
   *
   * The attachment machinery is request-shaped end to end:
   * `uploadPublicAttachment` writes `vizserve_pms_pending_attachments` scoped to
   * a form, and those rows are CLAIMED by `vizserve_pms_submit_request` when it
   * mints a request. An engagement form mints no request, so `/respond` refuses
   * every upload — and a REQUIRED file question there is a form that cannot be
   * submitted by any sequence of actions, because `fileEntity` demands at least
   * one reference that can never exist.
   *
   * `/respond` now refuses to render such a form at all rather than letting
   * somebody fill it in for nothing. This is the other half: not offering the
   * type is what stops one being built in the first place, which is the half
   * that does not need anybody to notice.
   *
   * ⚠️ IT DOES NOT HIDE A FILE QUESTION THAT ALREADY EXISTS. A client form
   * with an attachment question can be flipped to EMPLOYEE_ENGAGEMENT while it
   * has no submissions, and that question is still on the form, still in the
   * left rail, still editable — including archiving it, which is the fix. A
   * builder that silently stopped showing a question the form actually asks
   * would be a worse problem than the one it solved.
   */
  const offerableFieldTypes = useMemo(
    () =>
      purpose === "EMPLOYEE_ENGAGEMENT"
        ? ADDABLE_FIELD_TYPES.filter((fieldType) => fieldType !== "file")
        : ADDABLE_FIELD_TYPES,
    [purpose],
  );

  const addReason = dirty
    ? "Save or cancel the question you are editing before adding another — a save writes the whole form at once."
    : null;

  /*
   * ⚠️ NO RAIL ON AN EMPTY FORM, which is the reference builder's rule
   * (`grid` only when `root.length`) and is not decoration. A sort list with
   * nothing to sort, pinned beside a form with nothing on it, is two empty
   * boxes explaining themselves; one centred column with one button is the
   * screen actually asking for the first question.
   */
  const hasQuestions = active.length > 0 || archived.length > 0;

  const canvas = (
    <div className="mx-auto w-full max-w-2xl space-y-3">
      <ul className="space-y-1">
        {active.map((field, index) => (
          <QuestionCard
            key={field.id}
            builderStore={builderStore}
            field={field}
            index={index}
            selected={selectedId === field.id}
            isNew={!lockedEntityIds.has(field.id)}
            pending={pending}
            dirty={dirty}
            error={selectedId === field.id ? error : null}
            busy={listBusy}
            onSelect={() => select(field.id)}
            onArchive={() => setArchived(field.id, true)}
            onSave={saveSelectedField}
            onCancel={() => select(null)}
          />
        ))}
      </ul>

      {active.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No questions yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-balance text-muted-foreground">
            Name, email, title, description and target date are collected on every client form
            automatically. Add a question for whatever else this form needs to ask.
          </p>
        </div>
      ) : null}

      <AddQuestionDialog
        fieldTypes={offerableFieldTypes}
        disabled={listBusy}
        disabledReason={addReason}
        onAdd={addField}
      />

      {/* A refusal that arrived from a list action, where there is no question
          open to carry it. */}
      {error && selectedId === null ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );

  return (
    <FieldRuntimeProvider runtime={runtime}>
      <FieldDndProvider
        itemIds={active.map((field) => field.id)}
        disabled={listBusy}
        onDrop={handleDrop}
        renderOverlay={(drag) => (
          <div className="pointer-events-none max-w-64 truncate rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium shadow-overlay">
            {schema.entities[drag.entityId]?.attributes.label || "Untitled question"}
          </div>
        )}
      >
        {hasQuestions ? (
          <div className="grid items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <FieldList
              active={active}
              archived={archived}
              selectedId={selectedId}
              busy={listBusy}
              pending={pending}
              onSelect={select}
              onMove={move}
              onArchive={(entityId) => setArchived(entityId, true)}
              onRestore={(entityId) => setArchived(entityId, false)}
            />
            {canvas}
          </div>
        ) : (
          canvas
        )}
      </FieldDndProvider>
    </FieldRuntimeProvider>
  );
}
