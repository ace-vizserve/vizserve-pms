import { validateSchema } from "@coltorapps/builder";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FIELD_KEY_MESSAGE } from "@/lib/form-builder/attributes";
import { emptyFormSchema, formBuilder, type FormSchema } from "@/lib/form-builder/builder";
import { readPublicFormResponse } from "@/lib/form-builder/public-lookup";
import {
  fieldsFromSchema,
  FormSchemaError,
  optionsFromRow,
  parseFormSchema,
  schemaFromFields,
  schemaFromPublicFields,
  type FormFieldRow,
  type ProjectedFormFieldRow,
} from "@/lib/form-builder/schema";
import {
  extractErrorMessage,
  FORM_ERROR_MESSAGE,
  mergeSubmissionPayload,
  routeFieldErrors,
  toEntityValues,
  toFieldErrors,
  toFieldValues,
  validateFieldValues,
} from "@/lib/form-builder/values";
import type { PublicFormField } from "@/lib/schemas/forms";

/**
 * P7-63 Phase 0 — §1 of the plan, tested in both directions.
 *
 * The library keys values and errors by entity id; `field_values` has always
 * been keyed by `field_key`. If that translation is wrong, nothing fails loudly
 * — a submission simply files an answer under a key nobody reads, or a
 * historical request renders blank. So it is tested here rather than trusted.
 */

const NOTE_ID = "b1000000-0000-4000-8000-000000000001";
const PRIORITY_ID = "b1000000-0000-4000-8000-000000000002";
const OLD_ID = "b1000000-0000-4000-8000-000000000003";

function row(overrides: Partial<FormFieldRow> & { id: string; field_key: string }): FormFieldRow {
  return {
    label: "A field",
    field_type: "text",
    help_text: "",
    options: [],
    is_required: true,
    is_active: true,
    sort_order: 0,
    // Required on `FormFieldRow`, because the backfill orders `sort_order,
    // created_at, id` and `schemaFromFields` is its twin. Nothing in this file
    // gives two rows the same `sort_order`, so the value never decides an order
    // here; it is the column the compiler now stops a loader from forgetting.
    created_at: "2026-07-29T10:00:00Z",
    ...overrides,
  };
}

/**
 * A row with the column no projection can produce dropped.
 *
 * `fieldsFromSchema` returns `ProjectedFormFieldRow` - `created_at` is an input
 * to the ordering, never an output of a save, exactly as the SQL leaves the
 * column alone on UPDATE and lets its default fire on INSERT. So a round trip is
 * the identity over the nine projected columns, which is what this compares.
 */
function projected(source: FormFieldRow): ProjectedFormFieldRow {
  // Longhand rather than rest-destructuring, so it doubles as the list of the
  // nine columns a save actually writes - and so no unused binding is left
  // behind for the column that is deliberately dropped.
  return {
    id: source.id,
    field_key: source.field_key,
    label: source.label,
    field_type: source.field_type,
    help_text: source.help_text,
    options: source.options,
    is_required: source.is_required,
    is_active: source.is_active,
    sort_order: source.sort_order,
  };
}

const noteRow = row({
  id: NOTE_ID,
  field_key: "requester_note",
  label: "Note",
  is_required: false,
  sort_order: 0,
});

const priorityRow = row({
  id: PRIORITY_ID,
  field_key: "priority",
  label: "Priority",
  field_type: "select",
  options: ["Low", "High"],
  sort_order: 1,
});

const schema = schemaFromFields([noteRow, priorityRow]);

describe("field_key to entity id", () => {
  it("files a submitted answer under the entity that asks for it", () => {
    expect(toEntityValues(schema, { requester_note: "Rush job", priority: "High" })).toEqual({
      [NOTE_ID]: "Rush job",
      [PRIORITY_ID]: "High",
    });
  });

  it("drops a key with no field behind it", () => {
    // A field archived or deleted after the answer was given. Carrying it
    // forward would file a value under an entity id that does not exist.
    expect(toEntityValues(schema, { gone: "orphaned answer" })).toEqual({});
  });
});

describe("entity id back to field_key", () => {
  it("returns answers under the keys the database stores them by", () => {
    expect(toFieldValues(schema, { [NOTE_ID]: "Rush job", [PRIORITY_ID]: "High" })).toEqual({
      requester_note: "Rush job",
      priority: "High",
    });
  });

  it("drops an untouched optional field rather than storing a blank as an answer", () => {
    // The library returns a key for every processable entity whether or not it
    // held a value; writing `undefined` would put `null` in the jsonb, which
    // reads back as something the requester actually said.
    expect(toFieldValues(schema, { [NOTE_ID]: undefined, [PRIORITY_ID]: "Low" })).toEqual({
      priority: "Low",
    });
  });
});

describe("a full round trip", () => {
  it("submits and stores under the same keys", async () => {
    const result = await validateFieldValues(schema, {
      requester_note: "Rush job",
      priority: "High",
    });

    expect(result).toEqual({ ok: true, values: { requester_note: "Rush job", priority: "High" } });
  });

  it("lands an error on the field that caused it, by key", async () => {
    // The optional note is blank and legitimately silent; only the select fails.
    const result = await validateFieldValues(schema, { requester_note: "", priority: "Urgent" });

    expect(result).toEqual({
      ok: false,
      fieldErrors: { priority: "Choose one of the listed options." },
    });
  });

  it("keeps the wording buildFieldSchema produced, label and all", async () => {
    const required = schemaFromFields([{ ...noteRow, is_required: true }]);
    const result = await validateFieldValues(required, { requester_note: "" });

    expect(result).toEqual({ ok: false, fieldErrors: { requester_note: "Note is required." } });
  });
});

describe("a renamed key", () => {
  /*
   * The entity id is the schema's identity and survives a rename; `key` is the
   * storage identity and does not. Postgres refuses the rename outright once
   * the field has submissions (R5, `vizserve_pms_form_field_protect`) — this
   * covers the case where it is allowed, on a field with no data behind it.
   */
  const renamed = schemaFromFields([{ ...noteRow, field_key: "note" }, priorityRow]);

  it("keeps the same entity id", () => {
    expect(Object.keys(renamed.entities)).toEqual(Object.keys(schema.entities));
  });

  it("reads submissions under the new key and no longer under the old one", () => {
    expect(toEntityValues(renamed, { note: "Rush job", requester_note: "Rush job" })).toEqual({
      [NOTE_ID]: "Rush job",
    });
  });

  it("stores answers under the new key", () => {
    expect(toFieldValues(renamed, { [NOTE_ID]: "Rush job" })).toEqual({ note: "Rush job" });
  });
});

describe("an archived field", () => {
  const withArchived = schemaFromFields([
    noteRow,
    priorityRow,
    row({
      id: OLD_ID,
      field_key: "retired_question",
      label: "Retired question",
      is_required: true,
      is_active: false,
      sort_order: 2,
    }),
  ]);

  it("is carried in the schema, so the projection never deletes its row", () => {
    expect(withArchived.entities[OLD_ID]?.attributes.archived).toBe(true);
    expect(withArchived.root).toContain(OLD_ID);
  });

  it("cannot block a submission even though it is marked required", async () => {
    const result = await validateFieldValues(withArchived, { priority: "Low" });

    expect(result).toEqual({ ok: true, values: { priority: "Low" } });
  });
});

