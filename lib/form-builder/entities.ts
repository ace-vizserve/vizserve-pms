import { createEntity, type EntityContext } from "@coltorapps/builder";
import { z } from "zod";

import { fieldAttributes, type FieldAttributes } from "@/lib/form-builder/attributes";
import { attachmentRefSchema, type AttachmentRef } from "@/lib/schemas/forms";

/**
 * P7-63 Phase 0 — the eight field entities.
 *
 * Each `validate` is a VERBATIM BEHAVIOURAL PORT of its branch in
 * `buildFieldSchema` (lib/schemas/forms.ts): same zod construction, same
 * messages, same required/optional handling, same empty-string treatment.
 * `tests/unit/form-builder-parity.test.ts` drives the same inputs through both
 * and asserts they agree — that test, not this comment, is the guarantee.
 *
 * Two things about the port are worth stating plainly, because they look like
 * bugs and are the existing behaviour:
 *
 *   - An OPTIONAL `email`, `date`, `select` or `number` accepts `""` and
 *     returns `""`. Only `text`/`textarea` normalise an untouched input away.
 *     Changing that here would be a silent behaviour change dressed up as a
 *     refactor; if it should change, it changes in its own commit with its own
 *     migration of stored values.
 *   - `z.coerce.number()` reads `""` as 0. A required number field therefore
 *     accepts a blank. Same reasoning: ported, not fixed.
 *
 * The names are the `vizserve_pms_field_type` enum values verbatim, so the
 * projection between rows and schema is one-to-one and no stored data is
 * renamed.
 *
 * Zero React here, by design — `@coltorapps/builder` is React-free, which is
 * what lets a server action validate a submission with the same declarations
 * the browser renders from.
 */

/**
 * A field that has been archived (`is_active = false`) is still in the schema —
 * it has to be, or the Phase 1 projection would delete a row holding data — but
 * it is not part of the live form. `shouldBeProcessed` is how the library is
 * told to skip it: no validation, and no key in the validated output.
 *
 * This reproduces the old renderer's `where is_active` filter, which is why an
 * archived-but-required field cannot block a submission.
 */
const shouldBeProcessed = ({ entity }: EntityContext<FieldAttributes>) =>
  !entity.attributes.archived;

function defineFieldEntity<const TName extends string, TValue>(
  name: TName,
  validate: (value: unknown, context: EntityContext<FieldAttributes>) => TValue,
) {
  return createEntity({ name, attributes: fieldAttributes, shouldBeProcessed, validate });
}

export const textEntity = defineFieldEntity("text", (value, { entity }) => {
  const { label, required } = entity.attributes;
  const base = z.string().trim().min(1, `${label} is required.`);
  return required ? base.parse(value) : z.string().trim().optional().parse(value);
});

export const textareaEntity = defineFieldEntity("textarea", (value, { entity }) => {
  const { label, required } = entity.attributes;
  const base = z.string().trim().min(1, `${label} is required.`);
  return required ? base.parse(value) : z.string().trim().optional().parse(value);
});

export const dateEntity = defineFieldEntity("date", (value, { entity }) => {
  const { label, required } = entity.attributes;
  const base = z.string().min(1, `${label} is required.`);
  return required
    ? base.parse(value)
    : z.union([z.literal(""), base]).optional().parse(value);
});

export const selectEntity = defineFieldEntity("select", (value, { entity }) => {
  // No `label` here: unlike every other type, the select branch's messages never
  // named the field. Ported as-is rather than improved.
  const { required, options } = entity.attributes;

  if (options.length === 0) {
    /*
     * The old `z.any().optional()` branch: a select with no options has nothing
     * to validate against, so the value passes through untouched.
     *
     * The cast is type-level only — the runtime result is whatever came in, and
     * the parity test compares runtime results. It is here so one degenerate
     * branch does not widen every select value to `unknown` for the components
     * that will render them. `validateSchema` in builder.ts refuses to save an
     * option-less select, so this is only reachable for a schema that never went
     * through it.
     */
    return z.any().optional().parse(value) as string | undefined;
  }

  const base = z.enum(options as [string, ...string[]], {
    message: "Choose one of the listed options.",
  });
  return required
    ? base.parse(value)
    : z.union([z.literal(""), base]).optional().parse(value);
});

export const multiselectEntity = defineFieldEntity("multiselect", (value, { entity }) => {
  const { label, required, options } = entity.attributes;
  const base = z.array(z.enum(options as [string, ...string[]]));
  return required
    ? base.min(1, `${label} is required.`).parse(value)
    : base.default([]).parse(value);
});

