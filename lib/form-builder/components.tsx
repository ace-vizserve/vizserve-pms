"use client";

import { createContext, useContext, useMemo } from "react";
import { Plus, X } from "lucide-react";
import type { BuilderStore, EntitiesValues, InterpreterStore } from "@coltorapps/builder";
import {
  BuilderEntity,
  BuilderEntityAttributes,
  InterpreterEntities,
  InterpreterEntity,
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
import {
  isDisplayOnly,
  nextOptionLabel,
  paginateFields,
  safeImageUrl,
  youtubeEmbedUrl,
  type FormPage,
} from "@/lib/form-builder/canvas";
import { formBuilder, type FormBuilder, type FormSchema } from "@/lib/form-builder/builder";
import {
  dateEntity,
  emailEntity,
  fileEntity,
  multiselectEntity,
  imageEntity,
  numberEntity,
  sectionEntity,
  selectEntity,
  textareaEntity,
  textEntity,
  youtubeEntity,
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
 * P7-66 Phase 7 — THE PAGE BREAK, AS THE RESPONDENT SEES IT.
 *
 * ⚠️ NO `FieldShell`, AND NO `controlId`. Every other component here wraps a
 * control in a `<label>`-for-an-input shell; a section has no control, so a
 * label pointing at nothing would be a broken association announced by every
 * screen reader that met it. It is a heading and a paragraph.
 *
 * ⚠️ IT DRAWS THE TITLE EVEN THOUGH THE PAGE IS ALREADY SPLIT ON IT. The split
 * is the host's job — `sectionsOf` in `lib/form-builder/canvas.ts` and the two
 * paged renderers — and a heading at the top of a page is the only thing that
 * says WHICH page you are on. The host renders one section's worth of entities
 * and this is the first of them.
 *
 * `h2` because the form's name is the `h1` on both hosts.
 */
export const sectionFieldComponent = createEntityComponent(
  sectionEntity,
  ({ entity }) => {
    const title = entity.attributes.label.trim();
    const blurb = entity.attributes.helpText.trim();

    return (
      <div className="space-y-1 border-b pb-3">
        {/* An untitled break is a real state on the canvas — the question is
            added before it is named — so the preview says so rather than
            rendering an empty heading with a rule under it. */}
        <h2 className="text-base font-semibold tracking-tight text-pretty">
          {title === "" ? "Untitled page" : title}
        </h2>
        {blurb === "" ? null : (
          <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{blurb}</p>
        )}
      </div>
    );
  },
);

/**
 * P7-66 Phase 9 — A PICTURE IN THE MIDDLE OF A FORM.
 *
 * ⚠️ `alt` IS THE LABEL, AND IT IS NEVER EMPTY. `labelAttribute` refuses a blank
 * one, so an image cannot reach a respondent without a description — WCAG 2.2 AA
 * 1.1.1 delivered by a rule that exists for another reason entirely (the label
 * is what `field_key` is derived from).
 *
 * ⚠️ A BAD URL SAYS SO RATHER THAN DRAWING A BROKEN IMAGE. `safeImageUrl`
 * refuses anything that is not http(s) — `javascript:` and `data:` are both
 * strings that look like links — and the fallback is a visible note, because a
 * silent gap in a form reads as a fault in the form.
 *
 * ⚠️ PLAIN `<img>`, NOT `next/image`. The URL is arbitrary and supplied at
 * runtime by whoever built the form; `next/image` would need every one of those
 * hosts in `remotePatterns` at BUILD time, so the optimiser would reject exactly
 * the links people paste. `loading="lazy"` is the part worth keeping.
 */
export const imageFieldComponent = createEntityComponent(imageEntity, ({ entity }) => {
  const src = safeImageUrl(entity.attributes.options[0] ?? "");
  const caption = entity.attributes.helpText.trim();

  if (src === null) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        This image has no usable link yet.
      </p>
    );
  }

  return (
    <figure className="space-y-1.5">
      {/* eslint-disable-next-line @next/next/no-img-element -- see the note above */}
      <img
        src={src}
        alt={entity.attributes.label}
        loading="lazy"
        className="max-h-96 w-full rounded-md border object-contain"
      />
      {caption === "" ? null : (
        <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
      )}
    </figure>
  );
});