describe("rows to schema and back", () => {
  it("is the identity, ordering and archived fields included", () => {
    const rows = [
      noteRow,
      priorityRow,
      row({ id: OLD_ID, field_key: "retired_question", is_active: false, sort_order: 2 }),
    ];

    expect(fieldsFromSchema(schemaFromFields(rows))).toEqual(rows.map(projected));
  });

  it("re-derives sort_order from position, so a reorder needs no counter", () => {
    const reordered = schemaFromFields([priorityRow, noteRow]);

    // sort_order 1 then 0 — the projection sorts by it, so the array is unchanged.
    expect(fieldsFromSchema(reordered).map((field) => field.field_key)).toEqual([
      "requester_note",
      "priority",
    ]);
  });

  it("parses a blob that came back out of jsonb", async () => {
    await expect(parseFormSchema(JSON.parse(JSON.stringify(schema)))).resolves.toEqual(schema);
  });
});

describe("extractErrorMessage", () => {
  it("takes the first issue off a ZodError", () => {
    const error = z.string().min(1, "Say something.").safeParse("");

    expect(extractErrorMessage(error.success ? null : error.error)).toBe("Say something.");
  });

  it("falls back to a sentence rather than printing an object", () => {
    expect(extractErrorMessage({ unexpected: true })).toBe("This answer is not valid.");
  });
});

describe("validateSchema", () => {
  /*
   * The rules the `vizserve_pms_form_fields` constraints used to enforce, now
   * that the schema is a jsonb blob with no CHECK on it. Phase 1 extends this
   * in tests/unit/form-schema.test.ts once the column exists.
   */
  it("accepts a schema the builder could have produced", async () => {
    expect((await validateSchema(schema, formBuilder)).success).toBe(true);
  });

  it("refuses a key the column would not have allowed", async () => {
    const bad = schemaFromFields([{ ...noteRow, field_key: "Requester Note" }]);

    expect((await validateSchema(bad, formBuilder)).success).toBe(false);
  });

  it("refuses two fields sharing one key, which would overwrite an answer", async () => {
    const clashing = schemaFromFields([noteRow, { ...priorityRow, field_key: "requester_note" }]);

    expect((await validateSchema(clashing, formBuilder)).success).toBe(false);
  });

  it("refuses a select nobody could answer", async () => {
    const optionless = schemaFromFields([{ ...priorityRow, options: [] }]);

    expect((await validateSchema(optionless, formBuilder)).success).toBe(false);
  });
});

/*
 * The six findings below are latent defects, fixed before this module was wired
 * into the public submit path. Every one of them fails silently or as a 500 on
 * a page with no session behind it, so each keeps a test of its own.
 */

const DUP_TEXT_ID = "b1000000-0000-4000-8000-00000000000a";
const DUP_MULTI_ID = "b1000000-0000-4000-8000-00000000000b";

describe("two fields sharing one key", () => {
  /*
   * Only reachable for a hand-edited blob — `validateSchema` refuses to save
   * one. It is pinned because the two directions used to disagree: the key to
   * id map resolved by form order, the id to key map by object iteration order,
   * so the answer went in on the text field and came back out as the
   * multiselect's empty array. First field in form order wins, both ways.
   */
  const clashing = schemaFromFields([
    row({ id: DUP_TEXT_ID, field_key: "dup", label: "Typed", is_required: false, sort_order: 0 }),
    row({
      id: DUP_MULTI_ID,
      field_key: "dup",
      label: "Picked",
      field_type: "multiselect",
      options: ["Alpha", "Beta"],
      is_required: false,
      sort_order: 1,
    }),
  ]);

  it("reads the answer into the first field", () => {
    expect(toEntityValues(clashing, { dup: "typed answer" })).toEqual({
      [DUP_TEXT_ID]: "typed answer",
    });
  });

  it("stores the first field's answer, not whatever came last in the object", () => {
    expect(toFieldValues(clashing, { [DUP_MULTI_ID]: [], [DUP_TEXT_ID]: "typed answer" })).toEqual({
      dup: "typed answer",
    });
  });

  it("does not lose the answer across a full round trip", async () => {
    expect(await validateFieldValues(clashing, { dup: "typed answer" })).toEqual({
      ok: true,
      values: { dup: "typed answer" },
    });
  });

  it("still reports the second field's error rather than refusing with nothing", () => {
    // A refusal the form cannot point at is worse than a message on a field
    // that shares its key, so the loser's error surfaces when the winner has
    // none — the `{ ok: false, fieldErrors: {} }` dead end, avoided.
    const errors = toFieldErrors(clashing, {
      [DUP_MULTI_ID]: z.string().min(1, "Picked is required.").safeParse("").error,
    });

    expect(errors).toEqual({ dup: "Picked is required." });
  });
});

describe("a blob that never went through parseFormSchema", () => {
  /*
   * `validateEntitiesValues` does not run the attribute validators, so the
   * nullish defaults in attributes.ts never fire on the validation path and
   * `required: null` would make a required field silently optional. The fix is
   * structural — `validateFieldValues` accepts only a parsed schema — so the
   * first test here is a compile-time one.
   */
  it("cannot be handed to validateFieldValues at all", async () => {
    // @ts-expect-error — a raw blob is not a ParsedFormSchema. If this stops
    // erroring, the safety net is back to being optional and this test fails.
    await validateFieldValues({ entities: {}, root: [] }, {});
  });

  it("gets required back when it is parsed", async () => {
    const blob = {
      entities: {
        [NOTE_ID]: {
          type: "text",
          attributes: {
            key: "requester_note",
            label: "Note",
            helpText: null,
            required: null,
            options: null,
            archived: null,
          },
        },
      },
      root: [NOTE_ID],
    };

    expect(await validateFieldValues(await parseFormSchema(blob), { requester_note: "" })).toEqual({
      ok: false,
      fieldErrors: { requester_note: "Note is required." },
    });
  });
});

describe("a blob whose root does not match its entities", () => {
  /*
   * The library throws `SchemaValidationError` — an exception, not a rejected
   * promise — the moment it walks a root id it cannot resolve. On the public
   * submit endpoint that is a 500 where a clean refusal was owed.
   */
  it("is refused at parse time rather than at validation time", async () => {
    await expect(parseFormSchema({ entities: {}, root: [NOTE_ID] })).rejects.toBeInstanceOf(
      FormSchemaError,
    );
  });

  it("is refused when an entity id is not id-shaped", async () => {
    // The library THROWS a bare Error here rather than resolving a rejection,
    // which is why `parseFormSchema` catches as well as checks.
    await expect(
      parseFormSchema({
        entities: { "field-one": schema.entities[NOTE_ID] },
        root: ["field-one"],
      }),
    ).rejects.toBeInstanceOf(FormSchemaError);
  });

  it("still resolves rather than throwing if one reaches validateFieldValues", async () => {
    // Branded but broken, which is what a bug in the parser would look like.
    const dangling = { ...schema, root: [...schema.root, OLD_ID] } as typeof schema;

    expect(await validateFieldValues(dangling, { priority: "Low" })).toEqual({
      ok: false,
      fieldErrors: {},
      formError: FORM_ERROR_MESSAGE,
    });
  });
});

