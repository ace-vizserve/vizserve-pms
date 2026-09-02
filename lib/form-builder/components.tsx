"use client";

import { createContext, useContext } from "react";
import { Plus, X } from "lucide-react";
import type { BuilderStore, EntitiesValues, InterpreterStore } from "@coltorapps/builder";
import {
  BuilderEntity,
  BuilderEntityAttributes,
  InterpreterEntities,
  createAttributeComponent,
  createEntityComponent,
  useBuilderStore,
  useBuilderStoreData,
  useInterpreterStore,
  type EntitiesAttributesComponents,
  type EntitiesComponents,
} from "@coltorapps/builder-react";

import { FileField, type UploadFn } from "@/components/file-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  helpTextAttribute,
  labelAttribute,
  optionsAttribute,
  requiredAttribute,
} from "@/lib/form-builder/attributes";
import { cn } from "@/lib/utils";
import { nextOptionLabel } from "@/lib/form-builder/canvas";
import { formBuilder, type FormBuilder, type FormSchema } from "@/lib/form-builder/builder";
import {
  dateEntity,
  emailEntity,
  fileEntity,
  multiselectEntity,
  numberEntity,
  selectEntity,
  textareaEntity,
  textEntity,
} from "@/lib/form-builder/entities";
import { extractErrorMessage } from "@/lib/form-builder/values";
import type { AttachmentRef, FieldType } from "@/lib/schemas/forms";

/**
 * P7-66 Phases 2+3 — THE ONE COMPONENT MAP, and the ONLY file in the repo that
 * imports `@coltorapps/builder-react`.
 *
 * The library is headless in the literal sense: `<BuilderEntities>`,
 * `<BuilderEntity>` and `<InterpreterEntities>` render NOTHING on their own —
 * each takes a `components` map with one React component per entity name, and
 * `<BuilderEntityAttributes>` takes one component per entity name that renders
 * the attribute editors. This file is those maps.
 *
 * ⚠️ WHY THE BUILDER AND THE PUBLIC RENDERER SHARE ONE MAP, and why Phases 2
 * and 3 were merged to write it once. `BuilderEntity` and `InterpreterEntity`
 * hand an entity component the SAME props — the difference is that the builder
 * passes `value: undefined`, `error: undefined` and no-op `setValue` /
 * `validateValue` (measured in the shipped `dist`, not assumed). So one
 * component is a live control on /request/[slug] and a preview of that same
 * control in the builder, and "what the client sees" cannot drift from "what the
 * builder shows" because there is nothing to drift from.
 *
 * The no-ops are the problem that `FieldRuntime.mode` solves: a control that
 * silently ignores typing reads as broken. In `builder` mode every control is
 * rendered DISABLED, which is what makes it read as a preview rather than a
 * form.
 *
 * ⚠️ ANOTHER LIBRARY IMPORT ANYWHERE ELSE REOPENS RISK 1 OF THE PLAN. The
 * package is pre-1.0 and dormant (0.2.4, nine versions ever, no upstream fixes
 * coming); confining it to `lib/form-builder/` is what keeps vendoring the 34KB
 * of `dist` an option. `@coltorapps/builder` — the React-free half — may be
 * imported by the rest of this directory; `-react` may not leave this file.
 */

/**
 * Everything an entity component needs that is NOT in the schema.
 *
 * `file` is the reason this exists: `FileField` uploads before submit and needs
 * the form id and the server action that receives the bytes, neither of which is
 * a property of a field. Passing them down through the library is not possible —
 * `components` is a map of components, not of props — so they come through
 * context, which is also how the same map serves two hosts with different
 * capabilities.
 *
 * DEFAULTS TO `builder`, i.e. to disabled, DELIBERATELY. A missing provider then
 * renders an inert preview rather than a live form wired to nothing: a form that
 * cannot be typed into is a visible bug, a form whose uploads silently go
 * nowhere is not.
 */
export type FieldRuntime = {
  /** `builder` renders every control disabled, as a preview. */
  mode: "builder" | "interpreter";
  /** `file` only: which form the upload belongs to. */
  formId?: string;
  /** `file` only: the server action that receives the bytes. */
  upload?: UploadFn;
  /** `file` only: the picker hints. The server re-checks the real bytes. */
  accept?: string;
  maxFiles?: number;
  maxBytes?: number;
  /**
   * Builder only: entities that already exist as `vizserve_pms_form_fields`
   * rows, whose `key` is therefore immutable (D20/R5). Historical answers are
   * filed under it, and `vizserve_pms_form_field_protect` refuses the rename in
   * Postgres — this only stops somebody attempting it.
   */
  lockedEntityIds?: ReadonlySet<string>;
};

const FieldRuntimeContext = createContext<FieldRuntime>({ mode: "builder" });

export function FieldRuntimeProvider({
  runtime,
  children,
}: {
  runtime: FieldRuntime;
  children: React.ReactNode;
}) {
  return <FieldRuntimeContext.Provider value={runtime}>{children}</FieldRuntimeContext.Provider>;
}

