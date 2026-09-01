"use client";

import { createContext, useContext, useState } from "react";
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
  keyAttribute,
  labelAttribute,
  normaliseOptionsText,
  optionsAttribute,
  requiredAttribute,
  FIELD_KEY_MESSAGE,
} from "@/lib/form-builder/attributes";
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
      <div className="space-y-2">
        <Label htmlFor={controlId}>Label</Label>
        <Input
          id={controlId}
          value={attribute.value}
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
 * ⚠️ THE KEY IS THE STORAGE IDENTITY (§1), AND IT LOCKS ONCE THE FIELD EXISTS.
 *
 * Every answer in `vizserve_pms_requests.field_values` is filed under it, and
 * renaming one that has data is refused by `vizserve_pms_form_field_protect` in
 * Postgres — the front end will be bypassed, so this input being disabled is a
 * courtesy, not the rule. A field being ADDED has no row and no answers yet, so
 * its key is still open.
 */
const KeyAttribute = createAttributeComponent(
  keyAttribute,
  ({ attribute, entity, setValue, validateValue }) => {
    const { lockedEntityIds } = useFieldRuntime();
    const controlId = `attr-key-${entity.id}`;
    const locked = lockedEntityIds?.has(entity.id) ?? false;
    const error = attributeErrorText(attribute.error);

    return (
      <div className="space-y-2">
        <Label htmlFor={controlId}>Field key</Label>
        <Input
          id={controlId}
          value={attribute.value}
          disabled={locked}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void validateValue()}
        />
        <p className="text-xs text-muted-foreground">
          {locked
            ? "Fixed — existing requests store their answers under this key."
            : `Used to store answers, and fixed once saved. Leave it blank to derive one from the label. ${FIELD_KEY_MESSAGE}`}
        </p>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);

const HelpTextAttribute = createAttributeComponent(
  helpTextAttribute,
  ({ attribute, entity, setValue }) => {
    const controlId = `attr-help-${entity.id}`;

    return (
      <div className="space-y-2">
        <Label htmlFor={controlId}>Helper text</Label>
        <Input
          id={controlId}
          value={attribute.value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
    );
  },
);

const RequiredAttribute = createAttributeComponent(
  requiredAttribute,
  ({ attribute, entity, setValue }) => {
    const controlId = `attr-required-${entity.id}`;

    return (
      <div className="flex items-center justify-between gap-4 rounded-sm border bg-background p-3">
        <div>
          <Label htmlFor={controlId}>Required</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Required is the default. Every optional field is a question the team will end up
            chasing.
          </p>
        </div>
        <Switch id={controlId} checked={attribute.value} onCheckedChange={setValue} />
      </div>
    );
  },
);

/**
 * One option per line, exactly as the old builder took them.
 *
 * ⚠️ TRIMMED AND EMPTIES DROPPED ON THE WAY IN, never on the way out. An option
 * is a stored VALUE — `selectEntity` builds `z.enum(options)` from this list and
 * accepts an answer only if it matches one exactly — so rewriting one that is
 * already stored moves the accepted set away from the stored set and a
 * historical answer stops validating. `optionsAttribute` therefore preserves
 * whatever it is given; the cleaning belongs here, at the moment somebody types
 * a new list, which is what `formFieldDraftSchema.options` did before.
 *
 * ⚠️ TYPING AND NORMALISING ARE TWO DIFFERENT MOMENTS, AND THIS IS WHY THERE IS
 * A SECOND PIECE OF STATE.
 *
 * The textarea used to be driven straight off `attribute.value.join("\n")` while
 * `onChange` normalised every keystroke into the store. That is a controlled
 * input that rewrites what you type as you type it: Enter after `Poster`
 * produced `["Poster"]`, which re-rendered as `Poster` with the newline gone, so
 * a SECOND OPTION COULD NEVER BE ENTERED — and the space in `Social media` was
 * eaten the instant it was pressed, so a multi-word option was impossible too.
 * The editor was unusable on arrival, and it is the only way to configure a
 * `select`.
 *
 * So `draft` is what somebody is typing, verbatim, and it is the only thing the
 * textarea shows. `normaliseOptionsText` decides what is STORED, and it still
 * runs on every keystroke — the store therefore never holds a half-typed line,
 * and a save that lands without an intervening blur is as correct as one that
 * follows one. The blur tidies the visible text to match.
 *
 * The reconciliation below is the standard "adjust state when a prop changes"
 * pattern, and it exists for `resetBuilderStore`: a refused save puts the store
 * back on the last saved schema WITHOUT unmounting this editor, and a draft left
 * showing the rejected list would be a lie about what the form now holds. It
 * compares NORMALISED to stored, so it cannot fire on the trailing newline or
 * the mid-word space that are the whole point of keeping a draft.
 */
const OptionsAttribute = createAttributeComponent(
  optionsAttribute,
  ({ attribute, entity, setValue, validateValue }) => {
    const controlId = `attr-options-${entity.id}`;
    const error = attributeErrorText(attribute.error);
    const stored = attribute.value.join("\n");

    const [draft, setDraft] = useState(stored);
    const [lastStored, setLastStored] = useState(stored);

    if (stored !== lastStored) {
      setLastStored(stored);
      if (stored !== normaliseOptionsText(draft).join("\n")) setDraft(stored);
    }

    return (
      <div className="space-y-2">
        <Label htmlFor={controlId}>Options</Label>
        <Textarea
          id={controlId}
          rows={4}
          aria-invalid={error ? true : undefined}
          value={draft}
          placeholder={"Poster\nBanner\nSocial media set"}
          onChange={(event) => {
            setDraft(event.target.value);
            setValue(normaliseOptionsText(event.target.value));
          }}
          onBlur={() => {
            setDraft(normaliseOptionsText(draft).join("\n"));
            void validateValue();
          }}
        />
        <p className="text-xs text-muted-foreground">One per line.</p>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);

function TextAttributes() {
  return (
    <div className="space-y-4">
      <LabelAttribute />
      <KeyAttribute />
      <HelpTextAttribute />
      <RequiredAttribute />
    </div>
  );
}

function ChoiceAttributes() {
  return (
    <div className="space-y-4">
      <LabelAttribute />
      <KeyAttribute />
      <HelpTextAttribute />
      <OptionsAttribute />
      <RequiredAttribute />
    </div>
  );
}

/**
 * Which panel each field type gets.
 *
 * Only `select` and `multiselect` carry an options editor — showing an empty
 * "Options" box on a text field was the one thing the old builder got right by
 * hiding it, and `formBuilder.validateSchema` refuses to save an option-less
 * choice field, so the box has to be there for exactly those two.
 */
export const fieldAttributeComponents: EntitiesAttributesComponents<FormBuilder> = {
  text: TextAttributes,
  textarea: TextAttributes,
  date: TextAttributes,
  select: ChoiceAttributes,
  multiselect: ChoiceAttributes,
  file: TextAttributes,
  email: TextAttributes,
  number: TextAttributes,
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

/** One field's attribute editors. */
export function FieldAttributesEditor({
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
      components={fieldAttributeComponents}
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