describe("an error we did not author", () => {
  /*
   * The requester is unauthenticated. A crash message printed beside a field
   * reads as advice and leaks how the form is built — this is what a select
   * with a null options list used to show them.
   */
  it("never reaches the requester", () => {
    expect(
      extractErrorMessage(new TypeError("Cannot read properties of null (reading 'length')")),
    ).toBe("This answer is not valid.");
  });

  it("is fallen back on even when it is a bare string", () => {
    expect(extractErrorMessage("permission denied for table vizserve_pms_forms")).toBe(
      "This answer is not valid.",
    );
  });
});

describe("a field with no usable key", () => {
  /*
   * `field_key` is the jsonb key an answer is filed under. An empty one used to
   * be skipped by the translation, which meant a form that refused every
   * submission with nothing highlighted, or accepted one and dropped the
   * answer. It is refused at the door instead.
   */
  const entity = {
    type: "text",
    attributes: { key: "", label: "Note", helpText: "", required: true, options: [], archived: false },
  };

  it("is refused at parse time when the key is empty", async () => {
    await expect(
      parseFormSchema({ entities: { [NOTE_ID]: entity }, root: [NOTE_ID] }),
    ).rejects.toBeInstanceOf(FormSchemaError);
  });

  it("is refused at parse time when the key is not one the column would allow", async () => {
    const named = { ...entity, attributes: { ...entity.attributes, key: "Requester Note" } };

    await expect(
      parseFormSchema({ entities: { [NOTE_ID]: named }, root: [NOTE_ID] }),
    ).rejects.toBeInstanceOf(FormSchemaError);
  });
});

describe("the options list is copied, never shared", () => {
  /*
   * Aliasing it made `rows[0].options.push(...)` edit the schema the rows came
   * from — and, back through the other projection, the rows themselves. The
   * round-trip identity this module rests on cannot survive a shared array.
   */
  it("survives a caller mutating the rows it was built from", () => {
    const rows = [row({ ...priorityRow, options: ["Low", "High"] })];
    const built = schemaFromFields(rows);

    rows[0]?.options.push("MUTATED");

    expect(built.entities[PRIORITY_ID]?.attributes.options).toEqual(["Low", "High"]);
  });

  it("survives a caller mutating the rows it was projected into", () => {
    const built = schemaFromFields([row({ ...priorityRow, options: ["Low", "High"] })]);
    const projected = fieldsFromSchema(built);

    projected[0]?.options.push("MUTATED");

    expect(built.entities[PRIORITY_ID]?.attributes.options).toEqual(["Low", "High"]);
  });
});

/*
 * SECOND REVIEW ROUND.
 *
 * Findings 2, 3 and 4 below were one bug in three costumes: `parseFormSchema`
 * and the library's own `validateSchema` disagreed about what a valid schema
 * is, and the parser branded blobs the library then rejected or threw over. The
 * fix was structural — `parseFormSchema` IS `validateSchema` now — so the last
 * block in this file pins the equivalence rather than the three symptoms.
 */

const CTOR_ID = "b1000000-0000-4000-8000-00000000000c";
const SELECT_ID = "b1000000-0000-4000-8000-00000000000d";

/** A raw jsonb blob entity, written the way SQL would write one. */
function blobEntity(over: Record<string, unknown> = {}, attributes: Record<string, unknown> = {}) {
  return {
    type: "text",
    attributes: {
      key: "requester_note",
      label: "Note",
      helpText: "",
      required: true,
      options: [],
      archived: false,
      ...attributes,
    },
    ...over,
  };
}

describe("a field whose key is a property every object already has", () => {
  /*
   * `constructor` passes FIELD_KEY_PATTERN and the column's CHECK, so a form
   * can legitimately carry it — and `"constructor" in {}` is true, which made
   * the "have I written this key already?" guard permanently true and threw the
   * message away. The requester saw the refusal with nothing highlighted that
   * this whole file exists to make impossible.
   */
  const ctor = schemaFromFields([row({ id: CTOR_ID, field_key: "constructor", label: "Builder" })]);

  it("gets its message back instead of a blank refusal", async () => {
    expect(await validateFieldValues(ctor, { constructor: "" })).toEqual({
      ok: false,
      fieldErrors: { constructor: "Builder is required." },
    });
  });

  it("writes the error as an own property rather than reading one off the prototype", () => {
    const errors = toFieldErrors(ctor, {
      [CTOR_ID]: z.string().min(1, "Builder is required.").safeParse("").error,
    });

    expect(Object.hasOwn(errors, "constructor")).toBe(true);
  });

  it("round-trips its answer like any other field", async () => {
    expect(toEntityValues(ctor, { constructor: "answered" })).toEqual({ [CTOR_ID]: "answered" });
    expect(Object.hasOwn(toFieldValues(ctor, { [CTOR_ID]: "answered" }), "constructor")).toBe(true);
    expect(await validateFieldValues(ctor, { constructor: "answered" })).toEqual({
      ok: true,
      values: { constructor: "answered" },
    });
  });
});

describe("an entity no root reaches", () => {
  /*
   * THE SERIOUS ONE. This parsed and was branded, and `validateEntitiesValues`
   * then resolved `{ success: true }` having quietly ignored the entity — a
   * required question skipped and the requester's answer discarded, reported to
   * them as a successful submission. The library rejects the same blob
   * (`EmptyRoot` / `UnreachableEntity`), which is now the only opinion there is.
   */
  const orphaned = { entities: { [NOTE_ID]: blobEntity() }, root: [] as string[] };

  const alongside = {
    entities: {
      [NOTE_ID]: blobEntity(),
      [OLD_ID]: blobEntity({}, { key: "retired_question", label: "Retired" }),
    },
    root: [NOTE_ID],
  };

  it("is refused at parse time when it is the only entity", async () => {
    await expect(parseFormSchema(orphaned)).rejects.toBeInstanceOf(FormSchemaError);
  });

  it("is refused at parse time when the rest of the form is reachable", async () => {
    await expect(parseFormSchema(alongside)).rejects.toBeInstanceOf(FormSchemaError);
  });

  it("is refused for the reason the library gives, not one of ours", async () => {
    await expect(parseFormSchema(orphaned)).rejects.toMatchObject({ reason: { code: "EmptyRoot" } });
    await expect(parseFormSchema(alongside)).rejects.toMatchObject({
      reason: { code: "UnreachableEntity" },
    });
  });

  it("is the answer that used to be silently discarded", async () => {
    // Branded by hand, which is what the old parser did for free. Kept as the
    // record of the failure: ok true, and the answer gone.
    const branded = orphaned as unknown as typeof schema;

    expect(await validateFieldValues(branded, { requester_note: "Rush job" })).toEqual({
      ok: true,
      values: {},
    });
  });
});