function useFieldRuntime() {
  return useContext(FieldRuntimeContext);
}

/**
 * One entity error → one sentence.
 *
 * ⚠️ TWO KINDS OF THING LAND IN `entity.error`, which the library types as
 * `unknown`, and they are told apart here rather than at either producer:
 *
 *   - a `ZodError`, thrown by the entity's own `validate` — `extractErrorMessage`
 *     reads its first issue, which is what keeps the wording identical to the
 *     `buildFieldSchema` branch it replaced;
 *   - a plain STRING, set by the public form from `field_errors` when the
 *     database refuses a submission the browser accepted.
 *
 * `extractErrorMessage` deliberately refuses anything that is not a `ZodError`
 * — a crash message printed beside a field on a page anyone on the internet can
 * open is a leak, not advice — so the string case is handled here instead of by
 * loosening it. A server field error is app output that was written to be read.
 */
function fieldErrorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error;
  return extractErrorMessage(error);
}

/**
 * The label, the required marker, the help text and the error — the chrome
 * every field type shares.
 *
 * Lifted verbatim from the `FieldShell` that used to live in
 * app/request/[slug]/public-form.tsx, so the public form looks exactly as it did
 * before the swap.
 *
 * The required marker carries `aria-label`, and an optional field says
 * "(optional)" in words: state is never conveyed by a glyph's colour alone.
 */
function FieldShell({
  controlId,
  label,
  helpText,
  required,
  error,
  children,
}: {
  controlId: string;
  label: string;
  helpText: string;
  required: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={controlId}>
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-label="required">
            *
          </span>
        ) : (
          <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
        )}
      </Label>
      {helpText ? <p className="text-xs text-muted-foreground">{helpText}</p> : null}
      {children}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The DOM id for a field's control, from the ENTITY ID rather than the
 * `field_key`.
 *
 * The public form used the key, which was unique on that page. The builder
 * renders a field preview beside that field's attribute editors, so a key-based
 * id would collide with the editor inputs and point `<Label htmlFor>` at the
 * wrong control. The entity id is unique in both hosts.
 */
function controlIdFor(entityId: string): string {
  return `field-${entityId}`;
}

// ---------------------------------------------------------------------------
// The eight entity components.
// ---------------------------------------------------------------------------

/**
 * Re-validates only a field that is ALREADY showing an error, which is
 * `react-hook-form`'s `reValidateMode: "onChange"` and therefore what the rest
 * of this form does: complain once on submit, then clear as soon as the answer
 * is fixed. Validating every keystroke tells somebody their email is invalid
 * while they are still typing the first letter of it.
 *
 * `void` because nothing waits on it: the store re-renders the field when the
 * error changes.
 */
function revalidateIfShowing(error: unknown, validateValue: () => Promise<void>) {
  if (error !== undefined) void validateValue();
}

export const textFieldComponent = createEntityComponent(
  textEntity,
  ({ entity, setValue, validateValue }) => {
    const { mode } = useFieldRuntime();
    const controlId = controlIdFor(entity.id);
    const error = fieldErrorMessage(entity.error);

    return (
      <FieldShell
        controlId={controlId}
        label={entity.attributes.label}
        helpText={entity.attributes.helpText}
        required={entity.attributes.required}
        error={error}
      >
        <Input
          id={controlId}
          type="text"
          disabled={mode === "builder"}
          aria-invalid={error ? true : undefined}
          value={entity.value ?? ""}
          onChange={(event) => {
            setValue(event.target.value);
            revalidateIfShowing(entity.error, validateValue);
          }}
        />
      </FieldShell>
    );
  },
);

export const textareaFieldComponent = createEntityComponent(
  textareaEntity,
  ({ entity, setValue, validateValue }) => {
    const { mode } = useFieldRuntime();
    const controlId = controlIdFor(entity.id);
    const error = fieldErrorMessage(entity.error);

    return (
      <FieldShell
        controlId={controlId}
        label={entity.attributes.label}
        helpText={entity.attributes.helpText}
        required={entity.attributes.required}
        error={error}
      >
        <Textarea
          id={controlId}
          rows={4}
          disabled={mode === "builder"}
          aria-invalid={error ? true : undefined}
          value={entity.value ?? ""}
          onChange={(event) => {
            setValue(event.target.value);
            revalidateIfShowing(entity.error, validateValue);
          }}
        />
      </FieldShell>
    );
  },
);

/**
 * ⚠️ THE APP'S OWN CALENDAR, not `<input type="date">`, which is what the
 * dynamic date field used to render.
 *
 * The core "Target date" field on this very page already uses `DatePicker`, for
 * the reason recorded there: `<input type="date">` is three different controls
 * across Chrome, Safari and Firefox, none carrying our tokens, none dark-mode
 * aware, and one with no calendar at all on desktop — on one of the two screens
 * a client outside the company ever sees. A per-form date field asking the same
 * question in a different control was the odd one out.
 *
 * The stored value is unchanged: a bare `YYYY-MM-DD` string either way, which
 * is exactly what `dateEntity` validates. Empty is `""` and not null, because
 * that is the value the optional branch was ported to accept (see entities.ts).
 */
