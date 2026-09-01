import { createAttribute } from "@coltorapps/builder";
import { z } from "zod";

/**
 * P7-63 Phase 0 — the six attributes every field entity carries.
 *
 * ONE SHARED LIST, deliberately. A `text` field has no use for `options`, but
 * the Phase 1 backfill projects every `vizserve_pms_form_fields` row into an
 * entity with all six attributes written, and the library rejects a schema
 * carrying an attribute the entity does not declare
 * (`UnknownEntityAttributeType`). Splitting the list would make the migration
 * refuse to load its own output. The builder UI hides the irrelevant ones
 * instead — that is a rendering decision, not a schema one.
 *
 * `key` is the load-bearing one. Coltorapps identifies entities by generated
 * UUID, but `vizserve_pms_requests.field_values` has always been keyed by
 * `field_key`, and years of submissions are stored that way. So the UUID is the
 * schema's internal identity and `key` is the STORAGE identity — see §1 of the
 * plan, and lib/form-builder/values.ts, which translates between the two.
 *
 * Every validator is nullish-tolerant where the old column had a default,
 * because a jsonb blob written by SQL can carry `null` where TypeScript would
 * have written nothing.
 */

/** Same rule as `formFieldDraftSchema.field_key` and the column's own CHECK. */
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export const FIELD_KEY_MESSAGE = "Lower-case letters, numbers and underscores.";

/**
 * REJECTS AN UNTRIMMED KEY, DELIBERATELY — it does not trim one.
 *
 * `.trim()` here rewrote storage identity in silence: `"  note  "` parsed to
 * `"note"`, and every answer already filed under `"  note  "` in
 * `vizserve_pms_requests.field_values` was orphaned — read back as a blank
 * answer rather than an error. That is the exact failure §1 of the plan exists
 * to prevent, committed by the code meant to uphold it.
 *
 * Rejecting costs nothing legitimate. The column's own CHECK
 * (`field_key ~ '^[a-z][a-z0-9_]*$'`) already forbids whitespace, so no key that
 * reached the database through a row can carry any; only the `schema` jsonb
 * column is unconstrained, and a blob that got a key past the rows is precisely
 * the one that must be refused rather than quietly repaired.
 *
 * It also makes the two mints of `ParsedFormSchema` agree. `schemaFromFields`
 * copies `field_key` verbatim, so with a trim here the same form meant one thing
 * read from rows and another read from the blob.
 *
 * Anchored pattern, so this rejects the untrimmed value on its own — there is
 * nothing else to add.
 */
export const keyAttribute = createAttribute({
  name: "key",
  validate: (value) => z.string().regex(FIELD_KEY_PATTERN, FIELD_KEY_MESSAGE).parse(value),
});

/**
 * `label` and `helpText` VALIDATE trim-aware but STORE VERBATIM.
 *
 * The earlier version trimmed, on the reasoning that display text carries no
 * meaning a rewrite could break. That was wrong for the same reason it was
 * wrong for `key`: `fieldsFromSchema(parseFormSchema(blob))` is a projection
 * back into `vizserve_pms_form_fields`, so a read-side trim does not change how
 * a sentence looks — it silently EDITS THE STORED ROW. Round-tripping a form
 * must never be a write.
 *
 * It also aligns the two mints. `schemaFromFields` copies these columns
 * verbatim, so trimming here alone meant one form meant two things depending on
 * which way it was loaded.
 *
 * And it is closer to the code being replaced: `buildFieldSchema` interpolates
 * `field.label` untrimmed into every message (`${field.label} is required.`),
 * so preserving padding is what parity actually requires.
 *
 * `refine` rather than `.trim().min(1)` because the point is to reject a label
 * that is only whitespace WITHOUT rewriting one that merely has some — plain
 * `.min(1)` on an untrimmed string would accept `"   "`.
 */
export const labelAttribute = createAttribute({
  name: "label",
  validate: (value) =>
    z
      .string()
      .refine((text) => text.trim().length > 0, "Give the field a label.")
      .parse(value),
});

export const helpTextAttribute = createAttribute({
  name: "helpText",
  validate: (value) =>
    z
      .string()
      .nullish()
      .transform((text) => text ?? "")
      .parse(value),
});

export const requiredAttribute = createAttribute({
  name: "required",
  // Defaults to true, matching `formFieldDraftSchema.is_required`: a field
  // somebody bothered to add is assumed to be one they want answered.
  validate: (value) =>
    z
      .boolean()
      .nullish()
      .transform((flag) => flag ?? true)
      .parse(value),
});

/**
 * PRESERVES EACH OPTION VERBATIM — it neither trims one nor refuses one.
 *
 * An option is a stored VALUE, not display text: `selectEntity` builds
 * `z.enum(options)` from this list, and a submitted answer is accepted only if
 * it equals one of them exactly. So trimming on read moved the accepted set away
 * from the stored set — a form carrying the option `"Low "` rendered `"Low "`,
 * the requester submitted `"Low "`, and validation refused their own form's
 * answer. Historical `field_values` holding `"Low "` failed re-validation for
 * the same reason.
 *
 * That is why trimming here is actively wrong rather than merely redundant.
 * `formFieldDraftSchema.options` (lib/schemas/forms.ts) already trims on WRITE,
 * so anything the app stored is trimmed and this trim was a no-op for it. The
 * only values it could ever change were the ones the app did not write — and
 * those are exactly the values that must be honoured as stored, because
 * submissions are already filed against them.
 *
 * Refusing an untrimmed option is not the answer either, unlike `key` above: an
 * option is not an identifier, no CHECK forbids whitespace in one, and refusing
 * would make the whole form unopenable over a cosmetic oddity in one choice.
 * Preserve, do not rewrite, do not reject.
 *
 * `.min(1)` stays, on the untrimmed string: `""` is the one option that cannot
 * be a real choice, and the write path rejects it too. `schemaFromFields` copies
 * `options` verbatim, so the two mints now agree.
 */
export const optionsAttribute = createAttribute({
  name: "options",
  validate: (value) =>
    z
      .array(z.string().min(1))
      .nullish()
      .transform((options) => options ?? [])
      .parse(value),
});

/**
 * The inverse of `form_fields.is_active` (R5).
 *
 * A field with submissions behind it is soft-archived, never deleted, and it
 * must survive the round trip through the schema blob — drop it here and the
 * Phase 1 projection would delete a row that holds data, which the
 * `vizserve_pms_form_field_protect` trigger refuses anyway. Archived entities
 * are skipped at validation time via `shouldBeProcessed` in entities.ts.
 */
export const archivedAttribute = createAttribute({
  name: "archived",
  validate: (value) =>
    z
      .boolean()
      .nullish()
      .transform((flag) => flag ?? false)
      .parse(value),
});

export const fieldAttributes = [
  keyAttribute,
  labelAttribute,
  helpTextAttribute,
  requiredAttribute,
  optionsAttribute,
  archivedAttribute,
] as const;

export type FieldAttributes = typeof fieldAttributes;