describe("a select whose options list is null", () => {
  /*
   * FIFTH ROUND, FINDING 1. This block used to claim `formBuilder.validateSchema`
   * runs BEFORE the attribute validators. It is the other way round, and the
   * mistake made the test vacuous: `validateSchema(blob, builder)` runs
   * shape → attributes → builder, so `optionsAttribute` had already turned
   * `null` into `[]` and the `Array.isArray` guard in builder.ts never ran.
   * Deleting that guard left all 73 tests passing — a test that cannot fail when
   * the thing it covers is removed is a false safety signal.
   *
   * The guard is nonetheless REAL, on the other path. `builderStore.validateSchema()`
   * also validates attributes first, but then hands the builder its OWN schema —
   * raw, un-normalised — and `optionsAttribute` accepts `options: null` without
   * complaint, so `null` arrives intact. That is the builder UI's save button,
   * and it is what the direct call below exercises.
   */
  const nullOptions = {
    entities: {
      [SELECT_ID]: blobEntity(
        { type: "select" },
        { key: "priority", label: "Priority", options: null },
      ),
    },
    root: [SELECT_ID],
  };

  it("is refused with a sentence we wrote, not a crash, on the raw builder path", () => {
    // Called the way the builder store calls it: no attribute normalisation in
    // between, so `options` is still `null` here. Drop the `Array.isArray` guard
    // and this is a TypeError about reading a property of null — the example
    // this file uses for an error we did not author.
    const raw = nullOptions as unknown as FormSchema;

    expect(() => formBuilder.validateSchema(raw)).toThrowError(
      "Priority needs at least one option.",
    );

    let thrown: unknown;
    try {
      formBuilder.validateSchema(raw);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(TypeError);
  });

  it("is refused on the parse path too, where the null has already become []", async () => {
    // Same sentence, different route to it: here `optionsAttribute` has run and
    // the guard that fires is `options.length === 0`.
    const result = await validateSchema(nullOptions, formBuilder);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason.code).toBe("InvalidSchema");
    if (result.reason.code !== "InvalidSchema") return;

    const schemaError = result.reason.payload.schemaError;

    expect(schemaError).not.toBeInstanceOf(TypeError);
    expect((schemaError as Error).message).toBe("Priority needs at least one option.");
  });

  it("never reaches the requester as a branded schema", async () => {
    await expect(parseFormSchema(nullOptions)).rejects.toBeInstanceOf(FormSchemaError);
  });
});

describe("a parentId or children list that is not an entity id", () => {
  /*
   * The library does not resolve a rejection for these — `validateEntityId`
   * THROWS a bare `Error`, which on the public submit path is a 500 where a
   * refusal was owed. `parseFormSchema` catches as well as checks, and reports
   * it under its own code because the library has none for it.
   */
  const badParent = {
    entities: { [NOTE_ID]: blobEntity({ parentId: "not-a-uuid" }) },
    root: [NOTE_ID],
  };

  const badChild = {
    entities: { [NOTE_ID]: blobEntity({ children: ["zzz"] }) },
    root: [NOTE_ID],
  };

  it("is refused rather than thrown out of the library", async () => {
    await expect(parseFormSchema(badParent)).rejects.toMatchObject({
      reason: { code: "Unreadable" },
    });
    await expect(parseFormSchema(badChild)).rejects.toMatchObject({
      reason: { code: "Unreadable" },
    });
  });

  it("is refused for a blob that is not an object at all", async () => {
    await expect(parseFormSchema(null)).rejects.toBeInstanceOf(FormSchemaError);
  });
});

describe("emptyFormSchema", () => {
  /*
   * A shared module-level object with a mutable array, in a process serving many
   * requests: one builder store adding a field to "the empty form" would have
   * added it to every other request's empty form. Same aliasing hazard the
   * `options` copies above defend against, one scope up.
   */
  it("hands out a fresh schema each time", () => {
    const first = emptyFormSchema();
    const second = emptyFormSchema();

    expect(first).not.toBe(second);
    expect(first.root).not.toBe(second.root);
    expect(first.entities).not.toBe(second.entities);
  });

  it("cannot be edited by one caller on behalf of the next", () => {
    (emptyFormSchema().root as string[]).push(NOTE_ID);

    expect(emptyFormSchema()).toEqual({ entities: {}, root: [] });
  });

  it("is a schema the library accepts", async () => {
    expect((await validateSchema(emptyFormSchema(), formBuilder)).success).toBe(true);
  });
});