export const dateFieldComponent = createEntityComponent(
  dateEntity,
  ({ entity, setValue, validateValue }) => {
    const { mode } = useFieldRuntime();
    const controlId = controlIdFor(entity.id);
    const error = fieldErrorMessage(entity.error);

    return (
      <FieldShell
        controlId={controlId}
        label={entity.attributes.label}
        helpText={entity.attributes.helpText}
        required={entity.attributes.required}
        error={error}
      >
        <DatePicker
          id={controlId}
          className="w-56"
          disabled={mode === "builder"}
          invalid={Boolean(error)}
          value={entity.value ?? ""}
          onChange={(value) => {
            setValue(value ?? "");
            revalidateIfShowing(entity.error, validateValue);
          }}
        />
      </FieldShell>
    );
  },
);

export const selectFieldComponent = createEntityComponent(
  selectEntity,
  ({ entity, setValue, validateValue }) => {
    const { mode } = useFieldRuntime();
    const controlId = controlIdFor(entity.id);
    const error = fieldErrorMessage(entity.error);
    const options = entity.attributes.options;

    return (
      <FieldShell
        controlId={controlId}
        label={entity.attributes.label}
        helpText={entity.attributes.helpText}
        required={entity.attributes.required}
        error={error}
      >
        <Select
          // `items` fills the CLOSED trigger; the children only exist while the
          // popup is open. Value and label are the same string here — the
          // options are the words the builder typed — so nothing looks wrong
          // today, and it is still handed the map: "the two happen to match" is
          // not a property to rely on, and `check:select-items` fails the build
          // without it.
          items={Object.fromEntries(options.map((option) => [option, option]))}
          value={entity.value ?? ""}
          disabled={mode === "builder"}
          onValueChange={(value) => {
            setValue(typeof value === "string" ? value : "");
            revalidateIfShowing(entity.error, validateValue);
          }}
        >
          <SelectTrigger id={controlId} aria-invalid={error ? true : undefined}>
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldShell>
    );
  },
);

export const multiselectFieldComponent = createEntityComponent(
  multiselectEntity,
  ({ entity, setValue, validateValue }) => {
    const { mode } = useFieldRuntime();
    const controlId = controlIdFor(entity.id);
    const error = fieldErrorMessage(entity.error);
    const selected = entity.value ?? [];

    return (
      <FieldShell
        controlId={controlId}
        label={entity.attributes.label}
        helpText={entity.attributes.helpText}
        required={entity.attributes.required}
        error={error}
      >
        {/* A group, not a control: `htmlFor` has nothing single to point at, so
            the id sits on the container and each box carries its own visible
            label. */}
        <div id={controlId} className="space-y-2 rounded-md border p-3">
          {entity.attributes.options.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <Checkbox
                disabled={mode === "builder"}
                checked={selected.includes(option)}
                onCheckedChange={(checked) => {
                  setValue(
                    checked
                      ? [...selected, option]
                      : selected.filter((value) => value !== option),
                  );
                  revalidateIfShowing(entity.error, validateValue);
                }}
              />
              {option}
            </label>
          ))}
        </div>
      </FieldShell>
    );
  },
);

/**
 * A stand-in upload for the builder preview.
 *
 * `FileField` requires an upload function and the preview has no form to upload
 * to. It is unreachable — the picker is disabled — but a function that would
 * quietly succeed is the wrong thing to leave lying next to a file input, so
 * this one refuses.
 */
const previewUpload: UploadFn = async () => ({ ok: false, error: "This is a preview." });

export const fileFieldComponent = createEntityComponent(
  fileEntity,
  ({ entity, setValue, validateValue }) => {
    const runtime = useFieldRuntime();
    const controlId = controlIdFor(entity.id);
    const error = fieldErrorMessage(entity.error);

    return (
      <FieldShell
        controlId={controlId}
        label={entity.attributes.label}
        helpText={entity.attributes.helpText}
        required={entity.attributes.required}
        error={error}
      >
        <FileField
          id={controlId}
          // The preview has no form behind it. Empty rather than a made-up id,
          // and the picker is disabled, so nothing is ever posted with it.
          formId={runtime.formId ?? ""}
          // `pending_attachments.field_key` is what ties an upload to the field
          // that collected it, and it is the STORAGE key — the same one the
          // answer is filed under (§1), never the entity id.
          fieldKey={entity.attributes.key}
          value={entity.value ?? []}
          onChange={(next: AttachmentRef[]) => {
            setValue(next);
            revalidateIfShowing(entity.error, validateValue);
          }}
          upload={runtime.upload ?? previewUpload}
          accept={runtime.accept}
          maxFiles={runtime.maxFiles}
          maxBytes={runtime.maxBytes}
          disabled={runtime.mode === "builder"}
        />
      </FieldShell>
    );
  },
);

