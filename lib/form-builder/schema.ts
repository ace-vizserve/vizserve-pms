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

/**
 * The columns `vizserve_pms_save_form_schema` WRITES, and therefore everything
 * `fieldsFromSchema` is able to produce.
 *
 * `created_at` is absent on purpose — see `FormFieldRow` immediately below and
 * the note on `fieldsFromSchema`.
 */
export type ProjectedFormFieldRow = {
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
 * A row as it is READ out of `vizserve_pms_form_fields`: every projected column
 * plus the one the ordering needs.
 *
 * ⚠️ `created_at` IS REQUIRED, AND THAT IS THE WHOLE POINT OF ITS BEING HERE.
 *
 * The Phase 1 backfill orders `sort_order, created_at, id` — three columns,
 * because `moveField` in app/(app)/forms/actions.ts records that "seeded and
 * hand-edited forms often share sort_order values", so ties are live data rather
 * than a hypothetical. `schemaFromFields` is that backfill's twin, so it has to
 * break a tie the same way or the two produce different `root` orders from the
 * same rows — on precisely the oldest forms, and silently.
 *
 * OPTIONAL WAS CONSIDERED AND REFUSED. With `created_at?: string` the sort would
 * need a fallback for the absent case, and no fallback can be both deterministic
 * and faithful: the value the SQL orders by is simply not in hand. A constant
 * fallback is deterministic (the tie falls through to `id`) but agrees with the
 * SQL only when `created_at` order happens to coincide with `id` order, which
 * for `gen_random_uuid()` ids is a coin toss. That is not a smaller version of
 * the bug, it is the same bug behind a defaulted parameter.
 *
 * Optional would also leave every future loader — Phase 2's above all — obliged
 * to REMEMBER to select the column, which is the "a comment telling a future
 * caller to remember" this type change exists to replace. Required makes the
 * compiler the reminder: a loader that omits `created_at` does not build.
 *
 * The cost, stated: every `FormFieldRow` literal names the column, which is a
 * line in each test helper. That is the entire price, and it is paid once.
 */
export type FormFieldRow = ProjectedFormFieldRow & { created_at: string };

/**
 * Code-unit comparison, not `localeCompare`.
 *
 * Both operands are ISO-8601 UTC timestamps as PostgREST renders `timestamptz`,
 * a fixed-width prefix and a common suffix, so code-unit order IS timestamp
 * order — which is what the SQL's `order by … created_at …` sorts by. ICU
 * collation treats punctuation as variable-weight and could order `+` and `.`
 * by locale, so it is the wrong tool for a machine-readable string.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The three ordering columns, and nothing else — so anything row-shaped fits. */
type OrderedFormFieldRow = Pick<FormFieldRow, "id" | "sort_order" | "created_at">;

/**
 * `order by sort_order, created_at, id` — THE one ordering rule, in one place.
 *
 * It was written out inline in `schemaFromFields` and nowhere else, which is
 * how `moveField` in app/(app)/forms/actions.ts came to order by `sort_order`
 * ALONE while its blob-writing twin ordered by three columns: on a form with
 * ties the two disagreed about which row is "the one above", so the neighbour
 * the action swapped was not the neighbour the blob went on to record. Sharing
 * the comparator makes that particular disagreement unexpressible.
 */
function byProjectionOrder(a: OrderedFormFieldRow, b: OrderedFormFieldRow): number {
  return (
    a.sort_order - b.sort_order ||
    byCodeUnit(a.created_at, b.created_at) ||
    byCodeUnit(a.id, b.id)
  );
}

/**
 * Rows → schema. The TypeScript twin of the Phase 1 backfill.
 *
 * ⚠️ ORDERED BY `sort_order, created_at, id`, THE BACKFILL'S THREE COLUMNS.
 * `Array.prototype.sort` is stable, so sorting on `sort_order` alone did not
 * order tied rows — it merely preserved whatever order the caller passed them
 * in, which for a database read is whatever the planner felt like. Two tied rows
 * therefore landed in `root` one way here and another way in SQL. Sorting on all
 * three makes the twins agree BY CONSTRUCTION and makes this function's output a
 * function of its input rather than of its input's order.
 *
 * The first two columns are the tiebreak `vizserve_pms_get_public_form` already
 * renders by, so the order is the one clients have been seeing; `id` makes it
 * total.
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
  const ordered = [...fields].sort(byProjectionOrder);

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
 * ⚠️ NO `created_at` COMES OUT, AND THE RETURN TYPE SAYS SO RATHER THAN A
 * COMMENT ASKING THE CALLER TO NOTICE. A schema blob carries no such value and
 * cannot invent one honestly, and the SQL twin does not write the column either:
 * step 3 UPDATEs the eight value columns and leaves `created_at` alone, step 4's
 * INSERT omits it so the column default fires. `created_at` is the moment a row
 * was first inserted — an input to the ordering above, never an output of a
 * save. Hence `ProjectedFormFieldRow`.
 *
 * So the round-trip identity is stated over exactly those columns:
 * `fieldsFromSchema(schemaFromFields(rows))` equals `rows` MINUS `created_at`,
 * which is the strongest form of it that is actually true. One further caveat,
 * and it is a property of the SQL as much as of this function: `sort_order`
 * comes back DENSE, so rows that shared a `sort_order` do not round-trip to the
 * `sort_order` they went in with. The tie is resolved — by `created_at` then
 * `id`, above — and the first save writes that resolution down. That is the
 * intended behaviour, not a broken identity: after one save through
 * `vizserve_pms_save_form_schema` no form has a tie left to disagree about.
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
export function fieldsFromSchema(schema: FormSchema): ProjectedFormFieldRow[] {
  const rows: ProjectedFormFieldRow[] = [];
  const seen = new Set<string>();

  for (const entityId of schema.root) {
    if (seen.has(entityId) || !Object.hasOwn(schema.entities, entityId)) continue;

    seen.add(entityId);

    const entity = schema.entities[entityId];
    const attributes = entity.attributes as Partial<typeof entity.attributes>;

    /*
     * EVERY ATTRIBUTE IS READ DEFENSIVELY, because the parameter is a bare
     * `FormSchema` and the comment above promises this function is safe on its
     * own. The live caller that makes that real is Phase 2's save handler,
     * which projects the BUILDER STORE's schema — and the store hands out its
     * raw blob, so `optionsAttribute`'s `?? []` has not fired and an unset
     * label is simply absent. Spreading `options` there threw
     * `TypeError: not iterable`, which is a crashed save rather than a refused
     * one.
     *
     * A missing `key` is the one thing that cannot be defaulted: it is the
     * storage identity every answer is filed under (§1), and inventing one
     * would file answers under a key nothing reads. Such an entity is skipped,
     * like a dangling id above.
     */
    if (typeof attributes.key !== "string") continue;

    rows.push({
      id: entityId,
      field_key: attributes.key,
      label: typeof attributes.label === "string" ? attributes.label : "",
      field_type: entity.type,
      help_text: typeof attributes.helpText === "string" ? attributes.helpText : "",
      // Copied for the same reason as in `schemaFromFields`: a caller mutating
      // a projected row must not be able to edit the schema it came from.
      options: Array.isArray(attributes.options) ? [...attributes.options] : [],
      // Mirrors `requiredAttribute`'s `?? true` — a field is required unless it
      // says otherwise, which is layer 1 of the completeness rule.
      is_required: attributes.required !== false,
      is_active: attributes.archived !== true,
      // ROW position, not `root` position. Now that a duplicate or a dangling id
      // can be skipped, indexing `root` would leave holes in `sort_order`;
      // counting rows keeps it a dense 0..n-1, which is what the projection
      // sorts by and what a fresh save writes.
      sort_order: rows.length,
    });
  }

  return rows;
}

