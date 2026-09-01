import { validateSchema, type SchemaValidationErrorReason } from "@coltorapps/builder";

import { formBuilder, type FormSchema, type FormSchemaEntity } from "@/lib/form-builder/builder";
import type { FieldType } from "@/lib/schemas/forms";

/**
 * P7-63 Phase 0 — the stored blob, and the projection between it and rows.
 *
 * `vizserve_pms_forms.schema` is jsonb, so nothing in the database checks its
 * shape beyond `jsonb_typeof = 'object'`. This is where a blob read out of that
 * column is checked before it is handed to the library.
 *
 * ONE VALIDATOR, NOT TWO. This file used to re-state the library's rules as a
 * zod schema and brand whatever that accepted. The two drifted, and every place
 * they disagreed was a latent crash or a silent drop on the public submit path:
 * a zod-shaped blob the library then rejected (an unreachable entity, an empty
 * label), or one it threw a bare `Error` over (`parentId: "not-a-uuid"`). So the
 * parser IS the library's `validateSchema` now — there is no second opinion left
 * for it to disagree with. `tests/unit/form-values-translation.test.ts` pins the
 * equivalence, so a well-meant pre-filter cannot reopen the gap.
 *
 * `validateSchema` also RETURNS THE NORMALISED SCHEMA, which is what makes the
 * substitution total rather than merely adequate: it runs every attribute
 * validator in attributes.ts and writes the results back, so the nullish
 * defaults a SQL-written blob depends on (`required ?? true`, `options ?? []`)
 * are applied here exactly as the old zod copies applied them.
 *
 * The one thing it costs is that parsing is now async. `validateEntitiesValues`
 * is async already, the submit path is a server action, and no caller outside
 * the tests exists yet — so the seam was cheap to close now and would not have
 * been later.
 *
 * ENTITY ID = `form_fields.id`. Not a new UUID. Reuse is what makes the round
 * trip stable and keeps attachments and joins pointing at the same rows.
 */

/**
 * Why the library's own rejection type is widened by one code.
 *
 * `validateSchema` reports most problems by resolving `{ success: false }`, but
 * `validateEntityId` THROWS a bare `Error` for an id that is not UUID-shaped,
 * and a non-object blob (`null`) dies on property access before any check runs.
 * Both are reachable from the public submit path, where an uncaught throw is a
 * 500 rather than a message, so they are caught and folded in here instead of
 * left for a caller to remember.
 */
export type FormSchemaRejection =
  | SchemaValidationErrorReason
  | { code: "Unreadable"; payload: { cause: unknown } };

export class FormSchemaError extends Error {
  readonly reason: FormSchemaRejection;

  constructor(reason: FormSchemaRejection) {
    super(`This form's schema is not valid (${reason.code}).`);
    this.name = "FormSchemaError";
    this.reason = reason;
  }
}

declare const parsedFormSchemaBrand: unique symbol;

/**
 * A schema that is known to have been checked.
 *
 * The brand is what makes the check unskippable. `validateFieldValues` takes
 * only this type, so a raw jsonb blob cannot reach the library without passing
 * through `parseFormSchema` first — and it is `parseFormSchema` that applies the
 * attribute defaults. Without the brand the safety net depended on every caller
 * remembering to call it, and the one that forgot would turn a required field
 * into an optional one, silently.
 *
 * Only two functions mint it: `parseFormSchema`, and `schemaFromFields`, whose
 * input is already typed row data with no nullable attribute in it.
 */
export type ParsedFormSchema = FormSchema & { readonly [parsedFormSchemaBrand]: true };

/**
 * Applies the brand. The only two call sites are the two functions below, which
 * is the whole point — keep it that way, and a `ParsedFormSchema` is proof the
 * schema went through one of them.
 */
function asParsed(schema: FormSchema): ParsedFormSchema {
  return schema as ParsedFormSchema;
}

/**
 * Parses a blob read out of the `schema` column.
 *
 * Accepts exactly what `validateSchema(blob, formBuilder)` accepts, because it
 * is that call. Anything it refuses raises `FormSchemaError` carrying the
 * library's own reason code — structured, so a caller can log which rule failed
 * without showing an unauthenticated requester how the form is built.
 */
export async function parseFormSchema(value: unknown): Promise<ParsedFormSchema> {
  let result;

  try {
    result = await validateSchema(value, formBuilder);
  } catch (cause) {
    throw new FormSchemaError({ code: "Unreadable", payload: { cause } });
  }

  if (!result.success) throw new FormSchemaError(result.reason);

  /*
   * `root` is COPIED. The library aliases it: `validateSchemaShape` returns
   * `{ entities: …, root: blob.root }`, so without this the validated schema and
   * the caller's raw blob shared one array and a later `blob.root.push(id)`
   * silently added a field to a schema the brand says was checked — the same
   * aliasing hazard `emptyFormSchema()` became a factory over, and the one
   * `schemaFromFields` copies `options` to avoid.
   *
   * A shallow copy is enough, and matches what the library already does with
   * everything else: `entities` is a fresh record of fresh entity objects, and
   * each `options` array is minted by zod inside `optionsAttribute`. `root` was
   * the one thing left pointing back at the input.
   */
  return asParsed({ entities: result.data.entities, root: [...result.data.root] });
}