export const emailFieldComponent = createEntityComponent(
  emailEntity,
  ({ entity, setValue, validateValue }) => {
    const { mode } = useFieldRuntime();
    const controlId = controlIdFor(entity.id);
    const error = fieldErrorMessage(entity.error);

    return (
      <FieldShell
        controlId={controlId}
        label={entity.attributes.label}
        helpText={entity.attributes.helpText}
        required={entity.attributes.required}
        error={error}
      >
        <Input
          id={controlId}
          type="email"
          disabled={mode === "builder"}
          aria-invalid={error ? true : undefined}
          value={entity.value ?? ""}
          onChange={(event) => {
            setValue(event.target.value);
            revalidateIfShowing(entity.error, validateValue);
          }}
        />
      </FieldShell>
    );
  },
);

/**
 * ⚠️ AN EMPTY BOX IS `""`, NOT `undefined` AND NOT `0`.
 *
 * `numberEntity`'s value is `number | "" | undefined`, and the empty string is
 * the value the ported `buildFieldSchema` branch was written around:
 * `z.coerce.number()` reads `""` as 0, so a REQUIRED number field accepts a
 * blank. That is existing behaviour, ported rather than fixed (see
 * entities.ts), and sending `undefined` instead would change it — an untouched
 * required field would start failing where it used to pass.
 *
 * `Number(raw)` for everything else is total for `<input type="number">`: the
 * browser hands back `""` for anything it cannot read as a number, so no NaN
 * can be produced here.
 */
export const numberFieldComponent = createEntityComponent(
  numberEntity,
  ({ entity, setValue, validateValue }) => {
    const { mode } = useFieldRuntime();
    const controlId = controlIdFor(entity.id);
    const error = fieldErrorMessage(entity.error);

    return (
      <FieldShell
        controlId={controlId}
        label={entity.attributes.label}
        helpText={entity.attributes.helpText}
        required={entity.attributes.required}
        error={error}
      >
        <Input
          id={controlId}
          type="number"
          disabled={mode === "builder"}
          aria-invalid={error ? true : undefined}
          value={entity.value === undefined ? "" : String(entity.value)}
          onChange={(event) => {
            const raw = event.target.value;
            setValue(raw === "" ? "" : Number(raw));
            revalidateIfShowing(entity.error, validateValue);
          }}
        />
      </FieldShell>
    );
  },
);

/**
 * The map both hosts render through.
 *
 * Keyed by the eight `vizserve_pms_field_type` values verbatim — the same names
 * `entities.ts` declares — so the projection between rows and schema stays
 * one-to-one and no stored data is renamed.
 */
export const fieldComponents: EntitiesComponents<FormBuilder> = {
  text: textFieldComponent,
  textarea: textareaFieldComponent,
  date: dateFieldComponent,
  select: selectFieldComponent,
  multiselect: multiselectFieldComponent,
  file: fileFieldComponent,
  email: emailFieldComponent,
  number: numberFieldComponent,
};

// ---------------------------------------------------------------------------
// The attribute editors.
// ---------------------------------------------------------------------------

/**
 * ⚠️ `BuilderEntityAttributes`'s map is keyed by ENTITY NAME, not by attribute
 * name — measured in the shipped `dist`, where it renders
 * `components[entity.type]({})` inside a context provider. So the components
 * below are the attribute EDITORS, and the map at the bottom of the file names
 * which panel each field type gets.
 *
 * `archived` deliberately has no editor. Archiving is a decision about the FORM
 * — "this question is retired, keep the answers" — and it is taken from the
 * field list's own Archive/Restore buttons, which is where it was before and
 * where somebody looking for it will look. A control for it inside the field's
 * own editor would be a second way to do the same thing, two clicks deeper.
 */

const attributeErrorText = (error: unknown) => fieldErrorMessage(error);

