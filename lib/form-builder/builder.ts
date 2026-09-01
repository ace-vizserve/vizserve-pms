import { createBuilder, type Schema, type SchemaEntity } from "@coltorapps/builder";

import { fieldEntities } from "@/lib/form-builder/entities";

/**
 * P7-63 Phase 0 — the one builder every form is built and interpreted with.
 *
 * `validateSchema` is where the rules the `vizserve_pms_form_fields` table used
 * to enforce by constraint are re-stated, because a jsonb blob has no CHECK on
 * it. Per the library's contract it RETURNS the schema and THROWS to reject —
 * it is not a predicate, and returning `false` would quietly mean "the schema is
 * now the boolean false".
 *
 * The two rules are the CROSS-ENTITY ones — the ones no single attribute
 * validator can see, because each of them is about the form as a whole:
 *
 *   1. Keys are unique within a form. Two fields sharing one key means one of
 *      them silently overwrites the other's answer on every submission.
 *   2. `select` / `multiselect` carry at least one option — otherwise the field
 *      renders as a control nobody can answer, and its validator degenerates to
 *      "accept anything".
 *
 * The `key` PATTERN is not restated here, and used to be. It cannot be: the
 * library runs the attribute validators FIRST and short-circuits, so a bad key
 * is already refused by `keyAttribute` as `InvalidEntitiesAttributes` and this
 * function is never entered. The tailored sentence this branch produced was
 * therefore unreachable, and — worse — it was the wrong shape for the one place
 * the UI shows a rule about a key, which is beside the key input, where
 * `FIELD_KEY_MESSAGE` lands as an attribute error. Rule 1 is different: nothing
 * about entity A's attributes can tell you entity B shares its key, so it has to
 * be here.
 *
 * THE VALUES IT SEES DEPEND ON THE PATH, so read defensively.
 *
 * `validateSchema(blob, builder)` runs shape → attributes → this, and writes the
 * attribute results BACK, so `options ?? []` has already fired and `options` is
 * an array by the time it arrives. `builderStore.validateSchema()` also runs the
 * attributes first, but hands this function the store's OWN schema — the raw,
 * un-normalised one. So `options: null` reaches here intact on the builder-UI
 * path, having passed `optionsAttribute` without complaint, which is why
 * `Array.isArray` below is a live guard and not decoration. A `TypeError`
 * escaping here is reported as `InvalidSchema` with the crash as its message,
 * and `parseFormSchema` turns the same crash into a refusal with no usable
 * reason attached.
 *
 * `key` is the exception that needs no guard: `keyAttribute` accepts only a
 * string matching the pattern, verbatim and untrimmed, so raw and normalised are
 * the same value and neither path can deliver anything else.
 *
 * This is NOT the R5 guard. Renaming a key that already has submissions is still
 * refused by `vizserve_pms_form_field_protect` in Postgres, on the rows the
 * Phase 1 projection writes. The front end will be bypassed; the trigger will
 * not be.
 */

export const formBuilder = createBuilder({
  entities: fieldEntities,

  // The library's default generator, stated explicitly so the ids are known to
  // be UUIDs: the Phase 1 backfill uses the existing `form_fields.id` as the
  // entity id, and the two have to be the same shape.
  generateEntityId: () => crypto.randomUUID(),

  validateSchema: (schema) => {
    const ownerOfKey = new Map<string, string>();

    for (const entity of Object.values(schema.entities)) {
      const { key, label } = entity.attributes;

      // A field is named to the user by its label; the key is machinery. On the
      // builder-store path `label` is raw, so it is not interpolated into a
      // message until it is known to be a string — `${{}}` reads as
      // "[object Object] needs at least one option" to whoever is looking at the
      // builder. `key` needs no such check (see the header), but it can be an
      // empty string only if `keyAttribute` is loosened, so the fallback chain
      // still ends somewhere printable.
      const name =
        typeof label === "string" && label.trim().length > 0 ? label : key || "A field";

      if (ownerOfKey.has(key)) {
        throw new Error(
          `Two fields share the key "${key}". Every field on a form needs its own.`,
        );
      }
      ownerOfKey.set(key, name);

      if (entity.type === "select" || entity.type === "multiselect") {
        const { options } = entity.attributes;

        // `Array.isArray` before `.length`. NOT decoration: on the
        // builder-store path this function is handed the store's raw schema, and
        // `optionsAttribute` accepts `options: null` (it maps it to `[]` in its
        // own output, which the store does not keep). Reading `.length` off it
        // unguarded is a TypeError shown to the builder as the save-time error.
        // A select with no options is the same unanswerable field either way.
        if (!Array.isArray(options) || options.length === 0) {
          throw new Error(`${name} needs at least one option.`);
        }
      }
    }

    return schema;
  },
});

export type FormBuilder = typeof formBuilder;

/** A form's stored schema, as the library sees it. */
export type FormSchema = Schema<FormBuilder>;

/** One field within that schema. Its id is the RECORD KEY, not a property. */
export type FormSchemaEntity = SchemaEntity<FormBuilder>;

/**
 * A form nobody has added a field to yet.
 *
 * A FACTORY, not a shared constant. This used to be a module-level object with
 * a mutable `root` array in a process serving many requests at once, so one
 * builder store adding a field to "the empty form" would have added it to every
 * other request's empty form. It is the same aliasing hazard `schemaFromFields`
 * copies `options` to avoid, one scope up.
 */
export function emptyFormSchema(): FormSchema {
  return { entities: {}, root: [] };
}
