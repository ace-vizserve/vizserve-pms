"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2 } from "lucide-react";
import { toast } from "sonner";

import type { FormSchema } from "@/lib/form-builder/builder";
import {
  ADDABLE_FIELD_TYPES,
  deriveFieldKeys,
  planEntityDrop,
  rootIndexForSlot,
  sameFormSchema,
  splitCanvasFields,
  unsavableReason,
} from "@/lib/form-builder/canvas";
import {
  addFieldEntity,
  cloneFieldEntity,
  FieldRuntimeProvider,
  replaceFieldType,
  resetBuilderStore,
  useFormBuilderSchema,
  useFormBuilderStore,
  validateBuilderSchema,
} from "@/lib/form-builder/components";
import { FieldDndProvider, type FieldDrag } from "@/lib/form-builder/dnd";
import { planEntityReorder } from "@/lib/form-builder/schema";
import { planSchemaSave, type SchemaSaveAttempt } from "@/lib/form-builder/save-outcome";
import type { FieldType, FormPurpose } from "@/lib/schemas/forms";
import { saveSchema } from "@/app/(app)/forms/actions";

import { QuestionEditor } from "./question-editor";
import { QuestionList } from "./question-list";
import { QuestionTypes } from "./question-types";
import { RespondentPreview } from "./respondent-preview";
import { useSaveStatus } from "./save-status";

/**
 * P7-66 — THE BUILDER, IN THREE PANES, SAVING ITSELF.
 *
 * ⚠️ THE LAYOUT IS THE FOURTH, AND THE THREE BEFORE IT WERE REJECTED FOR ONE
 * REASON. Recording them so they are not proposed again:
 *
 *   1. an "add field" form that expanded above the list, with the editor
 *      expanding inside a row;
 *   2. Elementor — a palette of eight type cards on the left, SUMMARY cards in
 *      the middle ("Long text · Required"), an attributes panel on the right;
 *   3. a two-column Google-Forms canvas with the questions as cards.
 *
 * Every time, the complaint was the same: THE MIDDLE OF THE SCREEN SHOWED A
 * DESCRIPTION OF THE FORM RATHER THAN THE FORM.
 *
 * This one gives each of the three jobs its own column and stops any of them
 * pretending to be another:
 *
 *   TYPES      │  QUESTIONS + EDITOR      │  THE FORM
 *   Short text │  ⠿ 1. Which pages? *     │  ┌────────────────────┐
 *   Long text  │  ⠿ 2. What should it say │  │ Website Change Req │
 *   Choose one │  ⠿ 3. Campaign date?     │  ├────────────────────┤
 *   …          │  ╔ Editing ════════════╗ │  │ 1. Which pages? *  │
 *              │  ║ Question / Required ║ │  │  ○ Home            │
 *              │  ║ Answer type         ║ │  │  ○ Pricing         │
 *              │  ║ Choices             ║ │  │ 2. What should it… │
 *              │  ╚═════════════════════╝ │  │ [ real textarea  ] │
 *
 * The right-hand pane is drawn with the components the respondent's browser
 * draws, so it is the form rather than a fourth description of it.
 *
 * ⚠️ AUTOSAVE, AND WHAT IT DELETED. There is no Save, no Cancel, and no
 * dirty-locked list. Those existed because a save writes the WHOLE document: a
 * half-typed question could not be carried into a save of anything else, so the
 * list froze the moment anybody typed and switching questions discarded what the
 * last one held. `unsavableReason` replaces all of it — the document is either
 * writable, in which case a debounce writes it, or it is not, in which case the
 * one question responsible says why. Nothing is ever discarded, because nothing
 * is ever uncommitted for longer than the debounce.
 *
 * ⚠️ WHAT SURVIVED FROM THE EARLIER PHASES, UNCHANGED. `planSchemaSave` still
 * decides what a refusal does to the store. Every ordering path still goes
 * through `planEntityReorder`, and `arrayMove` is still never called — the
 * up/down buttons are the keyboard path (WCAG 2.2 AA 2.1.1) and drag is a
 * pointer enhancement over them. `lockedEntityIds` still comes from the SAVED
 * document. `@coltorapps` and `@dnd-kit` are still confined to
 * `lib/form-builder/`.
 */

/**
 * How long a pause counts as "finished for now".
 *
 * ⚠️ IT IS A WHOLE-DOCUMENT SAVE AND A `router.refresh()`, so this cannot be
 * short. Too eager and every third keystroke re-renders the page under the
 * person typing; too slow and closing the tab loses work. 900ms is about a
 * word's pause, which is where a form-writer's attention actually breaks.
 */