/**
 * P7-66 Phase 9 — A VIDEO TO WATCH BEFORE ANSWERING.
 *
 * ⚠️ THE `src` IS CONSTRUCTED, NEVER THE PASTED STRING. `youtubeEmbedUrl`
 * extracts eleven characters matching `[A-Za-z0-9_-]{11}` and builds the URL
 * from a fixed prefix, so nothing a person pastes can carry a scheme, a host or
 * a query into the frame. Framing a watch page does not work anyway.
 *
 * ⚠️ `title` IS THE LABEL, AND IT IS REQUIRED FOR THE SAME REASON `alt` IS. An
 * iframe with no accessible name is announced as "frame" and nothing else
 * (WCAG 2.2 AA 4.1.2).
 *
 * `youtube-nocookie.com` — the same video, without the tracking cookie set
 * before anybody presses play. `allowFullScreen` and no `allow="autoplay"`: a
 * form that starts making noise on load is a form people close.
 */
export const youtubeFieldComponent = createEntityComponent(youtubeEntity, ({ entity }) => {
  const src = youtubeEmbedUrl(entity.attributes.options[0] ?? "");
  const caption = entity.attributes.helpText.trim();

  if (src === null) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        This does not look like a YouTube link yet.
      </p>
    );
  }

  return (
    <figure className="space-y-1.5">
      <div className="aspect-video w-full overflow-hidden rounded-md border">
        <iframe
          src={src}
          title={entity.attributes.label}
          loading="lazy"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="size-full"
        />
      </div>
      {caption === "" ? null : (
        <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
      )}
    </figure>
  );
});

/**
 * The map both hosts render through.
 *
 * Keyed by the `vizserve_pms_field_type` values verbatim — the same names
 * `entities.ts` declares — so the projection between rows and schema stays
 * one-to-one and no stored data is renamed.
 *
 * ⚠️ `section` IS IN HERE AND DRAWS A HEADING, NOT A CONTROL. Its entity is
 * `shouldBeProcessed: () => false`, so the interpreter never asks it for a
 * value — but the library still needs a component for every declared entity,
 * and the respondent still needs to see where a page begins. It renders the
 * title and its blurb, and nothing that can be typed into.
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
  section: sectionFieldComponent,
  image: imageFieldComponent,
  youtube: youtubeFieldComponent,
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

/**
 * What the label box is CALLED, per field type.
 *
 * ⚠️ IT IS ONE COLUMN DOING FOUR JOBS, AND THE SCREEN HAS TO SAY WHICH.
 * `label` is the question on a question, the heading on a page break, the ALT
 * TEXT on an image and the accessible TITLE on a video. The last two are the
 * ones worth being explicit about: they are required by WCAG 2.2 AA, and they
 * are delivered for free because `labelAttribute` already refuses a blank —
 * but only if the person filling the box knows that is what they are writing.
 * "Question / What are you asking?" over the alt text of a photograph produces
 * alt text that reads like a question.
 */
const LABEL_WORDING: Record<string, { label: string; placeholder: string }> = {
  section: { label: "Section title", placeholder: "What is this page called?" },
  image: { label: "Image description", placeholder: "What does the picture show?" },
  youtube: { label: "Video title", placeholder: "What is the video about?" },
  default: { label: "Question", placeholder: "What are you asking?" },
};