/**
 * A row as `moveField` reads it: the three ordering columns, plus the flag that
 * says whether the user can see it.
 */
export type FieldOrderRow = OrderedFormFieldRow & Pick<FormFieldRow, "is_active">;

/** One `update ... set sort_order = n where id = …`. */
export type FieldOrderUpdate = { id: string; sort_order: number };

/**
 * ⚠️ P7-66 Phase 1 — THROWAWAY, like the action it serves. Phase 2 reorders in
 * the builder store with `setEntityIndex` and deletes `moveField` outright.
 *
 * Nudges one field one place, and returns the FULL DENSE RENUMBERING that move
 * implies — every row whose `sort_order` has to change, and only those.
 *
 * ⚠️ IT RENUMBERS EVERYTHING, NOT THE TWO ROWS THAT SWAPPED, and that is the
 * whole reason it exists. `moveField` used to rewrite exactly the two swapped
 * rows to `(position + 1) * 10` and leave every other row where it was. Fields
 * are inserted at `sort_order: 999` by the builder
 * (app/(app)/forms/[id]/field-builder.tsx), so on a form that had never been
 * reordered EVERY row shared 999 — and moving the third field up left the two
 * rewritten rows at 20 and 30 with the rest still at 999, i.e. both of them
 * jumped in front of fields nobody had touched. `A B C D E` became `C B A D E`.
 * A renumbering that only spends values on two rows is only correct when the
 * other rows already hold values that separate them, which on this table is
 * precisely the case that had never happened yet.
 *
 * Dense and ZERO-BASED, matching `fieldsFromSchema` above and
 * `row_number() over (order by u.pos) - 1` in
 * supabase/migrations/20260901150000_p7_66_form_schema.sql. So a form that has
 * been moved once already holds the `sort_order` values Phase 2's first save
 * would write, and the ties are gone for good.
 *
 * ⚠️ THE NEIGHBOUR IS THE NEAREST ROW THE USER CAN SEE, not the adjacent row.
 * The builder renders active and archived fields as two separate lists and only
 * the active one carries move buttons, so an archived field sitting between two
 * active ones is invisible in the list being reordered — swapping into it would
 * be a click that visibly does nothing. The archived row keeps its position in
 * the overall order (and therefore in the blob's `root`); the two visible rows
 * trade places around it.
 *
 * Pure and total: no database, no throwing, and it re-sorts its input rather
 * than trusting the caller's `order by`, so its output is a function of the
 * rows and not of the order Postgres happened to return them in. An empty
 * result means "nothing to do" — the field is not on this form, or it is
 * already the first/last thing the user can see in that direction.
 */
export function planFieldReorder(
  rows: ReadonlyArray<FieldOrderRow>,
  fieldId: string,
  direction: "up" | "down",
): FieldOrderUpdate[] {
  const ordered = [...rows].sort(byProjectionOrder);

  const from = ordered.findIndex((row) => row.id === fieldId);
  if (from < 0) return [];

  const step = direction === "up" ? -1 : 1;
  let to = from + step;
  while (to >= 0 && to < ordered.length && ordered[to]!.is_active !== ordered[from]!.is_active) {
    to += step;
  }
  if (to < 0 || to >= ordered.length) return [];

  const moved = [...ordered];
  moved[from] = ordered[to]!;
  moved[to] = ordered[from]!;

  const updates: FieldOrderUpdate[] = [];
  moved.forEach((row, index) => {
    // Only the rows that actually move are written. On an already-dense form
    // that is the two that swapped; on the all-999 form above it is all of them.
    if (row.sort_order !== index) updates.push({ id: row.id, sort_order: index });
  });

  return updates;
}
