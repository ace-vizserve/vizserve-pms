"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, ChevronDown, ChevronUp, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FormSchema } from "@/lib/form-builder/builder";
import {
  addFieldEntity,
  FieldAttributesEditor,
  FieldPreview,
  FieldRuntimeProvider,
  resetBuilderStore,
  useFormBuilderSchema,
  useFormBuilderStore,
  validateBuilderSchema,
} from "@/lib/form-builder/components";
import { planEntityReorder } from "@/lib/form-builder/schema";
import { planSchemaSave, type SchemaSaveAttempt } from "@/lib/form-builder/save-outcome";
import { FIELD_TYPES, suggestFieldKey, type FieldType } from "@/lib/schemas/forms";
import { saveSchema } from "../actions";

/**
 * P7-66 Phases 2+3 — the form builder, on `@coltorapps/builder`'s store.
 *
 * ⚠️ WHAT REPLACED WHAT. The hand-rolled builder kept one `<FieldForm>` of
 * useState per field and wrote a row per edit through `saveField`,
 * `setFieldActive` and `moveField` — three server actions, three unsynchronised
 * round trips each, and a Phase 1 dual-write bolted on behind them to keep the
 * schema blob from going stale. All of that is gone. The whole form is ONE
 * document in the builder store, and one `saveSchema` writes it through
 * `vizserve_pms_save_form_schema`, which stores the blob and projects the rows
 * in a single transaction.
 *
 * ⚠️ THE UP/DOWN BUTTONS ARE KEPT, DELIBERATELY, and drag-and-drop is not
 * introduced here. It is the one part of the swap with no existing equivalent to
 * check against, it needs a dependency the repo does not have, and keeping the
 * control identical is what makes "did anything change for the user?" answerable
 * at a glance. They are now `setEntityIndex` calls rather than a `moveField`
 * action; the rule that decides them is unchanged and still
 * `planFieldReorder`'s (see `planEntityReorder`).
 *
 * ⚠️ A SAVE WRITES THE WHOLE DOCUMENT, and that is why only one field editor is
 * open at a time and why the list controls are disabled while one is. Archiving
 * field B cannot go through while field A's editor holds a half-typed key: the
 * save carries both. Rather than silently discarding what somebody typed, the
 * controls say they are unavailable and the editor says why.
 */

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  date: "Date",
  select: "Choose one",
  multiselect: "Choose many",
  file: "File upload",
  email: "Email",
  number: "Number",
};

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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newFieldType, setNewFieldType] = useState<FieldType>("text");
  const [error, setError] = useState<string | null>(null);

  /*
   * Still here, and still doing the same job it did in Phase 1: stopping one
   * impatient double-click from sending two saves. It is no longer a guard rail
   * over a race, though — `vizserve_pms_save_form_schema` is one function call
   * and therefore one transaction, so two overlapping saves can no longer leave
   * the rows and the blob disagreeing. The later one simply wins.
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

  const fields = schema.root
    .filter((entityId) => Object.hasOwn(schema.entities, entityId))
    .map((entityId) => ({ id: entityId, entity: schema.entities[entityId]! }));

  const active = fields.filter((field) => field.entity.attributes.archived !== true);
  const archived = fields.filter((field) => field.entity.attributes.archived === true);

  const editing = editingId !== null;
  // Every list action saves the whole document, so none of them can run while an
  // editor holds changes the document does not want yet.
  const listBusy = pending || editing;

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
   * archive, restore, reorder — has nothing typed behind it, so a refusal should
   * leave the builder showing what the database actually holds. A field editor
   * does have something typed behind it, and throwing it away because Postgres
   * refused a `field_key` rename would delete the very work the person now has
   * to correct.
   */
  async function persist(message: string, revertOnFailure: boolean): Promise<boolean> {
    /*
     * ⚠️ BOTH REFUSALS ARE ONE OUTCOME. `validateBuilderSchema` refusing the
     * document and Postgres refusing it leave the builder in the same state —
     * showing a form the database does not hold — so `planSchemaSave` decides
     * what happens next for both, and `revertOnFailure` is honoured either way.
     * The validation branch used to return early without reverting, which left a
     * refused archive or reorder applied on screen to ride along on the next
     * save. See save-outcome.ts.
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
   * Opens one editor and closes any other, by discarding it.
   *
   * Stated rather than hidden: switching fields loses unsaved changes to the one
   * you were in. That is the price of a save that writes the whole document, and
   * the alternative — carrying an unfinished field into the next save — is a
   * save that fails for a reason the person is not looking at.
   */
  function openEditor(entityId: string | null) {
    resetBuilderStore(builderStore, savedSchema);
    setEditingId(entityId);
    setError(null);
  }

  function move(entityId: string, direction: "up" | "down") {
    const moves = planEntityReorder(schema, entityId, direction);
    if (moves.length === 0) return;

    // Applied front to back: `setEntityIndex` removes then re-inserts, so the
    // order of these calls is the order that makes them a swap rather than two
    // independent moves. See `planEntityReorder`.
    for (const step of moves) {
      builderStore.setEntityIndex(step.entityId, step.index);
    }

    startTransition(async () => {
      await persist("Order saved", true);
    });
  }

  function setArchived(entityId: string, isArchived: boolean) {
    builderStore.setEntityAttribute(entityId, "archived", isArchived);

    startTransition(async () => {
      await persist(isArchived ? "Field archived" : "Field restored", true);
    });
  }

  function addField() {
    const entityId = addFieldEntity(builderStore, newFieldType);
    setAdding(false);
    setEditingId(entityId);
    setError(null);
  }

  function saveEditedField() {
    const entityId = editingId;
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
      if (await persist(isNew ? "Field added" : "Field saved", false)) setEditingId(null);
    });
  }

  return (
    <FieldRuntimeProvider runtime={runtime}>
      <div className="space-y-4">
        {active.length === 0 && !adding ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm font-medium">No fields yet</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Name, email, title, description and target date are collected on every form
              automatically. Add what is specific to this request type.
            </p>
          </div>
        ) : null}

        <ul className="space-y-2">
          {active.map((field, index) => (
            <li key={field.id} className="rounded-lg border">
              <div className="flex items-center gap-3 p-3">
                <div className="flex flex-col">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${field.entity.attributes.label || "this field"} up`}
                    disabled={listBusy || index === 0}
                    onClick={() => move(field.id, "up")}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${field.entity.attributes.label || "this field"} down`}
                    disabled={listBusy || index === active.length - 1}
                    onClick={() => move(field.id, "down")}
                  >
                    <ChevronDown />
                  </Button>
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {field.entity.attributes.label || "New field"}
                    {field.entity.attributes.required ? (
                      <span className="ml-1.5 text-destructive" aria-label="required">
                        *
                      </span>
                    ) : (
                      <span className="ml-1.5 text-2xs font-normal text-muted-foreground">
                        optional
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {TYPE_LABELS[field.entity.type]}
                    {field.entity.attributes.key ? ` · ${field.entity.attributes.key}` : null}
                  </p>
                </div>

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => openEditor(editingId === field.id ? null : field.id)}
                >
                  {editingId === field.id ? "Close" : "Edit"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={listBusy}
                  onClick={() => setArchived(field.id, true)}
                >
                  Archive
                </Button>
              </div>

              {editingId === field.id ? (
                <div className="space-y-4 border-t p-3">
                  <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
                    <FieldAttributesEditor builderStore={builderStore} entityId={field.id} />

                    {error ? (
                      <p
                        role="alert"
                        className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                      >
                        {error}
                      </p>
                    ) : null}

                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveEditedField} loading={pending}>
                        {lockedEntityIds.has(field.id) ? "Save field" : "Add field"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        disabled={pending}
                        onClick={() => openEditor(null)}
                      >
                        Cancel
                      </Button>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      Reordering and archiving are unavailable until this field is saved or
                      cancelled — a save writes the whole form at once.
                    </p>
                  </div>

                  {/* The same components the client's browser renders, disabled.
                      One map, so the preview cannot drift from the form. */}
                  <div className="space-y-2 rounded-lg border border-dashed p-4">
                    <p className="text-xs font-medium text-muted-foreground">
                      How the client sees it
                    </p>
                    <FieldPreview builderStore={builderStore} entityId={field.id} />
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        {adding ? (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-4">
            <div className="space-y-2">
              <Label htmlFor="new-field-type">Type</Label>
              {/* `items` fills the TRIGGER; the children fill the popup. Without
                  it the closed control reads "short_text" instead of "Short
                  text", and `check:select-items` fails the build. */}
              <Select
                items={TYPE_LABELS}
                value={newFieldType}
                onValueChange={(value) => setNewFieldType(value as FieldType)}
              >
                <SelectTrigger id="new-field-type" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button size="sm" onClick={addField}>
              Add
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setAdding(false)}>
              Cancel
            </Button>

            {/*
              ⚠️ THE TYPE IS CHOSEN HERE AND FIXED AFTERWARDS — the one thing the
              old builder allowed that this one does not, and it is a
              consequence of the storage rather than a simplification. The entity
              id IS the `vizserve_pms_form_fields` row id, so changing a field's
              type is a delete and an insert, which
              `vizserve_pms_form_field_protect` refuses outright once the field
              has answers behind it. Archiving the field and adding a new one is
              the supported path, and it is the one that keeps the answers.
            */}
            <p className="basis-full text-xs text-muted-foreground">
              The type is fixed once the field is saved. To change it later, archive the field and
              add a new one — existing answers stay with the archived field.
            </p>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={listBusy}
            onClick={() => setAdding(true)}
          >
            <Plus />
            Add field
          </Button>
        )}

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

        {/* A refusal that arrived from a list action, where there is no editor
            open to carry it. */}
        {error && !editing ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
    </FieldRuntimeProvider>
  );
}