const LabelAttribute = createAttributeComponent(
  labelAttribute,
  ({ attribute, entity, setValue, validateValue }) => {
    const controlId = `attr-label-${entity.id}`;
    const error = attributeErrorText(attribute.error);

    /*
     * ⚠️ P7-66 Phase 7 — A SECTION IS NOT A QUESTION, AND THIS BOX MUST NOT
     * ASK LIKE ONE. `label` is the same column either way, but "Question /
     * What are you asking?" over the box that names a page break is the screen
     * telling somebody they are doing something they are not. The heading of
     * the new section is what they are typing.
     */
    const naming = LABEL_WORDING[entity.type] ?? LABEL_WORDING.default!;

    return (
      <div className="min-w-0 space-y-1.5">
        {/* "Question", not "Label". The person using this is writing a form, and
            the thing they are typing is the question. "Label" is what the
            attribute is called in the schema, which is nobody's business here. */}
        <Label htmlFor={controlId}>{naming.label}</Label>
        <Input
          id={controlId}
          value={attribute.value}
          placeholder={naming.placeholder}
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
    // Same column, same control, different thing being written. See
    // `LabelAttribute`.
    // A caption under a picture, a blurb under a heading, help under a question:
    // one column, and the word for it differs.
    const shown = isDisplayOnly(entity.type);

    return (
      <div className="space-y-1.5">
        <Label htmlFor={controlId}>
          {shown ? "Caption (optional)" : "Help text (optional)"}
        </Label>
        <Input
          id={controlId}
          value={attribute.value}
          placeholder={shown ? "Shown underneath" : "Shown under the question"}
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
/**
 * P7-66 Phase 9 — THE MEDIA URL, WHICH IS `options[0]` DRAWN AS ONE BOX.
 *
 * ⚠️ IT WRITES A ONE-ENTRY ARRAY, ALWAYS. The column holds an array and
 * `vizserve_pms_form_fields_media_has_a_source` requires a non-empty one, so a
 * cleared box must write `[""]` rather than `[]` — the empty array is the state
 * the database refuses, and `optionsAttribute` refuses an empty STRING, which is
 * what makes "you have not filled this in" a per-attribute error the editor
 * shows rather than a save that fails.
 *
 * ⚠️ AND IT PREVIEWS WHAT IT PARSED, NOT WHAT WAS TYPED. A YouTube link that
 * this does not recognise produces no embed, and the sentence says so — rather
 * than accepting the paste, saving it, and leaving an empty frame in the form
 * for the respondent to find. `youtubeVideoId` is deliberately strict: a Vimeo
 * link quietly becoming a broken YouTube embed is worse than being told it is
 * not a YouTube link.
 */
const MediaUrlAttribute = createAttributeComponent(
  optionsAttribute,
  ({ attribute, entity, setValue, validateValue }) => {
    const controlId = `attr-media-${entity.id}`;
    const error = attributeErrorText(attribute.error);
    const value = attribute.value[0] ?? "";
    const video = entity.type === "youtube";

    // Recognised, or not yet. Empty is neither — the field is simply unfinished,
    // and `unsavableReason` is what says so at the document level.
    const parsed = value.trim() === "" ? null : video ? youtubeEmbedUrl(value) : safeImageUrl(value);

    return (
      <div className="space-y-1.5">
        <Label htmlFor={controlId}>{video ? "YouTube link" : "Image link"}</Label>
        <Input
          id={controlId}
          value={value}
          placeholder={
            video ? "https://www.youtube.com/watch?v=…" : "https://…/picture.jpg"
          }
          aria-invalid={error ? true : undefined}
          onChange={(event) => setValue([event.target.value])}
          onBlur={() => void validateValue()}
        />
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {value.trim() !== "" && parsed === null ? (
          <p className="text-xs text-warning">
            {video
              ? "That is not a YouTube link this can embed. Paste the address from the browser bar on the video's page."
              : "That is not a web address. It needs to start with https://."}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {video
            ? "Shown as a player. The question name above is what a screen reader announces it as."
            : "Shown at full width. The question name above is its alt text — describe what the picture shows."}
        </p>
      </div>
    );
  },
);

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

/** A page break's title, with no required switch beside it. See the map. */
function SectionHeadAttributes() {
  return <LabelAttribute />;
}

/**
 * P7-66 Phase 9 — the media URL, then the caption.
 *
 * ⚠️ IT IS `OptionsAttribute`'S COLUMN, DRAWN AS ONE BOX. The URL lives in
 * `options[0]` so that it round-trips through `vizserve_pms_save_form_schema`
 * with the rest of the field — see the note on `FIELD_TYPES`. Reusing the
 * attribute means the autosave, the dirty tracking and the per-attribute error
 * all work with no new machinery; what it does NOT mean is that a media field
 * should show a list editor with an Add-choice button, which is why this is its
 * own control.
 */
function MediaBodyAttributes() {
  return (
    <div className="space-y-3.5">
      <MediaUrlAttribute />
      <HelpTextAttribute />
    </div>
  );
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
  /*
   * ⚠️ NO REQUIRED SWITCH ON A PAGE BREAK. `HeadAttributes` draws the label and
   * `RequiredAttribute` side by side, and a page break cannot be required —
   * `vizserve_pms_form_fields_section_asks_nothing` refuses the row, so the
   * switch would offer a state the save then rejects. The title alone.
   */
  section: SectionHeadAttributes,
  /* Same as a page break: a title, and no required switch — a picture cannot be
     required, and `vizserve_pms_form_fields_media_asks_nothing` refuses the row
     if it is. What the title MEANS differs, which `LabelAttribute` says. */
  image: SectionHeadAttributes,
  youtube: SectionHeadAttributes,
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
  // The blurb under the section title, which is the same control the help text
  // under a question uses — `help_text` is the column either way.
  section: TextBodyAttributes,
  /* The URL, then the caption. `MediaBodyAttributes` draws both. */
  image: MediaBodyAttributes,
  youtube: MediaBodyAttributes,
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
    attributes: {
      key: "",
      label: "",
      helpText: "",
      /*
       * ⚠️ A SECTION IS NEVER REQUIRED, AND THE DATABASE REFUSES THE ROW IF IT
       * IS. `vizserve_pms_form_fields_section_asks_nothing` — a section has no
       * input, so `submit_request` would read its key as blank and refuse every
       * submission with an error nothing on the page could satisfy. Defaulting
       * to `true` here, as every question does, would make the very first save
       * of a new page break fail on a check constraint.
       */
      required: !isDisplayOnly(type),
      options: [],
      archived: false,
    },
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
      // Same constraint as `addFieldEntity`: turning a question into a page
      // break drops its requiredness with it, or the save is refused.
      required: isDisplayOnly(type) ? false : previous.attributes.required,
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
 * P7-66 Phase 7 — BACK, CONTINUE, AND WHERE YOU ARE.
 *
 * Shared by both hosts so the two paged forms cannot end up with different
 * words, a different button order or a different idea of what "page 2 of 4"
 * counts. The SUBMIT control is passed in rather than drawn here: a client
 * request and an internal answer are different products with different verbs
 * ("Submit request", "Send answer") and different pending states.
 *
 * ⚠️ `type="button"` ON BOTH, WHICH IS NOT A DETAIL. Inside a `<form>` a
 * button with no type is a SUBMIT button — Continue would submit the form from
 * page one, and on the public form that is a half-empty request with a reference
 * number. The submit control the caller passes is the only thing here that may
 * be `type="submit"`, and it is only rendered on the last page.
 *
 * ⚠️ THE COUNT IS ANNOUNCED, NOT JUST DRAWN. `aria-live="polite"` on the
 * position, because moving between pages changes nothing that a screen reader
 * would otherwise report — focus stays where it was and the heading it lands on
 * is inside a region that merely stopped being `hidden`.
 *
 * Nothing is rendered at all for a single-page form: a "Page 1 of 1" and a
 * disabled Back are chrome describing a form that does not page.
 */
export function FormPageNav({
  page,
  pageCount,
  onBack,
  onContinue,
  submit,
}: {
  page: number;
  pageCount: number;
  onBack: () => void;
  onContinue: () => void;
  /** The form's real submit button. Rendered on the last page only. */
  submit: React.ReactNode;
}) {
  if (pageCount <= 1) {
    return <div className="flex justify-end border-t pt-4">{submit}</div>;
  }

  const isLast = page === pageCount - 1;

  return (
    <div className="flex items-center gap-3 border-t pt-4">
      <Button type="button" variant="outline" onClick={onBack} disabled={page === 0}>
        Back
      </Button>

      <p aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
        Page {page + 1} of {pageCount}
      </p>

      <div className="ml-auto">
        {isLast ? (
          submit
        ) : (
          <Button type="button" onClick={onContinue}>
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * P7-66 Phase 7 — THE PAGES THIS FORM SPLITS INTO, AS ENTITY IDS.
 *
 * The single source both live hosts read for "how many pages, and what is on
 * each". The builder's preview reads the same split from the same function
 * (`paginateFields`), one level up, off the builder store — so a preview cannot
 * page a form differently from the way the form pages for the person answering.
 *
 * ⚠️ ARCHIVED ENTITIES DO NOT REACH HERE. `vizserve_pms_get_public_form` and
 * the respond loader both filter `is_active`, so the interpreter's schema is the
 * live form already. If that ever changes, the filter belongs BEFORE this call —
 * an archived page break would split a page in a place the form no longer says
 * to.
 */
export function useFormPages(
  interpreterStore: FormInterpreterStore,
): Array<FormPage<string>> {
  const { schema } = interpreterStore;

  return useMemo(
    () =>
      paginateFields(
        schema.root,
        (entityId) => schema.entities[entityId]?.type === "section",
        (entityId) => {
          const attributes = schema.entities[entityId]?.attributes;
          return {
            title: attributes?.label ?? "",
            blurb: attributes?.helpText ?? "",
          };
        },
      ),
    [schema],
  );
}

/**
 * P7-66 Phase 7 — VALIDATE ONE PAGE, WHICH IS WHAT CONTINUE HAS TO DO.
 *
 * ⚠️ CONTINUE VALIDATES, IT DOES NOT JUST ADVANCE. Without this, a blank
 * required field on page 1 is not reported until Submit on page 4 — at which
 * point the person is three pages away from the thing that is wrong, and the
 * error is under a control they cannot see. Advancing past an invalid page is
 * the single worst thing a paged form can do.
 *
 * ⚠️ IT READS THE ERRORS BACK RATHER THAN TRUSTING THE CALL.
 * `validateEntityValue` returns `Promise<void>` — it writes the outcome into the
 * store as a side effect and tells the caller nothing. So the answer comes from
 * `getEntitiesErrors()` after every one has settled.
 *
 * `Promise.all`, not a loop with `await` in it: the validators are independent,
 * and running them in sequence would report the first bad field on a page and
 * leave the rest unmarked until the next press.
 *
 * A page whose only item is the section row validates trivially — the section is
 * `shouldBeProcessed: () => false`, so it has no error to have.
 */
export async function validateInterpreterPage(
  interpreterStore: FormInterpreterStore,
  entityIds: ReadonlyArray<string>,
): Promise<boolean> {
  await Promise.all(entityIds.map((entityId) => interpreterStore.validateEntityValue(entityId)));

  const errors = interpreterStore.getEntitiesErrors();

  return entityIds.every((entityId) => errors[entityId] === undefined);
}

/**
 * Every field of the form, live.
 *
 * `InterpreterEntities` returns an ARRAY rather than an element — it renders one
 * component per root entity and nothing around them — so this wrapper exists to
 * give the call site something it can put in a `<fieldset>` beside the fixed
 * fields.
 *
 * ⚠️ EVERY PAGE IS RENDERED. THE ONES YOU CANNOT SEE ARE HIDDEN, NOT UNMOUNTED.
 *
 * This is the same hazard `keepMounted` solves on the builder's tabs, and it
 * costs an answer rather than a selection. Unmounting page 2 to show page 3 and
 * mounting it again on Back gives every control on it a fresh `useState` — a
 * half-typed sentence, an unsaved file picker selection and an open date picker
 * all go. The interpreter store would still hold the committed values, so the
 * loss is silent and partial, which is worse than total: the form comes back
 * looking filled in, missing the last thing that was typed.
 *
 * `hidden` keeps the tree alive and takes the page out of the layout, out of the
 * tab order and out of the accessibility tree — which is what "the respondent
 * sees one at a time" has to mean for somebody using a screen reader, not just
 * for somebody looking at it.
 *
 * ⚠️ `activePage` UNDEFINED MEANS SHOW EVERYTHING, and that is not a dead
 * branch — it is what the builder's preview does when it is showing the whole
 * form, and what any host that does not page renders.
 */
export function InterpreterFields({
  interpreterStore,
  activePage,
  className = "space-y-4",
}: {
  interpreterStore: FormInterpreterStore;
  /** The page to show, or `undefined` for all of them at once. */
  activePage?: number;
  /** The spacing between the fields of ONE page. */
  className?: string;
}) {
  const pages = useFormPages(interpreterStore);

  if (activePage === undefined) {
    return (
      <div className={className}>
        <InterpreterEntities interpreterStore={interpreterStore} components={fieldComponents} />
      </div>
    );
  }

  return (
    <>
      {pages.map((page, index) => (
        <div
          // The index is the identity here: pages have no id of their own, and a
          // page's contents changing is exactly what should re-render it rather
          // than remount it.
          key={index}
          hidden={index !== activePage}
          className={className}
        >
          {page.items.map((entityId) => (
            <InterpreterEntity
              key={entityId}
              entityId={entityId}
              components={fieldComponents}
              interpreterStore={interpreterStore}
            />
          ))}
        </div>
      ))}
    </>
  );
}