describe("the parser accepts exactly what the library accepts", () => {
  /*
   * THE SEAM, PINNED. Findings 2 to 4 were all one thing: two validators with
   * two different opinions, and the parser branding what the library would go
   * on to reject or throw over. `parseFormSchema` delegates to `validateSchema`
   * so the two cannot differ — this is the test that fails if anyone puts a
   * pre-filter, a fast path or a second zod copy back in front of it.
   */
  const blobs: Array<[string, unknown]> = [
    ["a schema the builder produced", JSON.parse(JSON.stringify(schema)) as unknown],
    ["an empty form", emptyFormSchema()],
    ["an entity outside root", { entities: { [NOTE_ID]: blobEntity() }, root: [] }],
    [
      "an unreachable entity beside a reachable one",
      {
        entities: { [NOTE_ID]: blobEntity(), [OLD_ID]: blobEntity({}, { key: "old" }) },
        root: [NOTE_ID],
      },
    ],
    ["a root id with no entity", { entities: {}, root: [NOTE_ID] }],
    [
      "the same entity listed twice",
      { entities: { [NOTE_ID]: blobEntity() }, root: [NOTE_ID, NOTE_ID] },
    ],
    [
      "an entity id that is not a uuid",
      { entities: { "field-one": blobEntity() }, root: ["field-one"] },
    ],
    [
      "a parentId that is not a uuid",
      { entities: { [NOTE_ID]: blobEntity({ parentId: "nope" }) }, root: [NOTE_ID] },
    ],
    [
      "a child id that is not a uuid",
      { entities: { [NOTE_ID]: blobEntity({ children: ["zzz"] }) }, root: [NOTE_ID] },
    ],
    [
      "a key the column would refuse",
      { entities: { [NOTE_ID]: blobEntity({}, { key: "Requester Note" }) }, root: [NOTE_ID] },
    ],
    ["an empty key", { entities: { [NOTE_ID]: blobEntity({}, { key: "" }) }, root: [NOTE_ID] }],
    ["an empty label", { entities: { [NOTE_ID]: blobEntity({}, { label: "" }) }, root: [NOTE_ID] }],
    [
      "nullish attributes a SQL writer would leave",
      {
        entities: {
          [NOTE_ID]: blobEntity(
            {},
            { helpText: null, required: null, options: null, archived: null },
          ),
        },
        root: [NOTE_ID],
      },
    ],
    [
      "a select with no options",
      {
        entities: {
          [SELECT_ID]: blobEntity(
            { type: "select" },
            { key: "priority", label: "Priority", options: [] },
          ),
        },
        root: [SELECT_ID],
      },
    ],
    [
      "a select with a null options list",
      {
        entities: {
          [SELECT_ID]: blobEntity(
            { type: "select" },
            { key: "priority", label: "Priority", options: null },
          ),
        },
        root: [SELECT_ID],
      },
    ],
    [
      "an attribute the entity does not declare",
      { entities: { [NOTE_ID]: blobEntity({}, { bogus: 1 }) }, root: [NOTE_ID] },
    ],
    [
      "a field type that does not exist",
      { entities: { [NOTE_ID]: { type: "signature", attributes: {} } }, root: [NOTE_ID] },
    ],
    [
      "two fields sharing one key",
      {
        entities: { [NOTE_ID]: blobEntity(), [PRIORITY_ID]: blobEntity({}, { label: "Also note" }) },
        root: [NOTE_ID, PRIORITY_ID],
      },
    ],
    ["no root at all", { entities: {} }],
    ["a string", "nope"],
    ["null", null],
  ];

  /** Throwing counts as refusing, in both directions — that was the whole gap. */
  async function libraryAccepts(blob: unknown): Promise<boolean> {
    try {
      return (await validateSchema(blob, formBuilder)).success;
    } catch {
      return false;
    }
  }

  async function parserAccepts(blob: unknown): Promise<boolean> {
    try {
      await parseFormSchema(blob);
      return true;
    } catch (error) {
      // A refusal has to be OUR error type. Anything else escaping the parser is
      // a 500 on a page with no session behind it.
      expect(error).toBeInstanceOf(FormSchemaError);
      return false;
    }
  }

  it.each(blobs)("%s", async (_name, blob) => {
    expect(await parserAccepts(blob)).toBe(await libraryAccepts(blob));
  });

  it("covers both answers, so the equivalence is not vacuously true", async () => {
    const verdicts = await Promise.all(blobs.map(([, blob]) => libraryAccepts(blob)));

    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it("returns what the library returned, attribute defaults and all", async () => {
    const nullish = {
      entities: {
        [NOTE_ID]: blobEntity({}, { helpText: null, required: null, options: null, archived: null }),
      },
      root: [NOTE_ID],
    };
    const library = await validateSchema(nullish, formBuilder);

    expect(library.success).toBe(true);
    if (!library.success) return;
    expect(await parseFormSchema(nullish)).toEqual(library.data);
  });
});

/*
 * FIFTH REVIEW ROUND.
 *
 * Four of the five findings were one habit: a comment asserting the opposite of
 * what the code did, and a test written to the comment rather than to the code.
 * The library runs shape → attributes → the builder's own `validateSchema`, not
 * the other way round, and everything below is pinned against the real order.
 */

const TRIM_ID = "b1000000-0000-4000-8000-00000000000e";

describe("which validator speaks first", () => {
  /*
   * FINDING 2. The builder used to restate the `key` pattern with a tailored
   * message, on the premise that it ran before the attribute validators. It runs
   * after them, and they short-circuit — so the sentence was unreachable and the
   * comment above it was wrong. The rule now lives only in `keyAttribute`, which
   * is also the one place the builder UI can show it: beside the key input.
   *
   * This is the test that fails if the ordering assumption is ever inverted
   * again, and it is what makes the two blocks above non-vacuous.
   */
  const breaksBoth = {
    entities: {
      // A key the pattern refuses (an attribute rule) AND, alongside it, a
      // second field sharing that key (a cross-entity rule only the builder can
      // see). Exactly one of the two gets to be the answer.
      [NOTE_ID]: blobEntity({}, { key: "Requester Note" }),
      [PRIORITY_ID]: blobEntity({}, { key: "Requester Note", label: "Also note" }),
    },
    root: [NOTE_ID, PRIORITY_ID],
  };

  it("reports the attribute rule, because attributes run first", async () => {
    const result = await validateSchema(breaksBoth, formBuilder);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason.code).toBe("InvalidEntitiesAttributes");
  });

  it("carries the message the key input will show, not one the builder invented", async () => {
    const result = await validateSchema(
      { entities: { [NOTE_ID]: blobEntity({}, { key: "Requester Note" }) }, root: [NOTE_ID] },
      formBuilder,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason.code).toBe("InvalidEntitiesAttributes");
    if (result.reason.code !== "InvalidEntitiesAttributes") return;

    const errors = result.reason.payload.entitiesAttributesErrors[NOTE_ID];

    expect(extractErrorMessage(errors?.key)).toBe(FIELD_KEY_MESSAGE);
  });

  it("still lets the builder speak for the rule no attribute can see", async () => {
    // The duplicate-key rule is genuinely cross-entity, so it survives — and it
    // is reached once the keys themselves are legal.
    const duplicateOnly = {
      entities: {
        [NOTE_ID]: blobEntity(),
        [PRIORITY_ID]: blobEntity({}, { label: "Also note" }),
      },
      root: [NOTE_ID, PRIORITY_ID],
    };
    const result = await validateSchema(duplicateOnly, formBuilder);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason.code).toBe("InvalidSchema");
    if (result.reason.code !== "InvalidSchema") return;
    expect((result.reason.payload.schemaError as Error).message).toBe(
      'Two fields share the key "requester_note". Every field on a form needs its own.',
    );
  });
});

describe("a key with whitespace around it", () => {
  /*
   * FINDING 3, THE ONE THAT MATTERED. `keyAttribute` used to `.trim()`, so
   * `"  requester_note  "` PARSED — to `"requester_note"`. `field_key` is the
   * jsonb key `vizserve_pms_requests.field_values` files an answer under, so the
   * rewrite orphaned every answer already stored under the untrimmed key, and
   * did it silently: a missing key reads back as a blank answer, not an error.
   *
   * Refused now instead. Nothing legitimate is lost — the column's own CHECK
   * (`field_key ~ '^[a-z][a-z0-9_]*$'`) already forbids whitespace, so only the
   * unconstrained `schema` jsonb could ever carry one, and that is precisely the
   * blob that must be refused rather than quietly repaired.
   */
  const untrimmed = {
    entities: { [NOTE_ID]: blobEntity({}, { key: "  requester_note  " }) },
    root: [NOTE_ID],
  };

  it("is refused rather than rewritten", async () => {
    await expect(parseFormSchema(untrimmed)).rejects.toBeInstanceOf(FormSchemaError);
  });

  it("is refused as an attribute error, so the builder shows it on the key", async () => {
    await expect(parseFormSchema(untrimmed)).rejects.toMatchObject({
      reason: { code: "InvalidEntitiesAttributes" },
    });
  });

  it("never yields the trimmed key from either mint", async () => {
    // The whole failure was that one mint invented a key the other never saw.
    const fromRows = schemaFromFields([{ ...noteRow, field_key: "  requester_note  " }]);

    expect(fromRows.entities[NOTE_ID]?.attributes.key).toBe("  requester_note  ");
    await expect(parseFormSchema(untrimmed)).rejects.toBeInstanceOf(FormSchemaError);
  });
});

