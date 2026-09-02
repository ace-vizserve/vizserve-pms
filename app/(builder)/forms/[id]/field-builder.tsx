"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { FormSchema } from "@/lib/form-builder/builder";
import {
  FIELD_TYPE_LABELS,
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
import {
  CANVAS_END_ID,
  CanvasEndDropZone,
  FieldDndProvider,
  type FieldDrag,
} from "@/lib/form-builder/dnd";
import { planEntityReorder } from "@/lib/form-builder/schema";
import { planSchemaSave, type SchemaSaveAttempt } from "@/lib/form-builder/save-outcome";
import { suggestFieldKey, type FieldType } from "@/lib/schemas/forms";
import { cn } from "@/lib/utils";
import { saveSchema } from "@/app/(app)/forms/actions";
import { FieldCard } from "./field-card";
import { FieldPalette } from "./field-palette";
import { FieldPanel } from "./field-panel";

/**
 * P7-66 — the form builder, on `@coltorapps/builder`'s store.
 *
 * ⚠️ PHASE 4a RESHAPED THIS SCREEN. Phases 2+3 replaced the hand-rolled builder
 * with the coltorapps store but kept its shape: an "add field" form that
 * expanded above the list, and an editor that expanded inside a row. Ace looked
 * at it and asked for Elementor — a palette of types, a canvas, and a panel for
 * the selected field. That is what this is:
 *
 *   FIELD TYPES │ the form, as cards │ EDIT FIELD
 *   ⠿ Short text│ ⠿ What do you need?│ Label
 *   ⠿ Long text │   Long text · brief│ Field key
 *   ⠿ Choose one│ ┈┈ drop here ┈┈┈┈┈┈│ Required ◉
 *
 * Everything hard-won in Phases 2+3 survives it unchanged: `planSchemaSave`
 * still decides what a refusal does to the store, the options editor still keeps
 * its raw draft separate from the normalised store, the field type is still
 * fixed once saved, and keys still lock once a form has submissions.
 *
 * ⚠️ THE UP/DOWN BUTTONS ARE NOT GOING ANYWHERE. Drag is a POINTER-ONLY
 * ENHANCEMENT over a working keyboard path (WCAG 2.2 AA 2.1.1, and 2.5.7 on
 * dragging movements), and it is precisely because the buttons already existed —
 * backed by the tested `planEntityReorder`, including its "nearest VISIBLE
 * neighbour" rule that steps over an archived field — that dnd-kit could be
 * taken without also writing a keyboard sensor to make the feature reachable.
 * Every route to a new order goes through `planEntityReorder`; see
 * `lib/form-builder/canvas.ts`.
 *
 * ⚠️ A SAVE WRITES THE WHOLE DOCUMENT. That is why the list actions still go
 * unavailable while a field is half-typed — archiving field B cannot go through
 * while field A holds an invalid key, because the save carries both. What
 * changed is the QUESTION being asked: the old builder froze the list whenever
 * an editor was OPEN, which punished anybody who clicked a field to look at it.
 * It now asks whether the document has actually changed (`sameFormSchema`), so
 * selecting is free and only typing locks anything.
 */
export function FieldBuilder({
  formId,
  initialSchema,
}: {
  formId: string;
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
   * Derived from the SAVED schema rather than the live one, so a field added a
   * moment ago and not yet saved still has an editable key — there is no stored
   * answer to orphan yet. Postgres enforces the real rule either way.
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
   * half-typed field or is refused because of it. Neither is what the person
   * clicking Archive asked for.
   */
  const dirty = !sameFormSchema(schema, savedSchema);
  const listBusy = pending || dirty;

  const selected =
    selectedId === null ? null : ([...active, ...archived].find((f) => f.id === selectedId) ?? null);

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
   * should leave the builder showing what the database actually holds. A field
   * editor does have something typed behind it, and throwing it away because
   * Postgres refused a `field_key` rename would delete the very work the person
   * now has to correct.
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
   * Opens one field in the panel, discarding whatever the last one held.
   *
   * Stated rather than hidden: switching fields loses unsaved changes to the one
   * you were in. That is the price of a save that writes the whole document, and
   * the alternative — carrying an unfinished field into the next save — is a
   * save that fails for a reason the person is not looking at. It is also why
   * the list is unavailable while `dirty`: the only way to reach another field's
   * controls in that state is Save or Cancel.
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
      await persist(isArchived ? "Field archived" : "Field restored", true);
    });
  }

  /**
   * Adds a field of `type` at a `root` index and opens it in the panel.
   *
   * NOT SAVED IMMEDIATELY, and it cannot be: `keyAttribute` and `labelAttribute`
   * both refuse the empty strings a new entity carries, which is exactly the
   * "fill this in before it is a field" the panel then asks for.
   */
  function addField(type: FieldType, rootIndex: number) {
    resetBuilderStore(builderStore, savedSchema);
    setSelectedId(addFieldEntity(builderStore, type, rootIndex));
    setError(null);
  }

  /**
   * A drop, resolved.
   *
   * ⚠️ EVERY DECISION HERE IS `lib/form-builder/canvas.ts`'s, which is pure and
   * tested. What this function contributes is only the translation of dnd-kit's
   * `over.id` into a position among the fields the user can SEE — a `root` index
   * would be wrong the moment a field is archived.
   */
  function handleDrop(drag: FieldDrag, overId: string) {
    // Belt and braces: the palette is disabled and the sortable context is
    // disabled while `listBusy`, so a drop should not be able to arrive. If one
    // does, it would be a whole-form save carrying a half-typed field.
    if (listBusy) return;

    const overIndex = active.findIndex((field) => field.id === overId);

    if (drag.kind === "new") {
      const slot = overId === CANVAS_END_ID || overIndex < 0 ? active.length : overIndex;
      addField(drag.fieldType, rootIndexForSlot(schema, slot));
      return;
    }

    const to = overId === CANVAS_END_ID ? active.length - 1 : overIndex;
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
     * the first save of every field would be a refusal over a box the person
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
      await persist(isNew ? "Field added" : "Field saved", false);
    });
  }

  const paletteReason = dirty
    ? "Save or cancel the field you are editing before adding another — a save writes the whole form at once."
    : null;

  return (
    <FieldRuntimeProvider runtime={runtime}>
      <FieldDndProvider
        itemIds={active.map((field) => field.id)}
        disabled={listBusy}
        onDrop={handleDrop}
        renderOverlay={(drag) => (
          <div className="pointer-events-none max-w-64 truncate rounded-md border bg-card px-2.5 py-1.5 text-sm font-medium shadow-overlay">
            {drag.kind === "new"
              ? FIELD_TYPE_LABELS[drag.fieldType]
              : (schema.entities[drag.entityId]?.attributes.label ?? "Field")}
          </div>
        )}
      >
        <div className="grid items-start gap-4 xl:grid-cols-[15rem_minmax(0,1fr)_21rem]">
          <FieldPalette
            disabled={listBusy}
            disabledReason={paletteReason}
            onAdd={(fieldType) => addField(fieldType, schema.root.length)}
          />

          {/*
            THE CANVAS IS CAPPED even though the page is full-bleed. A question
            card stretched across an ultrawide monitor puts its label and its
            Archive button a foot apart; the palette and the panel stay pinned to
            the edges, where the eye expects a tool rail.
          */}
          <div className="mx-auto w-full max-w-3xl space-y-3">
            <ul className="space-y-2">
              {active.map((field, index) => (
                <FieldCard
                  key={field.id}
                  field={field}
                  index={index}
                  count={active.length}
                  selected={selectedId === field.id}
                  busy={listBusy}
                  pending={pending}
                  dragDisabled={listBusy}
                  onSelect={() => select(field.id)}
                  onMove={(direction) => move(field.id, direction)}
                  onArchive={() => setArchived(field.id, true)}
                />
              ))}
            </ul>

            {/*
              The end of the list, and the empty canvas — one droppable, because
              a form with no fields has no card to drop onto and a palette that
              can only insert beside an existing field could never add the first
              one.
            */}
            <CanvasEndDropZone>
              {(isOver) => (
                <div
                  className={cn(
                    "rounded-lg border border-dashed p-6 text-center transition-colors",
                    isOver ? "border-primary bg-accent" : "bg-muted/30",
                  )}
                >
                  {active.length === 0 ? (
                    <>
                      <p className="text-sm font-medium">No questions yet</p>
                      <p className="mx-auto mt-1 max-w-sm text-xs text-balance text-muted-foreground">
                        Name, email, title, description and target date are collected on every
                        form automatically. Drag a field type in from the left — or click one —
                        to ask for what is specific to this request.
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Drop a field type here to add it at the end.
                    </p>
                  )}
                </div>
              )}
            </CanvasEndDropZone>

            {archived.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-dashed p-4">
                <p className="text-xs font-medium text-muted-foreground">
                  Archived ({archived.length})
                </p>
                {/* Archived rather than deleted: historical requests still store
                    answers under these keys, so removing them would orphan data. */}
                <p className="text-xs text-muted-foreground">
                  Hidden from the form. Kept because existing requests answered them.
                </p>
                <ul className="space-y-1.5 pt-1">
                  {archived.map((field) => (
                    <li key={field.id} className="flex items-center gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {field.entity.attributes.label} · {field.entity.attributes.key}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={listBusy}
                        onClick={() => setArchived(field.id, false)}
                      >
                        <ArchiveRestore />
                        Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* A refusal that arrived from a list action, where there is no
                field open in the panel to carry it. */}
            {error && selectedId === null ? (
              <p
                role="alert"
                className="rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>

          <FieldPanel
            builderStore={builderStore}
            field={selected}
            isNew={selectedId !== null && !lockedEntityIds.has(selectedId)}
            pending={pending}
            dirty={dirty}
            error={selectedId === null ? null : error}
            onSave={saveSelectedField}
            onCancel={() => select(null)}
          />
        </div>
      </FieldDndProvider>
    </FieldRuntimeProvider>
  );
}