const LabelAttribute = createAttributeComponent(
  labelAttribute,
  ({ attribute, entity, setValue, validateValue }) => {
    const controlId = `attr-label-${entity.id}`;
    const error = attributeErrorText(attribute.error);

    return (
      <div className="min-w-0 space-y-1.5">
        {/* "Question", not "Label". The person using this is writing a form, and
            the thing they are typing is the question. "Label" is what the
            attribute is called in the schema, which is nobody's business here. */}
        <Label htmlFor={controlId}>Question</Label>
        <Input
          id={controlId}
          value={attribute.value}
          placeholder="What are you asking?"
          aria-invalid={error ? true : undefined}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void validateValue()}
        />
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);

/**
 * ⚠️ THERE IS NO KEY INPUT ANY MORE, AND ITS ABSENCE IS THE FEATURE.
 *
 * `field_key` is the storage identity every stored answer is filed under (§1).
 * It was a text box, on every question, asking whoever was writing a survey to
 * invent a unique lower-case identifier they would never see again — and one
 * they could not change afterwards, because `vizserve_pms_form_field_protect`
 * refuses to rename a key with data behind it.
 *
 * `deriveFieldKeys` now mints it from the label and de-duplicates it against
 * every key on the form, ARCHIVED ONES INCLUDED, immediately before each save.
 * The editor states what it will be, in a sentence, so the fact is not hidden —
 * only the box is gone.
 *
 * `keyAttribute` still validates, and is still what refuses a malformed key
 * arriving from a hand-edited blob. Nothing about the rule changed; what changed
 * is who answers it.
 */

const HelpTextAttribute = createAttributeComponent(
  helpTextAttribute,
  ({ attribute, entity, setValue }) => {
    const controlId = `attr-help-${entity.id}`;

    return (
      <div className="space-y-1.5">
        <Label htmlFor={controlId}>Help text (optional)</Label>
        <Input
          id={controlId}
          value={attribute.value}
          placeholder="Shown under the question"
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
    );
  },
);

/**
 * A switch beside the question, not a bordered card under it.
 *
 * The paragraph that used to be here ("Required is the default. Every optional
 * field is a question the team will end up chasing.") was three lines of advice
 * on a control that is toggled once and understood immediately. It made the
 * required flag the largest thing in the editor.
 */
const RequiredAttribute = createAttributeComponent(
  requiredAttribute,
  ({ attribute, entity, setValue }) => {
    const controlId = `attr-required-${entity.id}`;

    return (
      <div className="shrink-0 space-y-1.5">
        <Label htmlFor={controlId}>Required</Label>
        {/* `h-9` matches the Input beside it, so the switch sits on the control
            line rather than floating above it. */}
        <div className="flex h-9 items-center">
          <Switch id={controlId} checked={attribute.value} onCheckedChange={setValue} />
        </div>
      </div>
    );
  },
);

/**
 * P7-66 — ONE ROW PER CHOICE, INLINE, UNDER THE ANSWER TYPE.
 *
 * ⚠️ IT WAS A ONE-PER-LINE TEXTAREA AND THAT IS WHAT IT STOPPED BEING. The
 * textarea worked, after two bugs were fixed in it, and it still asked somebody
 * to hold "one option per line" in their head while typing something that
 * renders as a list of radio buttons six inches to the right. Rows are what the
 * thing IS: one control per choice, a remove button on each, and an add button
 * under them.
 *
 * ⚠️ NO DRAFT STATE, AND IT DOES NOT NEED ONE. The textarea kept a raw draft
 * separate from the normalised store because it normalised the WHOLE list on
 * every keystroke — which ate a typed space and made a second option
 * unreachable. Here each row is its own input bound to its own element, so a
 * keystroke replaces one entry and touches nothing else. There is no
 * normalisation to fight.
 *
 * ⚠️ AN EMPTY ROW IS KEPT, NOT DROPPED. `optionsAttribute` refuses `""`, so a
 * document holding one cannot be saved — and `unsavableReason` says exactly
 * that, naming the row. Dropping it instead would delete, mid-keystroke and with
 * no way back, a choice somebody had just cleared in order to retype it.
 *
 * ⚠️ THE LAST ROW CANNOT BE REMOVED. A choice field with no choices is a
 * question that cannot be answered, and `validateSchema` refuses it. Changing
 * the answer type is the way to stop having choices, which is a decision rather
 * than an accident.
 */
const OptionsAttribute = createAttributeComponent(
  optionsAttribute,
  ({ attribute, entity, setValue, validateValue }) => {
    const error = attributeErrorText(attribute.error);
    const options = attribute.value;

    // Round for "choose one", square for "choose many" — the same shape the
    // respondent will see, so the editor looks like what it configures.
    const round = entity.type === "select";

    function replace(index: number, value: string) {
      setValue(options.map((option, at) => (at === index ? value : option)));
    }

    return (
      <div className="space-y-1.5">
        <Label>Choices</Label>

        <ul className="space-y-1.5">
          {options.map((option, index) => (
            // The index IS the identity here: choices have no id of their own,
            // and keying by value makes two rows with the same text collide and
            // makes every row remount as it is typed into.
            <li key={index} className="flex items-center gap-2.5">
              <span
                aria-hidden
                className={cn(
                  "size-4 shrink-0 border-1.5 border-border-strong",
                  round ? "rounded-full" : "rounded-xs",
                )}
              />
              <Input
                value={option}
                aria-label={`Choice ${index + 1}`}
                aria-invalid={error ? true : undefined}
                className="h-9 border-0 border-b border-transparent bg-transparent px-0.5 shadow-none hover:border-border focus-visible:border-primary focus-visible:ring-0"
                onChange={(event) => replace(index, event.target.value)}
                onBlur={() => void validateValue()}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                // The only choice left is the one that makes the question
                // answerable. See the note above.
                disabled={options.length <= 1}
                aria-label={`Remove choice ${index + 1}`}
                onClick={() => setValue(options.filter((_, at) => at !== index))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-6.5"
          onClick={() => setValue([...options, nextOptionLabel(options)])}
        >
          <Plus />
          Add choice
        </Button>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);

/**
 * P7-66 — THE ATTRIBUTES COME IN TWO PANELS, BECAUSE THE ANSWER TYPE SITS
 * BETWEEN THEM.
 *
 * The editor reads: the question and whether it is required, then the answer
 * type, then the choices that type may have, then the help text. The type is not
 * an attribute — the library has no `setEntityType` at all (see
 * `replaceFieldType`) — so it cannot be one more entry in a single ordered map.
 *
 * Two maps, therefore, rendered either side of a control the app owns. That is
 * the only way to get the mockup's order without moving the type control to the
 * top or the bottom, and both of those were tried on paper: at the top it reads
 * as the most important decision on the screen, which it is not; at the bottom
 * the choices it governs appear above it.
 *
 * Everything else about the library's plumbing is unchanged — each panel is a
 * real `BuilderEntityAttributes` render, so per-attribute validation and the
 * error under each input work exactly as they did.
 */
function HeadAttributes() {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <LabelAttribute />
      </div>
      <RequiredAttribute />
    </div>
  );
}

function TextBodyAttributes() {
  return <HelpTextAttribute />;
}

function ChoiceBodyAttributes() {
  return (
    <div className="space-y-3.5">
      <OptionsAttribute />
      <HelpTextAttribute />
    </div>
  );
}

/** The question and its required flag. Same panel for every type. */
export const fieldHeadAttributeComponents: EntitiesAttributesComponents<FormBuilder> = {
  text: HeadAttributes,
  textarea: HeadAttributes,
  date: HeadAttributes,
  select: HeadAttributes,
  multiselect: HeadAttributes,
  file: HeadAttributes,
  email: HeadAttributes,
  number: HeadAttributes,
};

/**
 * What follows the answer type.
 *
 * Only `select` and `multiselect` carry a choices editor — an empty "Choices"
 * box on a text field was the one thing the old builder got right by hiding it,
 * and `formBuilder.validateSchema` refuses to save an option-less choice field,
 * so the rows have to be there for exactly those two.
 */
export const fieldBodyAttributeComponents: EntitiesAttributesComponents<FormBuilder> = {
  text: TextBodyAttributes,
  textarea: TextBodyAttributes,
  date: TextBodyAttributes,
  select: ChoiceBodyAttributes,
  multiselect: ChoiceBodyAttributes,
  file: TextBodyAttributes,
  email: TextBodyAttributes,
  number: TextBodyAttributes,
};

// ---------------------------------------------------------------------------
// The React bindings.
// ---------------------------------------------------------------------------

/**
 * ⚠️ EVERY `@coltorapps/builder-react` BINDING IS RE-EXPOSED FROM HERE, and
 * that is not tidiness — it is the containment rule from risk 1 of the plan.
 * `grep -r "@coltorapps" app components` must return nothing, so the builder
 * screen and the public form cannot import the hooks, the components OR the
 * types directly. Everything they need is a wrapper below, in this file's
 * vocabulary rather than the library's.
 *
 * The wrappers are thin on purpose. Each one exists because a call site would
 * otherwise have to name a library type (`BuilderStoreData`,
 * `SchemaValidationErrorReason`, `InternalBuilderStoreEntity`) to write the
 * call at all.
 */

export type FormBuilderStore = BuilderStore<FormBuilder>;
export type FormInterpreterStore = InterpreterStore<FormBuilder>;

/** The builder store, opened on a schema the loader has already reconciled. */
export function useFormBuilderStore(initialSchema: FormSchema): FormBuilderStore {
  // `initialData` is read ONCE, when the store is created — the hook memoises on
  // the builder alone (measured in the shipped `dist`). So this is the opening
  // document, not a controlled value: a later prop change does not reach the
  // store, which is what stops a `router.refresh()` from throwing away an edit
  // somebody is in the middle of making.
  return useBuilderStore(formBuilder, { initialData: { schema: initialSchema } });
}

/** The store's live schema, re-read on every change it publishes. */
export function useFormBuilderSchema(builderStore: FormBuilderStore): FormSchema {
  return useBuilderStoreData(builderStore).schema;
}

/** One field, rendered as the disabled preview described at the top of this file. */
export function FieldPreview({
  builderStore,
  entityId,
}: {
  builderStore: FormBuilderStore;
  entityId: string;
}) {
  return (
    <BuilderEntity
      entityId={entityId}
      components={fieldComponents}
      builderStore={builderStore}
    />
  );
}

/** The question and its required flag — everything ABOVE the answer type. */
export function FieldHeadAttributes({
  builderStore,
  entityId,
}: {
  builderStore: FormBuilderStore;
  entityId: string;
}) {
  return (
    <BuilderEntityAttributes
      builderStore={builderStore}
      entityId={entityId}
      components={fieldHeadAttributeComponents}
    />
  );
}

/** The choices and the help text — everything BELOW the answer type. */
export function FieldBodyAttributes({
  builderStore,
  entityId,
}: {
  builderStore: FormBuilderStore;
  entityId: string;
}) {
  return (
    <BuilderEntityAttributes
      builderStore={builderStore}
      entityId={entityId}
      components={fieldBodyAttributeComponents}
    />
  );
}

/**
 * Adds a field and returns its id.
 *
 * ⚠️ ALL SIX ATTRIBUTES ARE WRITTEN, including the ones this type has no use
 * for. Every entity in entities.ts DECLARES all six, and the library refuses a
 * schema carrying an attribute the entity does not declare
 * (`UnknownEntityAttributeType`) — but it equally refuses one that is MISSING an
 * attribute (`MissingEntityAttributes`), so a `text` field written without
 * `options` would be a form that could not be opened again. The same six the
 * migration's backfill writes on every row.
 *
 * The empty `key` and `label` are why an added field is not saved immediately:
 * `keyAttribute` and `labelAttribute` both refuse them, which is exactly the
 * "fill this in before it is a field" the editor then asks for.
 */
export function addFieldEntity(
  builderStore: FormBuilderStore,
  type: FieldType,
  index?: number,
): string {
  const entity = builderStore.addEntity({
    type,
    attributes: { key: "", label: "", helpText: "", required: true, options: [], archived: false },
    index,
  });

  return entity.id;
}

/**
 * P7-66 — CHANGING A QUESTION'S ANSWER TYPE, WHICH THE LIBRARY CANNOT DO.
 *
 * ⚠️ THERE IS NO `setEntityType`. Verified in `@coltorapps/builder`'s own
 * `.d.ts`: the store exposes `addEntity`, `deleteEntity`, `setEntityIndex`,
 * `setEntityAttribute`, `cloneEntity` and nothing that mutates `type`. An
 * entity's type is fixed at creation, so a change is a DELETE and an ADD — which
 * is exactly what it is in the database too, since the entity id IS the
 * `vizserve_pms_form_fields` row id.
 *
 * That equivalence is the reason this is safe to offer at all and the reason it
 * has to be refused once answers exist: `vizserve_pms_form_field_protect`
 * refuses to drop a field that has data, so a type change on an answered
 * question is a save that Postgres rejects. The editor disables the control
 * there; this function is what the control drives when it is allowed.
 *
 * ⚠️ IT LANDS AT THE SAME INDEX. Without that, changing question 2 from Short
 * text to Long text moves it to the bottom of the form — the delete removes it
 * and the add appends. The index is read BEFORE the delete, because after it
 * every position past this one has shifted.
 *
 * ⚠️ THE ATTRIBUTES COME ACROSS, INCLUDING `key`. The label, the help text, the
 * required flag and the archived flag all describe the QUESTION rather than its
 * control, and losing them would make a type change feel like starting over. The
 * key travels for a different reason: it is only ever editable on a field that
 * has never been saved, so this either carries a derived key that is about to be
 * re-derived anyway, or one the caller has already decided is free.
 *
 * `options` are kept when the new type can use them and dropped when it cannot,
 * so Choose one → Choose many keeps the list somebody typed, and Choose one →
 * Short text does not leave three orphan choices in the document for
 * `optionsAttribute` to carry around.
 *
 * Returns the NEW entity id: the old one is gone, and every caller has a
 * selection pointing at it.
 */
export function replaceFieldType(
  builderStore: FormBuilderStore,
  entityId: string,
  type: FieldType,
): string | null {
  const schema = builderStore.getSchema();

  if (!Object.hasOwn(schema.entities, entityId)) return null;

  const previous = schema.entities[entityId]!;
  const index = schema.root.indexOf(entityId);

  const keepsOptions = type === "select" || type === "multiselect";

  builderStore.deleteEntity(entityId);

  const entity = builderStore.addEntity({
    type,
    attributes: {
      ...previous.attributes,
      options: keepsOptions ? previous.attributes.options : [],
    },
    // `-1` cannot happen — the id came out of `root` — but `addEntity` would
    // read it as "insert at the end from the right", so it is normalised rather
    // than trusted.
    index: index < 0 ? undefined : index,
  });

  return entity.id;
}

/**
 * P7-66 — DUPLICATE, AND THE ID THE LIBRARY DOES NOT HAND BACK.
 *
 * `cloneEntity` returns `void`. It inserts the copy directly after the original
 * (measured in the shipped `dist`: `index: getIndex(entityId) + 1`), which is
 * exactly where a duplicate belongs — but the caller needs the new id to select
 * it, and the only way to learn it is to look at what appeared.
 *
 * ⚠️ THE COPY'S KEY IS CLEARED, AND THIS IS NOT COSMETIC. `cloneEntity` copies
 * every attribute verbatim, `key` included — so an unguarded duplicate produces
 * two fields sharing one storage identity, which `formBuilder.validateSchema`
 * refuses ("Two fields share the key …") and which would file two questions'
 * answers in one place if it did not. Blanking it hands the copy back to
 * `deriveFieldKeys`, which mints a fresh one from the label and de-duplicates it
 * against every key already in use, archived ones included.
 *
 * The label is deliberately NOT changed. "Which pages are affected?" duplicated
 * as "Which pages are affected? (copy)" is a question somebody now has to edit
 * twice — once to say what they meant, once to remove the word "copy". The two
 * rows sit adjacent and numbered, so which is which is not in doubt.
 */
export function cloneFieldEntity(
  builderStore: FormBuilderStore,
  entityId: string,
): string | null {
  const before = new Set(builderStore.getSchema().root);

  builderStore.cloneEntity(entityId);

  const added = builderStore.getSchema().root.find((id) => !before.has(id));

  if (added === undefined) return null;

  builderStore.setEntityAttribute(added, "key", "");

  return added;
}

/**
 * Puts the store back on a known schema — the last one the database accepted.
 *
 * Used for Cancel and for a rejected save. The attribute errors and the schema
 * error go with it: they described the document being discarded, and leaving
 * them behind would mark fields that no longer say what the message claims.
 */
export function resetBuilderStore(builderStore: FormBuilderStore, schema: FormSchema): void {
  builderStore.setData({ schema, entitiesAttributesErrors: {}, schemaError: undefined });
}

/**
 * Runs the builder's own rules and turns a rejection into one sentence.
 *
 * ⚠️ IT ALSO WRITES THE ERRORS INTO THE STORE — that is `validateSchema`'s
 * documented side effect, and it is what makes the message beside the key input
 * appear. So this is not a predicate to call speculatively: call it when
 * somebody has asked to save.
 *
 * `InvalidSchema` wraps whatever `formBuilder.validateSchema` threw, and those
 * messages were written to be read ("Two fields share the key …"). The other
 * branch is `InvalidEntitiesAttributes`, where the detail is already sitting
 * against the individual inputs, so the summary only has to point at them.
 */
export async function validateBuilderSchema(
  builderStore: FormBuilderStore,
): Promise<{ ok: true; schema: FormSchema } | { ok: false; message: string }> {
  const result = await builderStore.validateSchema();

  if (result.success) return { ok: true, schema: result.data };

  if (
    result.reason.code === "InvalidSchema" &&
    result.reason.payload.schemaError instanceof Error
  ) {
    return { ok: false, message: result.reason.payload.schemaError.message };
  }

  return { ok: false, message: "Check the highlighted fields." };
}

/**
 * What an untouched form starts with, keyed by ENTITY ID.
 *
 * The values the old renderer put in `react-hook-form`'s `defaultValues`,
 * unchanged: `[]` for the two collection types and `""` for everything else. Not
 * `undefined` — an input whose value goes from `undefined` to a string is an
 * uncontrolled input becoming controlled, which React warns about and which
 * loses the first keystroke.
 *
 * `initialEntitiesValuesWithDefaults` is the library's own version of this and
 * is not used: it reads each entity's `defaultValue`, and ours deliberately
 * declare none — a default answer on a client's request form is an answer
 * nobody gave.
 */
export function initialEntityValues(schema: FormSchema): EntitiesValues<FormBuilder> {
  return Object.fromEntries(
    Object.entries(schema.entities).map(([entityId, entity]) => [
      entityId,
      entity.type === "multiselect" || entity.type === "file" ? [] : "",
    ]),
  );
}

/**
 * The interpreter store — the second of the public form's two state owners.
 *
 * ⚠️ `schema` MUST BE REFERENTIALLY STABLE. The hook memoises the store on
 * `[builder, schema]`, so a schema rebuilt on every render rebuilds the store on
 * every render and every answer typed into it is discarded. The caller holds it
 * in a `useMemo`.
 */
export function useFormInterpreterStore(
  schema: FormSchema,
  initialValues: EntitiesValues<FormBuilder>,
): FormInterpreterStore {
  return useInterpreterStore(formBuilder, schema, {
    initialData: { entitiesValues: initialValues },
  });
}

/**
 * Every field of the form, live.
 *
 * `InterpreterEntities` returns an ARRAY rather than an element — it renders one
 * component per root entity and nothing around them — so this wrapper exists to
 * give the call site something it can put in a `<fieldset>` beside the fixed
 * fields.
 */
export function InterpreterFields({
  interpreterStore,
}: {
  interpreterStore: FormInterpreterStore;
}) {
  return (
    <>
      <InterpreterEntities interpreterStore={interpreterStore} components={fieldComponents} />
    </>
  );
}