describe("an option with whitespace around it", () => {
  /*
   * FINDING 3, IN REVERSE. `optionsAttribute` used to `.trim()` each option, so
   * a form storing `"Low "` validated against the enum `"Low"` — and refused the
   * value its own control had just submitted, and refused the value already
   * sitting in `field_values` for every historical answer.
   *
   * Trimming on read was never harmless: `formFieldDraftSchema.options` trims on
   * WRITE, so everything the app stored was trimmed already and the read-side
   * trim was a no-op for it. The only values it could change were the ones the
   * app did not write — the ones that must be honoured verbatim, because
   * submissions are filed against them.
   *
   * Not refused either, unlike a key: an option is a value, no CHECK forbids
   * whitespace in one, and refusing would make the whole form unopenable over a
   * cosmetic oddity in one choice.
   */
  const untrimmedRow = row({
    id: TRIM_ID,
    field_key: "priority",
    label: "Priority",
    field_type: "select",
    options: ["Low ", "High"],
  });

  it("survives a full rows to jsonb to parse round trip unchanged", async () => {
    const blob = JSON.parse(JSON.stringify(schemaFromFields([untrimmedRow]))) as unknown;
    const parsed = await parseFormSchema(blob);

    expect(parsed.entities[TRIM_ID]?.attributes.options).toEqual(["Low ", "High"]);
  });

  it("accepts the value the form actually stores", async () => {
    const blob = JSON.parse(JSON.stringify(schemaFromFields([untrimmedRow]))) as unknown;
    const parsed = await parseFormSchema(blob);

    expect(await validateFieldValues(parsed, { priority: "Low " })).toEqual({
      ok: true,
      values: { priority: "Low " },
    });
  });

  it("no longer accepts the trimmed value the option list does not offer", async () => {
    const blob = JSON.parse(JSON.stringify(schemaFromFields([untrimmedRow]))) as unknown;
    const parsed = await parseFormSchema(blob);

    expect(await validateFieldValues(parsed, { priority: "Low" })).toEqual({
      ok: false,
      fieldErrors: { priority: "Choose one of the listed options." },
    });
  });

  it("still refuses an option that is empty rather than merely padded", async () => {
    await expect(
      parseFormSchema({
        entities: {
          [TRIM_ID]: blobEntity(
            { type: "select" },
            { key: "priority", label: "Priority", options: [""] },
          ),
        },
        root: [TRIM_ID],
      }),
    ).rejects.toBeInstanceOf(FormSchemaError);
  });
});

describe("the two mints agree on one input", () => {
  /*
   * FINDING 3, PINNED AT THE SEAM. `parseFormSchema` and `schemaFromFields` are
   * the only two functions that mint a `ParsedFormSchema`, and the trims made
   * them disagree about what the same form meant: rows said `"Low "`, the blob
   * said `"Low"`. Whichever one a caller happened to hold decided whether a
   * submission was accepted.
   *
   * Same input, both routes, identical output — including the padding.
   */
  const rows: FormFieldRow[] = [
    row({
      id: TRIM_ID,
      field_key: "priority",
      label: "Priority",
      field_type: "select",
      options: ["Low ", " High"],
      help_text: "Pick one",
      sort_order: 0,
    }),
  ];

  it("produces the same schema from rows as from the jsonb those rows become", async () => {
    const fromRows = schemaFromFields(rows);
    const fromBlob = await parseFormSchema(JSON.parse(JSON.stringify(fromRows)));

    expect(fromBlob).toEqual(fromRows);
  });

  it("validates the same answer the same way whichever mint produced it", async () => {
    const fromRows = schemaFromFields(rows);
    const fromBlob = await parseFormSchema(JSON.parse(JSON.stringify(fromRows)));

    expect(await validateFieldValues(fromBlob, { priority: "Low " })).toEqual(
      await validateFieldValues(fromRows, { priority: "Low " }),
    );
    expect(await validateFieldValues(fromBlob, { priority: "Low" })).toEqual(
      await validateFieldValues(fromRows, { priority: "Low" }),
    );
  });

  it("projects back to the rows it came from, padding included", () => {
    expect(fieldsFromSchema(schemaFromFields(rows))).toEqual(rows.map(projected));
  });
});

describe("the root array is copied, never shared", () => {
  /*
   * FINDING 4. The library's `validateSchemaShape` returns `{ entities, root }`
   * with `root` ALIASED to the caller's array, so `parseFormSchema` handed back a
   * branded schema that a later `blob.root.push(id)` could add a field to — a
   * schema the brand says was checked, carrying one that never was. `entities`
   * and every `options` array are already fresh; `root` was the one left over.
   */
  it("does not hand back the array it was given", async () => {
    const blob = { entities: { [NOTE_ID]: blobEntity() }, root: [NOTE_ID] };
    const parsed = await parseFormSchema(blob);

    expect(parsed.root).not.toBe(blob.root);
  });

  it("survives the caller mutating the blob afterwards", async () => {
    const blob = { entities: { [NOTE_ID]: blobEntity() }, root: [NOTE_ID] };
    const parsed = await parseFormSchema(blob);

    blob.root.push(OLD_ID);

    expect(parsed.root).toEqual([NOTE_ID]);
    expect(await validateFieldValues(parsed, { requester_note: "Rush job" })).toEqual({
      ok: true,
      values: { requester_note: "Rush job" },
    });
  });
});

describe("a root listing the same entity twice", () => {
  /*
   * FINDING 5. `fieldsFromSchema` projected one row per POSITION in `root`, so
   * `[A, A]` became two rows sharing the primary key `A` — which the Phase 1
   * `vizserve_pms_save_form_schema` would hand to Postgres as a duplicate insert.
   * `orderedEntities` in values.ts already de-duplicated by first position; the
   * projection now uses the same rule.
   */
  const duplicated = { ...schemaFromFields([noteRow, priorityRow]), root: [NOTE_ID, NOTE_ID] };

  it("projects one row, not one per mention", () => {
    expect(fieldsFromSchema(duplicated).map((field) => field.id)).toEqual([NOTE_ID]);
  });

  it("keeps sort_order dense, so a skipped id leaves no hole", () => {
    const withDangling = {
      ...schemaFromFields([noteRow, priorityRow]),
      root: [OLD_ID, NOTE_ID, NOTE_ID, PRIORITY_ID],
    };

    expect(fieldsFromSchema(withDangling).map((field) => field.sort_order)).toEqual([0, 1]);
  });

  it("resolves it the same way the translation layer does", () => {
    // Both sides pick the first mention, so a form read through either one
    // describes the same set of fields.
    expect(fieldsFromSchema(duplicated).map((field) => field.field_key)).toEqual([
      "requester_note",
    ]);
  });
});

/**
 * Round 4 — the projection is safe on a schema the library never normalised.
 *
 * Phase 2's save handler projects the BUILDER STORE's schema, and the store
 * hands out its raw blob: attribute validators have not run, so `options` may
 * be null and `label` simply absent. `fieldsFromSchema` promises in its own
 * doc comment to be safe standing alone, and until now it was not.
 */