const AUTOSAVE_DEBOUNCE_MS = 900;

/** What a rejected save does beyond the indicator: nothing the person can use. */
function reportSaveThrow(cause: unknown): void {
  console.error("[P7-66] saving the form schema threw —", cause);
}

export function FieldBuilder({
  formId,
  purpose,
  isAnonymous,
  formName,
  description,
  hasSubmissions,
  initialSchema,
}: {
  formId: string;
  /**
   * ⚠️ WHAT THE FORM IS FOR DECIDES WHICH QUESTIONS CAN BE ASKED, and what the
   * preview draws around them. See `offerableFieldTypes` and
   * `RespondentPreview`.
   */
  purpose: FormPurpose;
  /**
   * Drives the preview's notice. Set on the Settings tab; meaningless on a
   * client form, where there is no captured identity to withhold.
   */
  isAnonymous: boolean;
  formName: string;
  description: string;
  /**
   * ⚠️ WHETHER THE FORM HAS ANY SUBMISSIONS AT ALL, WHICH IS THE GRANULARITY THE
   * DATABASE WORKS AT. `vizserve_pms_form_field_protect` refuses a key rename or
   * a field delete once the FORM has submissions — not once the FIELD has
   * answers — so a question added a minute ago to a form with a thousand answers
   * is equally locked, and the screen has to say so rather than let somebody
   * discover it from a refusal.
   */
  hasSubmissions: boolean;
  /**
   * ⚠️ RECONCILED AGAINST THE ROWS BY THE LOADER, never the stored blob as read.
   * See `reconcileFormSchema` — a blob that Phase 1's dual-write failed to write
   * is exactly the one that would otherwise be projected back over the rows and
   * delete whatever it omits.
   */
  initialSchema: FormSchema;
}) {
  const router = useRouter();
  const { track, setDirty } = useSaveStatus();

  const builderStore = useFormBuilderStore(initialSchema);
  const schema = useFormBuilderSchema(builderStore);

  /** The last document the database accepted. */
  const [savedSchema, setSavedSchema] = useState<FormSchema>(initialSchema);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * A field whose key is already a row, and therefore immutable (D20/R5).
   *
   * Derived from the SAVED schema rather than the live one, so a question added
   * a moment ago and not yet saved still has a derivable key — there is no
   * stored answer to orphan yet. Postgres enforces the real rule either way.
   */
  const lockedEntityIds = useMemo(() => new Set(savedSchema.root), [savedSchema]);

  /**
   * The questions whose answers actually exist.
   *
   * Both halves are required: a field that is not yet a row has nothing filed
   * under it whatever the form's count is, and a form with no submissions locks
   * nothing whatever its fields are.
   */
  const answeredIds = useMemo(
    () => (hasSubmissions ? lockedEntityIds : new Set<string>()),
    [hasSubmissions, lockedEntityIds],
  );

  const runtime = useMemo(
    () => ({ mode: "builder" as const, lockedEntityIds }),
    [lockedEntityIds],
  );

  const { active, archived } = splitCanvasFields(schema);

  const dirty = !sameFormSchema(schema, savedSchema);

  /**
   * ⚠️ WHY THE DOCUMENT CANNOT BE WRITTEN YET, OR NULL.
   *
   * Pure and synchronous, unlike `validateSchema`, which is neither — it writes
   * errors into the store as a documented side effect, so calling it on every
   * debounce would paint "Give the field a label" in red under a question
   * somebody has been typing into for four hundred milliseconds. See
   * `unsavableReason`.
   */
  const blocked = unsavableReason(schema);

  /*
   * ⚠️ ONLY A SAVE IN FLIGHT MAKES THE LIST BUSY — not "somebody is typing".
   *
   * That is the whole difference the autosave made. The old rule was
   * `pending || dirty`, which froze every list action the instant a character
   * was entered, because the save that carried the reorder would have carried
   * the half-typed question with it. Now the debounce settles the document
   * first; what is left to guard against is a reorder racing a write that is
   * already on the wire.
   */
  const listBusy = saving;

  // Reported UP to the shared indicator in the top bar. There is no room for a
  // status line in the canvas, and two of them disagreeing is worse than none.
  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);

  useEffect(() => () => setDirty(false), [setDirty]);

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
   * archive, restore, reorder, duplicate — has nothing typed behind it, so a
   * refusal should leave the builder showing what the database actually holds.
   * An autosave of typed text does have something behind it, and throwing it
   * away because Postgres refused would delete the very work the person now has
   * to correct.
   */
  async function persist(message: string | null, revertOnFailure: boolean): Promise<boolean> {
    setSaving(true);

    try {
      return await track(async () => {
        /*
         * ⚠️ THE KEYS ARE DERIVED IMMEDIATELY BEFORE THE WRITE, not as the label
         * is typed. Deriving on every keystroke would rewrite the key behind a
         * question twenty times while somebody types its name, and
         * `sameFormSchema` would see a changed document each time — an autosave
         * feeding itself. Here it runs once, on a document that is about to be
         * written, and only for fields that are not yet rows.
         */
        for (const change of deriveFieldKeys(builderStore.getSchema(), lockedEntityIds)) {
          builderStore.setEntityAttribute(change.entityId, "key", change.key);
        }

        const effect = planSchemaSave(await attemptSave(), revertOnFailure);

        if (effect.kind === "failed") {
          setError(effect.message);
          if (effect.revert) {
            resetBuilderStore(builderStore, savedSchema);
            toast.error(effect.message);
          } else {
            // Remembered so the autosave does not try the same rejected
            // document again on the next tick. See `refusedSchemaRef`.
            refusedSchemaRef.current = builderStore.getSchema();
          }
          return { outcome: { kind: "failed" as const, message: effect.message }, value: false };
        }

        refusedSchemaRef.current = null;
        setSavedSchema(effect.schema);
        setError(null);
        /*
         * ⚠️ NO TOAST ON AN AUTOSAVE. A toast per pause in typing is a
         * notification storm about the thing the top bar is already saying
         * quietly. The mechanical actions still announce themselves, because
         * those are discrete things somebody asked for and then looked away
         * from.
         */
        if (message !== null) toast.success(message);
        // The rest of the page — the submission count, the locked-keys line — is
        // server-rendered from the rows this save just rewrote.
        router.refresh();
        return { outcome: { kind: "saved" as const }, value: true };
      });
    } finally {
      setSaving(false);
    }
  }

  /*
   * ⚠️ THE AUTOSAVE ITSELF, AND EVERY CONDITION ON IT IS LOAD-BEARING.
   *
   *   `dirty`   — nothing to write. Without it the effect would fire on mount
   *               and write back the document the page had just read.
   *   `blocked` — the document cannot be written. A half-typed question would be
   *               refused, and the refusal would paint errors under a question
   *               somebody is still writing.
   *   `saving`  — a write is already on the wire. Two overlapping whole-document
   *               saves means the later one wins, which is survivable; a
   *               debounce that re-arms while one is running is not.
   *
   * The timer is cleared on every re-run, so the pause is measured from the LAST
   * change rather than the first — which is what makes it a pause in typing
   * rather than a fixed interval.
   *
   * ⚠️ `saveRef` EXISTS SO THE EFFECT DOES NOT DEPEND ON `persist`. That closure
   * is rebuilt on every render, so listing it would clear and re-arm the timer on
   * every keystroke's re-render — the debounce would still work, but only by
   * accident, and any render from elsewhere would postpone the save indefinitely.
   */
  /*
   * ⚠️ THE DOCUMENT THAT WAS LAST REFUSED, SO THE AUTOSAVE DOES NOT LOOP ON IT.
   *
   * A failed save leaves the store exactly as it was — `revertOnFailure` is
   * false on an autosave, because throwing away typed work over a refusal is
   * the one thing this builder must never do. But that means `dirty` is still
   * true and `blocked` is still null, so the effect below re-arms and tries the
   * same rejected document again 900ms later. An expired session, a dropped
   * connection or a Postgres refusal therefore becomes a write every 900ms, for
   * as long as the tab is open, with a toast each time.
   *
   * So a refusal is remembered against the exact schema object that caused it.
   * The store hands back a NEW object on every change, so the next real edit
   * makes this comparison false and the save is tried again — retry on a
   * CHANGE rather than on a timer. If nothing changes, nothing is retried, and
   * the top bar goes on saying "Not saved" with the reason, which is true.
   */
  const refusedSchemaRef = useRef<FormSchema | null>(null);

  const saveRef = useRef(persist);

  /*
   * Kept current in an effect rather than during render. Writing to a ref while
   * rendering is what `react-hooks` refuses (and the React Compiler cannot
   * reason about) — it makes the render impure. This runs after every commit,
   * which is always before a `setTimeout` scheduled by the effect below can
   * fire.
   */
  useEffect(() => {
    saveRef.current = persist;
  });

  useEffect(() => {
    if (!dirty || blocked !== null || saving) return;
    // Already refused, unchanged since. See `refusedSchemaRef`.
    if (refusedSchemaRef.current === schema) return;

    const timer = setTimeout(() => {
      void saveRef.current(null, false).catch(reportSaveThrow);
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `schema` is in the list on purpose: `dirty` stays true across successive
    // edits, so without it a second change during the same dirty spell would not
    // restart the pause.
  }, [dirty, blocked, saving, schema]);

  /**
   * ⚠️ WHAT A MECHANICAL CHANGE — REORDER, ARCHIVE, RESTORE, DELETE — DOES ABOUT
   * SAVING, AND WHY IT IS NOT SIMPLY `persist(msg, true)`.
   *
   * Two things were wrong with that, and both cost work:
   *
   *   IT COULD BE REFUSED FOR A REASON THAT HAS NOTHING TO DO WITH IT. A save
   *   writes the WHOLE document, so archiving question 5 while question 6 is
   *   half-typed is a document `unsavableReason` already knows cannot be
   *   written. So the change is applied to the store and LEFT for the autosave,
   *   which writes it the moment the form is complete. Nothing is lost and
   *   nothing is blocked — the alternative is the dirty-lock this phase deleted.
   *
   *   `revertOnFailure` WAS UNCONDITIONALLY TRUE, AND THAT IS DATA LOSS. It
   *   exists for changes with nothing typed behind them — a refused reorder
   *   should leave the builder showing what the database holds. But if a
   *   question has been typed and not yet saved, `resetBuilderStore` throws it
   *   away, and the person who pressed "move down" loses the question they were
   *   writing. So reverting is allowed only when the document was CLEAN before
   *   this change: then the only thing a revert can discard is the change
   *   itself, which is exactly what it is for.
   */
  function persistMechanical(message: string, wasClean: boolean) {
    // Read from the store rather than from `schema`: the mutation that preceded
    // this call has already landed, and the render holding `blocked` has not
    // happened yet.
    if (unsavableReason(builderStore.getSchema()) !== null) return;

    void persist(message, wasClean).catch(reportSaveThrow);
  }

  /** Applies an ordered list of `setEntityIndex` calls, then saves the form. */
  function applyMoves(moves: ReturnType<typeof planEntityReorder>) {
    if (moves.length === 0) return;

    const wasClean = !dirty;

    // Applied front to back: `setEntityIndex` removes then re-inserts, so the
    // order of these calls is the order that makes them a move rather than
    // several independent ones. See `planEntityReorder`.
    for (const step of moves) builderStore.setEntityIndex(step.entityId, step.index);

    persistMechanical("Order saved", wasClean);
  }

  function move(entityId: string, direction: "up" | "down") {
    applyMoves(planEntityReorder(schema, entityId, direction));
  }

  function setArchived(entityId: string, isArchived: boolean) {
    const wasClean = !dirty;

    builderStore.setEntityAttribute(entityId, "archived", isArchived);
    if (isArchived && selectedId === entityId) setSelectedId(null);

    persistMechanical(isArchived ? "Question archived" : "Question restored", wasClean);
  }

  /**
   * Adds a question of `type` BELOW the one being edited, and opens it.
   *
   * ⚠️ BELOW THE SELECTED ONE, NOT AT THE END. A form is written by working down
   * it; appending and then pressing the up arrow six times is not building a
   * form, it is fighting one. Nothing selected means the end, which is where
   * somebody adding their first questions is anyway.
   *
   * ⚠️ NOT SAVED, AND IT CANNOT BE. A new entity carries an empty label, so
   * `unsavableReason` blocks the autosave until it has been named — which is
   * exactly the "fill this in before it is a question" the editor then asks for,
   * enforced by the thing that decides rather than by a comment.
   */
  function addField(type: FieldType) {
    const slot =
      selectedId === null ? active.length : active.findIndex((f) => f.id === selectedId) + 1;

    setSelectedId(addFieldEntity(builderStore, type, rootIndexForSlot(schema, slot)));
    setError(null);
  }

  /**
   * ⚠️ A TYPE CHANGE IS A DELETE AND AN ADD, and it keeps the selection.
   *
   * There is no `setEntityType` in `@coltorapps/builder` — see
   * `replaceFieldType`. The new entity gets a new id, so the selection has to
   * follow it or the editor would close on the question somebody is editing.
   */
  function changeType(entityId: string, type: FieldType) {
    const replacement = replaceFieldType(builderStore, entityId, type);
    if (replacement !== null) setSelectedId(replacement);
    setError(null);
  }

  /**
   * Duplicate.
   *
   * ⚠️ ALWAYS AVAILABLE, INCLUDING ON AN ANSWERED QUESTION — unlike the type
   * change beside it. A copy is a brand-new field with no row and no answers, so
   * nothing about R5 applies to it, and the ORIGINAL is untouched.
   * `cloneFieldEntity` clears the copy's key so `deriveFieldKeys` mints a fresh,
   * de-duplicated one rather than shipping two fields with one storage identity.
   */
  function duplicate(entityId: string) {
    const copy = cloneFieldEntity(builderStore, entityId);
    if (copy !== null) setSelectedId(copy);
    setError(null);
  }

  /**
   * Delete, or archive when there are answers.
   *
   * ⚠️ TWO DIFFERENT OPERATIONS BEHIND ONE BUTTON, AND THE BUTTON SAYS WHICH.
   * `vizserve_pms_form_field_protect` refuses to drop a field once the form has
   * submissions, so deleting an answered question is a save Postgres rejects.
   * Archiving takes it off the form and keeps its answers, which is the only
   * thing that can happen to it (R5).
   *
   * A question that was never saved is deleted outright — there is no row and no
   * answer, so archiving it would leave a permanent, invisible entry in a
   * document with no reason to carry one. It also needs no save: there is nothing
   * in the database to remove, and a save here could be blocked by another
   * half-typed question elsewhere on the form.
   */
  function removeField(entityId: string) {
    if (answeredIds.has(entityId)) {
      setArchived(entityId, true);
      return;
    }

    const wasSaved = lockedEntityIds.has(entityId);
    const wasClean = !dirty;

    builderStore.deleteEntity(entityId);
    setSelectedId(null);
    setError(null);

    if (wasSaved) persistMechanical("Question deleted", wasClean);
  }

  /**
   * A drop, resolved.
   *
   * ⚠️ EVERY DECISION HERE IS `lib/form-builder/canvas.ts`'s, which is pure and
   * tested. What this contributes is only the translation of dnd-kit's `over.id`
   * into a position among the questions the user can SEE — a `root` index would
   * be wrong the moment a field is archived.
   */
  function handleDrop(drag: FieldDrag, overId: string) {
    if (listBusy) return;

    const to = active.findIndex((field) => field.id === overId);
    if (to < 0) return;

    applyMoves(planEntityDrop(schema, drag.entityId, to));
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
   * submitted by any sequence of actions.
   *
   * ⚠️ IT DOES NOT HIDE A FILE QUESTION THAT ALREADY EXISTS. A client form with
   * an attachment question can be flipped to EMPLOYEE_ENGAGEMENT while it has no
   * submissions, and that question is still on the form, still in the list, still
   * editable — including archiving it, which is the fix.
   */
  const offerableFieldTypes = useMemo(
    () =>
      purpose === "EMPLOYEE_ENGAGEMENT"
        ? ADDABLE_FIELD_TYPES.filter((fieldType) => fieldType !== "file")
        : ADDABLE_FIELD_TYPES,
    [purpose],
  );

  const selected =
    selectedId !== null && Object.hasOwn(schema.entities, selectedId)
      ? { id: selectedId, entity: schema.entities[selectedId]! }
      : null;

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
        {/*
          ⚠️ THREE INDEPENDENTLY SCROLLING COLUMNS, NOT ONE LONG PAGE. A form with
          thirty questions makes the middle column tall; the type rail and the
          preview must not scroll away with it, or adding question 31 means
          scrolling back to the top for the palette. The height is the viewport
          less the 56px header and the 45px tab strip.

          Below 1180px the preview drops under the other two — at that width three
          columns leaves the form about 300px wide, which is narrower than the
          phone it is previewing — and the whole thing goes back to one document
          scroll. Below 760px the rail goes full-width above the list, because a
          212px rail beside a 300px column is two unusable columns.
        */}
        <div className="grid h-[calc(100svh-6.3125rem)] grid-cols-1 overflow-hidden max-[1180px]:h-auto max-[1180px]:overflow-visible min-[760px]:grid-cols-[212px_minmax(0,1fr)] min-[1180px]:grid-cols-[236px_minmax(400px,1fr)_minmax(440px,1.15fr)]">
          <QuestionTypes
            types={offerableFieldTypes}
            currentType={selected?.entity.type ?? null}
            disabled={listBusy}
            onAdd={addField}
          />

          <div className="overflow-y-auto border-r pb-10 max-[1180px]:overflow-visible">
            <div className="p-4">
              <FixedFieldsNote purpose={purpose} />

              {active.length === 0 && archived.length === 0 ? (
                <EmptyCanvas purpose={purpose} />
              ) : (
                <QuestionList
                  active={active}
                  archived={archived}
                  selectedId={selectedId}
                  answeredIds={answeredIds}
                  busy={listBusy}
                  onSelect={(entityId) => {
                    // Free, now that there is nothing uncommitted to lose.
                    setSelectedId(entityId);
                    setError(null);
                  }}
                  onMove={move}
                  onRestore={(entityId) => setArchived(entityId, false)}
                />
              )}

              {selected ? (
                <QuestionEditor
                  builderStore={builderStore}
                  entityId={selected.id}
                  type={selected.entity.type}
                  label={selected.entity.attributes.label}
                  fieldKey={selected.entity.attributes.key}
                  answered={answeredIds.has(selected.id)}
                  offerableTypes={offerableFieldTypes}
                  busy={listBusy}
                  // Only THIS question's reason. A message about question 6
                  // rendered under question 2 is a message about the wrong thing.
                  problem={blocked?.entityId === selected.id ? blocked.message : null}
                  error={error}
                  onChangeType={(type) => changeType(selected.id, type)}
                  onDuplicate={() => duplicate(selected.id)}
                  onRemove={() => removeField(selected.id)}
                />
              ) : null}

              {/*
                ⚠️ A DOCUMENT BLOCKED BY A QUESTION THAT IS NOT OPEN. The editor
                carries the reason when the offending question is the one on
                screen; when it is not, nothing would say why the form has
                stopped saving — the top bar would read "Unsaved changes"
                indefinitely with no way to find out why. This names it and opens
                it.
              */}
              {blocked !== null && blocked.entityId !== selectedId ? (
                <button
                  type="button"
                  onClick={() => setSelectedId(blocked.entityId)}
                  className="mt-3 flex w-full items-start gap-1.5 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-left text-xs leading-relaxed text-warning"
                >
                  {blocked.message} Open it to finish.
                </button>
              ) : null}

              {/* A refusal from a list action, where no question is open to carry
                  it. */}
              {error !== null && selectedId === null ? (
                <p
                  role="alert"
                  className="mt-3 rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive"
                >
                  {error}
                </p>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 max-[1180px]:col-span-full max-[1180px]:border-t">
            <RespondentPreview
              builderStore={builderStore}
              purpose={purpose}
              isAnonymous={isAnonymous}
              formName={formName}
              description={description}
              active={active}
            />
          </div>
        </div>
      </FieldDndProvider>
    </FieldRuntimeProvider>
  );
}

/**
 * What this kind of form collects before any question is asked.
 *
 * ⚠️ SHOWN ON BOTH, INCLUDING THE ONE WHERE THE ANSWER IS "NOTHING". A staff
 * form having no fixed fields is a fact worth stating once — otherwise the only
 * way to learn that /respond asks for no name is to go and look at it.
 */
function FixedFieldsNote({ purpose }: { purpose: FormPurpose }) {
  const isClient = purpose === "CLIENT_REQUEST";

  return (
    <div className="mb-3 rounded-lg border border-dashed bg-muted px-3 py-2.5">
      <p className="text-2xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {isClient ? "Always collected" : "Staff form"}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {isClient
          ? "Every client form asks these five. They are columns on the request, not questions, so they cannot be moved, renamed or removed."
          : "No fixed fields. The session already says who is answering, so the form is only your questions."}
      </p>
      {isClient ? (
        <p className="pt-1 text-xs text-muted-foreground">
          Your name · Your email · What do you need? · Tell us more · When do you need it?
        </p>
      ) : null}
    </div>
  );
}

function EmptyCanvas({ purpose }: { purpose: FormPurpose }) {
  return (
    <div className="rounded-lg border border-dashed p-7 text-center">
      <FilePlus2 aria-hidden className="mx-auto mb-2 size-5 text-muted-foreground" />
      <p className="text-sm font-medium">No questions yet</p>
      <p className="mx-auto mt-1 max-w-[40ch] text-xs text-balance text-muted-foreground">
        {purpose === "CLIENT_REQUEST"
          ? "The five above are collected on every client form. Pick a type on the left to ask for anything else."
          : "Pick a type on the left to ask your first question."}
      </p>
    </div>
  );
}