/** The columns of `vizserve_pms_form_fields` the projection touches. */
export type FormFieldRow = {
  id: string;
  field_key: string;
  label: string;
  field_type: FieldType;
  help_text: string;
  options: string[];
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
};

/**
 * Rows → schema. The TypeScript twin of the Phase 1 backfill.
 *
 * Deliberately NOT routed through `parseFormSchema`, and therefore deliberately
 * the more permissive of the two mints: rows are the older, authoritative store,
 * and a projection that refused to read one would leave that form unopenable
 * rather than fixable. The column CHECKs — the `field_key` pattern,
 * `unique (form_id, field_key)`, `vizserve_pms_form_fields_select_has_options` —
 * already enforce every rule `formBuilder.validateSchema` re-states, so in
 * practice the output does pass it. "In practice" is exactly why this stays a
 * separate mint rather than a claim.
 */
export function schemaFromFields(fields: ReadonlyArray<FormFieldRow>): ParsedFormSchema {
  const ordered = [...fields].sort((a, b) => a.sort_order - b.sort_order);

  // Assembled through `Object.fromEntries`, which DEFINES own properties, so a
  // row id can never land on a prototype slot instead of in the record. Same
  // rule everywhere in this module — see the note in values.ts.
  const entities = Object.fromEntries(
    ordered.map((field): [string, FormSchemaEntity] => [
      field.id,
      {
        type: field.field_type,
        attributes: {
          key: field.field_key,
          label: field.label,
          helpText: field.help_text,
          required: field.is_required,
          // COPIED, not aliased. Sharing the array would let a later
          // `rows[0].options.push(…)` reach into the schema this projection just
          // produced — and, through `fieldsFromSchema`, back out again, so a
          // mutation on either side of the round trip silently rewrites the other.
          options: [...field.options],
          // An archived field is carried, never dropped: the row behind it holds
          // historical answers and the R5 trigger refuses to let it go.
          archived: !field.is_active,
        },
      } as FormSchemaEntity,
    ]),
  );

  return asParsed({ entities, root: ordered.map((field) => field.id) });
}

/**
 * Schema → rows. The TypeScript twin of `vizserve_pms_save_form_schema`.
 *
 * `sort_order` is re-derived from position, so reordering in the builder is
 * expressed by the `root` array and nothing has to keep a counter in step.
 *
 * `Object.hasOwn`, not a truthiness check on the looked-up entity: `root` holds
 * arbitrary strings, and `entities["constructor"]` on a plain object answers
 * with a function rather than `undefined` — which would have projected a row
 * with no key and no type on it. The library refuses such a schema, but this
 * function takes a bare `FormSchema`, so it cannot lean on that.
 *
 * IDS ARE DE-DUPLICATED, for the same reason and by the same rule as
 * `orderedEntities` in values.ts: first position in `root` wins. `root: [A, A]`
 * otherwise projected two rows sharing the primary key `A`, which the Phase 1
 * `vizserve_pms_save_form_schema` would hand straight to Postgres as a duplicate
 * insert. The library rejects such a schema, but — again — this function does
 * not get to assume one went through it, and a projection that is the twin of a
 * SQL writer has to be safe on its own.
 */
export function fieldsFromSchema(schema: FormSchema): FormFieldRow[] {
  const rows: FormFieldRow[] = [];
  const seen = new Set<string>();

  for (const entityId of schema.root) {
    if (seen.has(entityId) || !Object.hasOwn(schema.entities, entityId)) continue;

    seen.add(entityId);

    const entity = schema.entities[entityId];

    rows.push({
      id: entityId,
      field_key: entity.attributes.key,
      label: entity.attributes.label,
      field_type: entity.type,
      help_text: entity.attributes.helpText,
      // Copied for the same reason as in `schemaFromFields`: a caller mutating
      // a projected row must not be able to edit the schema it came from.
      options: [...entity.attributes.options],
      is_required: entity.attributes.required,
      is_active: !entity.attributes.archived,
      // ROW position, not `root` position. Now that a duplicate or a dangling id
      // can be skipped, indexing `root` would leave holes in `sort_order`;
      // counting rows keeps it a dense 0..n-1, which is what the projection
      // sorts by and what a fresh save writes.
      sort_order: rows.length,
    });
  }

  return rows;
}