describe("projecting a schema the attribute validators never touched", () => {
  const raw = (attributes: Record<string, unknown>): FormSchema =>
    ({
      entities: { "0e6a0d1c-6d3a-4a4f-9c3e-2b1a5f7c8d90": { type: "select", attributes } },
      root: ["0e6a0d1c-6d3a-4a4f-9c3e-2b1a5f7c8d90"],
    }) as unknown as FormSchema;

  it("does not throw when options is null", () => {
    expect(() => fieldsFromSchema(raw({ key: "choice", options: null }))).not.toThrow();
    expect(fieldsFromSchema(raw({ key: "choice", options: null }))[0].options).toEqual([]);
  });

  it("fills absent display text rather than writing undefined into a row", () => {
    const [row] = fieldsFromSchema(raw({ key: "choice", options: ["A"] }));

    expect(row.label).toBe("");
    expect(row.help_text).toBe("");
  });

  it("defaults a missing `required` to true, as the completeness rule does", () => {
    expect(fieldsFromSchema(raw({ key: "choice", options: ["A"] }))[0].is_required).toBe(true);
  });

  it("skips an entity with no key rather than filing answers under one it invented", () => {
    expect(fieldsFromSchema(raw({ options: ["A"] }))).toEqual([]);
  });
});

/**
 * Round 4 — display text is validated trim-aware but stored verbatim.
 *
 * A read-side trim on `label`/`helpText` made `fieldsFromSchema(parseFormSchema(blob))`
 * silently EDIT the stored row, and made the two mints disagree about the same
 * form. It is also what `buildFieldSchema` does: it interpolates `field.label`
 * untrimmed into every message.
 */
describe("a label with whitespace around it", () => {
  const padded: FormFieldRow[] = [
    {
      id: "3f2b1a09-7c4d-4e5f-8a9b-0c1d2e3f4a5b",
      field_key: "note",
      label: "  Note  ",
      field_type: "text",
      help_text: "  help  ",
      options: [],
      is_required: true,
      is_active: true,
      sort_order: 0,
      created_at: "2026-07-29T10:00:00Z",
    },
  ];

  it("survives a round trip through the jsonb blob unchanged", async () => {
    const blob = JSON.parse(JSON.stringify(schemaFromFields(padded)));

    expect(fieldsFromSchema(await parseFormSchema(blob))).toEqual(padded.map(projected));
  });

  it("means the same form whichever mint loaded it", async () => {
    const blob = JSON.parse(JSON.stringify(schemaFromFields(padded)));

    expect(await parseFormSchema(blob)).toEqual(schemaFromFields(padded));
  });

  it("still rejects a label that is only whitespace", async () => {
    const blank = schemaFromFields([{ ...padded[0], label: "   " }]);

    await expect(parseFormSchema(JSON.parse(JSON.stringify(blank)))).rejects.toBeInstanceOf(
      FormSchemaError,
    );
  });
});

/*
 * P7-66 Phase 3 — THE PUBLIC FORM'S MINT, AND THE ACTION BOUNDARY.
 *
 * `/request/[slug]` has no session and `anon` holds no table privileges, so
 * neither the browser nor the server action can read `vizserve_pms_forms.schema`
 * — both derive the schema from what `vizserve_pms_get_public_form` returns.
 * That makes `schemaFromPublicFields` a THIRD mint of `ParsedFormSchema`, and
 * the block above ("the two mints agree on one input") is exactly the reason
 * this one has to be pinned against them rather than trusted: a mint that
 * described the same form differently would have the renderer accept an answer
 * the builder's own rules refuse, or the reverse.
 */
function asPublicField(source: FormFieldRow): PublicFormField {
  // Field for field, `vizserve_pms_get_public_form`'s `jsonb_build_object`. It
  // returns neither `is_active` (it filters on it) nor `created_at`.
  return {
    id: source.id,
    label: source.label,
    field_key: source.field_key,
    field_type: source.field_type,
    help_text: source.help_text,
    options: source.options,
    is_required: source.is_required,
  };
}

describe("the public form's mint", () => {
  const publicRows = [noteRow, priorityRow];

  it("describes the same form the builder's mint does", () => {
    expect(schemaFromPublicFields(publicRows.map(asPublicField))).toEqual(
      schemaFromFields(publicRows),
    );
  });

  it("keeps the order the SQL function returned, rather than re-sorting", () => {
    /*
     * ⚠️ NOT A SHORTCUT. `vizserve_pms_get_public_form` already orders
     * `sort_order, created_at` — the first two of the three columns
     * `schemaFromFields` sorts by, and the order clients have been seeing since
     * the form went live. `PublicFormField` carries neither column, so
     * re-sorting here could only apply a WORSE rule to data already ordered by a
     * better one. Handing the fields over reversed must reverse the form.
     */
    expect(schemaFromPublicFields([...publicRows].reverse().map(asPublicField)).root).toEqual([
      PRIORITY_ID,
      NOTE_ID,
    ]);
  });

  it("validates a submission field-keyed in and field-keyed out", () => {
    // The whole §1 contract at the boundary `submitPublicRequest` sits on: an
    // entity id never appears in what the action receives or in what it stores.
    const publicSchema = schemaFromPublicFields(publicRows.map(asPublicField));

    return expect(
      validateFieldValues(publicSchema, { requester_note: "  Rush job  ", priority: "High" }),
    ).resolves.toEqual({
      ok: true,
      // Trimmed, because `textEntity` trims — which is what the browser-side
      // `buildSubmissionSchema` did before posting, and what the server now does
      // instead.
      values: { requester_note: "Rush job", priority: "High" },
    });
  });

  it("reports a bad answer against the field key the browser renders", () => {
    const publicSchema = schemaFromPublicFields(publicRows.map(asPublicField));

    return expect(
      validateFieldValues(publicSchema, { priority: "Urgent" }),
    ).resolves.toEqual({
      ok: false,
      fieldErrors: { priority: "Choose one of the listed options." },
    });
  });
});

/*
 * P7-66 Phase 3 — THE PAYLOAD MERGE, where the public form's two state owners
 * meet.
 *
 * `react-hook-form` holds the five fixed fields; the interpreter store holds the
 * per-form answers, keyed by entity id. Neither can see the other, so one
 * function joins them — and the property worth pinning is not that it copies
 * both halves across but that the halves CANNOT REACH EACH OTHER.
 */