export const fileEntity = defineFieldEntity("file", (value, { entity }) => {
  const { label, required } = entity.attributes;
  /*
   * Files are uploaded before submit and referenced by receipt id, so the form
   * value is the REFERENCE, not the blob. `attachmentRefSchema.id` is the whole
   * security story (lib/schemas/forms.ts) — filename, type and size are read
   * back from the database, never believed from here.
   */
  const base = z.array(attachmentRefSchema).min(required ? 1 : 0, `${label} is required.`);
  return (required ? base.parse(value) : base.optional().parse(value)) as
    | AttachmentRef[]
    | undefined;
});

export const emailEntity = defineFieldEntity("email", (value, { entity }) => {
  const { label, required } = entity.attributes;
  const base = z.email(`${label} must be a valid email.`);
  return required
    ? base.parse(value)
    : z.union([z.literal(""), base]).optional().parse(value);
});

export const numberEntity = defineFieldEntity("number", (value, { entity }) => {
  const { label, required } = entity.attributes;
  const base = z.coerce.number({ message: `${label} must be a number.` });
  return required
    ? base.parse(value)
    : z.union([z.literal(""), base]).optional().parse(value);
});

/**
 * P7-66 Phase 7 — THE PAGE BREAK, AND THE ONE ENTITY THAT CAN NEVER HOLD A
 * VALUE.
 *
 * ⚠️ `shouldBeProcessed: () => false`, UNCONDITIONALLY — not the archived test
 * every other entity uses. That single line is the whole safety story:
 *
 *   - `validate` is never called, so the section cannot fail a submission.
 *   - No key for it appears in the library's validated output, so
 *     `toFieldValues` cannot write one and `field_values` never gains a key
 *     that nothing will ever read back.
 *
 * A section is therefore invisible to every value path by construction rather
 * than by a filter each path remembers to apply. `validate` below exists only
 * because `createEntity` requires one; reaching it means `shouldBeProcessed`
 * was bypassed, and throwing is the honest response to that.
 *
 * ⚠️ IT STILL NEEDS A `field_key`. The column is NOT NULL and unique per form,
 * so the row cannot exist without one — it is derived from the title exactly as
 * a question's is, and then never read by anything. Do not be tempted to skip
 * deriving it because nothing consumes it; the INSERT is what consumes it.
 *
 * ⚠️ AND IT DECLARES ALL SIX ATTRIBUTES. The library refuses a schema that is
 * missing one (`MissingEntityAttributes`) just as firmly as one carrying an
 * extra, so `required` and `options` are declared here and simply never used —
 * `vizserve_pms_form_fields_section_asks_nothing` is what keeps them at `false`
 * and `[]` in the database.
 */
export const sectionEntity = createEntity({
  name: "section",
  attributes: fieldAttributes,
  shouldBeProcessed: () => false,
  validate: () => {
    throw new Error(
      "A section holds no value — shouldBeProcessed should have skipped it.",
    );
  },
});

/**
 * P7-66 Phase 9 — SHOWN, NOT ASKED, AND THE URL IS `options[0]`.
 *
 * Both are `sectionEntity` with a picture, and share its whole safety story:
 * `shouldBeProcessed: () => false` means `validate` is never called and no key
 * reaches the library's output, so `toFieldValues` cannot write one and neither
 * field can fail a submission or grow a column. That is by construction rather
 * than by a filter each path remembers to apply.
 *
 * ⚠️ `options` CARRIES THE URL AND `label` CARRIES THE ACCESSIBLE NAME. Neither
 * is a repurposing that has to be remembered in two places: `options` is already
 * "the values this field carries", and `label` is already required — which is
 * how the alt text on an image and the title on a video end up mandatory
 * without a rule of their own. `optionsAttribute` refuses an EMPTY option, so
 * the URL cannot be blank either.
 *
 * `validate` throws because `createEntity` requires one. Reaching it means
 * `shouldBeProcessed` was bypassed, and throwing is the honest response.
 */
function defineDisplayEntity<const TName extends string>(name: TName) {
  return createEntity({
    name,
    attributes: fieldAttributes,
    shouldBeProcessed: () => false,
    validate: () => {
      throw new Error(
        `A ${name} field holds no value — shouldBeProcessed should have skipped it.`,
      );
    },
  });
}

export const imageEntity = defineDisplayEntity("image");
export const youtubeEntity = defineDisplayEntity("youtube");

export const fieldEntities = [
  textEntity,
  textareaEntity,
  dateEntity,
  selectEntity,
  multiselectEntity,
  fileEntity,
  emailEntity,
  numberEntity,
  sectionEntity,
  imageEntity,
  youtubeEntity,
] as const;

export type FieldEntities = typeof fieldEntities;