describe("mergeSubmissionPayload", () => {
  const core = {
    requester_name: "Ana Cruz",
    requester_email: "ana@example.com",
    requester_org: "HFSE",
    title: "New banner",
    description: "For the open day",
    target_date: "2026-09-30",
  };

  it("puts the fixed fields flat and the answers under field_values", () => {
    // The shape `vizserve_pms_submit_request` has always read:
    // `p_payload ->> 'title'` and `p_payload -> 'field_values' -> field_key`.
    expect(mergeSubmissionPayload(core, schema, { [NOTE_ID]: "Rush job" })).toEqual({
      ...core,
      field_values: { requester_note: "Rush job" },
    });
  });

  it("keeps a field named like a fixed one out of the fixed one", () => {
    /*
     * ⚠️ THE COLLISION THE NESTING PREVENTS. Nothing stops a form carrying a
     * field keyed `title` — `FIELD_KEY_PATTERN` allows it and the fixed names
     * are not reserved — and a flat merge would have that answer silently
     * overwrite the requester's actual title, which is what the Team Leader
     * queue displays and what the client's acknowledgement email quotes.
     */
    const clashing = schemaFromFields([row({ id: OLD_ID, field_key: "title", label: "Headline" })]);
    const merged = mergeSubmissionPayload(core, clashing, { [OLD_ID]: "A headline" });

    expect(merged.title).toBe("New banner");
    expect(merged.field_values).toEqual({ title: "A headline" });
  });

  it("writes no key for an answer nobody gave", () => {
    // `toFieldValues` drops `undefined` rather than writing it, so an untouched
    // optional field does not land in the jsonb as a `null` that reads back as
    // an answer. Asserted here because the merge is the last place it could
    // creep back in.
    expect(mergeSubmissionPayload(core, schema, {}).field_values).toEqual({});
  });
});

/*
 * P7-66 — THE RETURN LEG, and the collision the merge above does NOT protect.
 *
 * `mergeSubmissionPayload` nests the per-form answers so a field keyed `title`
 * cannot overwrite the requester's actual title on the way OUT. `field_errors`
 * is FLAT, so on the way BACK there is no nesting to do the same job — the
 * ORDER the two owners are consulted in is the only thing that decides who gets
 * the message.
 */
describe("routeFieldErrors", () => {
  // Two of the five fixed names the public form registers with react-hook-form.
  // Named here rather than imported, so this pins the ORDER of the look-ups
  // rather than the contents of that list.
  const isCoreField = (key: string) => key === "title" || key === "requester_name";

  const clashing = schemaFromFields([row({ id: OLD_ID, field_key: "title", label: "Headline" })]);

  it("gives the key to the form's own field, not to the fixed input of that name", () => {
    /*
     * ⚠️ THE UNFIXABLE LOOP. Asking "is this a core name?" first put the
     * server's message on the core Title input while the blank per-form field
     * showed nothing. react-hook-form clears that message the moment the
     * requester edits the title it is sitting on, the field the server is
     * actually complaining about is still blank, and the server refuses again —
     * for ever, on a page with no session and no other way in.
     */
    expect(routeFieldErrors(clashing, { title: "Headline is required." }, isCoreField)).toEqual({
      entities: [{ entityId: OLD_ID, message: "Headline is required." }],
      core: [],
      unplaced: null,
    });
  });

  it("falls back to the fixed input when no field on the form claims the key", () => {
    // The mirror case, and the reason the fallback is safe: a core name reaches
    // it only when nothing else answers to that key.
    expect(routeFieldErrors(schema, { title: "A short title is required." }, isCoreField)).toEqual({
      entities: [],
      core: [{ name: "title", message: "A short title is required." }],
      unplaced: null,
    });
  });

  it("routes an ordinary per-form key to its entity", () => {
    expect(
      routeFieldErrors(schema, { priority: "Choose one of the listed options." }, isCoreField),
    ).toEqual({
      entities: [{ entityId: PRIORITY_ID, message: "Choose one of the listed options." }],
      core: [],
      unplaced: null,
    });
  });

  it("raises a message nothing on the page can show rather than dropping it", () => {
    // `attachments` is the live example — it used to be set on a
    // `field_values.attachments` path that renders nowhere, so the client was
    // refused with no reason shown.
    expect(
      routeFieldErrors(schema, { attachments: "Attach at least one file." }, isCoreField),
    ).toEqual({
      entities: [],
      core: [],
      unplaced: "Attach at least one file.",
    });
  });
});

/*
 * P7-66 — the `options` column as PostgREST hands it back, which is `Json` and
 * not `string[]`.
 */
describe("optionsFromRow", () => {
  it("reads the list the column is constrained to hold", () => {
    expect(optionsFromRow(["Poster", "Banner"])).toEqual(["Poster", "Banner"]);
  });

  it("refuses a list holding anything else rather than narrowing it away", () => {
    /*
     * ⚠️ WHY REFUSING BEATS FILTERING. The loader's filter looked like a
     * display-time courtesy, but the list it produced became the schema the
     * builder edits and the next save projects that schema back over the row —
     * so the entries it hid were dropped from the stored choices for good, and
     * every answer holding one stopped validating against its own form.
     */
    expect(optionsFromRow(["Poster", 3])).toBeNull();
    expect(optionsFromRow([null])).toBeNull();
  });

  it("refuses a value that is not an array at all", () => {
    expect(optionsFromRow(null)).toBeNull();
    expect(optionsFromRow({ 0: "Poster" })).toBeNull();
  });

  it("does not hand back the array it was given", () => {
    // Same rule as `schemaFromFields`: sharing the array would let a later
    // mutation reach into the schema this row became.
    const stored = ["Poster"];
    const read = optionsFromRow(stored);

    stored.push("Banner");

    expect(read).toEqual(["Poster"]);
  });
});

/*
 * P7-66 — "this form is closed" and "we could not tell" are different sentences
 * to a client, and the submit action used to say the first for both.
 */
describe("reading the public form RPC", () => {
  function response(fields: FormFieldRow[]) {
    return {
      id: "c1000000-0000-4000-8000-000000000001",
      name: "Design request",
      slug: "design-request",
      description: "",
      requires_attachment: false,
      attachment_rules: null,
      fields: fields.map(asPublicField),
    };
  }

  it("returns the same schema the mint would have produced", () => {
    const lookup = readPublicFormResponse({ data: response([noteRow, priorityRow]), error: null });

    expect(lookup).toEqual({
      status: "ok",
      schema: schemaFromPublicFields([noteRow, priorityRow].map(asPublicField)),
    });
  });

  it("calls a missing row closed — the one answer that really means closed", () => {
    // `vizserve_pms_get_public_form`'s `where` is `slug and is_public and
    // is_active`, character for character the lookup the submit RPC performs.
    expect(readPublicFormResponse({ data: null, error: null })).toEqual({ status: "closed" });
  });

  it("keeps a transient fault retryable instead of retiring a live form", () => {
    /*
     * ⚠️ THE REGRESSION THIS PINS. A PostgREST or connection fault used to come
     * back as `null` alongside "closed" and "did not parse", and all three
     * became `form_not_found` → "This form is no longer accepting submissions."
     * on four live published forms. A five-second blip told a client with a
     * typed-out request to stop trying.
     */
    expect(
      readPublicFormResponse({ data: null, error: { message: "fetch failed" } }),
    ).toEqual({ status: "unavailable", reason: "fetch failed" });
  });

  it("is unavailable, not closed, when the payload does not parse", () => {
    // Retrying will not help, but the form has not been retired and saying so
    // would retire one nobody retired. It is our bug: the reason is logged, not
    // shown.
    const lookup = readPublicFormResponse({ data: { slug: "design-request" }, error: null });

    expect(lookup.status).toBe("unavailable");
  });
});
