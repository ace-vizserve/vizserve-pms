import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { FormSchema } from "@/lib/form-builder/builder";

import {
  fieldsFromSchema,
  FormSchemaError,
  parseFormSchema,
  planEntityReorder,
  planFieldReorder,
  reconcileFormSchema,
  schemaFromFields,
  type EntityIndexMove,
  type FieldOrderUpdate,
  type FormFieldRow,
  type ProjectedFormFieldRow,
} from "@/lib/form-builder/schema";

/** The shipped migration, read so the models below can be pinned to it. */
const MIGRATION_PATH = "supabase/migrations/20260901150000_p7_66_form_schema.sql";
const MIGRATION = readFileSync(join(process.cwd(), MIGRATION_PATH), "utf8");

/**
 * SQL with every run of whitespace collapsed, so a fragment can be matched
 * without the test also asserting the migration's indentation.
 */
const SQL = MIGRATION.replace(/\s+/g, " ");

/**
 * P7-66 Phase 1 — the SQL side of the projection, checked from TypeScript.
 *
 * ⚠️ WHAT THIS FILE IS NOT. The Phase 1 exit criteria name "rows → schema →
 * rows is the identity, archived fields and ordering included" and
 * "`validateSchema` rejecting a bad key, a duplicate key and an option-less
 * select". ALL FOUR ARE ALREADY COVERED, in tests/unit/form-values-translation.
 * test.ts — `describe("rows to schema and back")` for the first and
 * `describe("validateSchema")` for the other three, which is where that file
 * says "Phase 1 extends this in tests/unit/form-schema.test.ts once the column
 * exists". Restating them here would give two copies to keep in step and no more
 * confidence than one, so this file EXTENDS rather than repeats.
 *
 * What is new in Phase 1 is that the projection now exists TWICE — once in
 * TypeScript and once in SQL, in
 * supabase/migrations/20260901150000_p7_66_form_schema.sql — and only one of
 * them can be run here. So this file pins the SQL's CONTRACT in the only way a
 * unit test can: it builds the exact jsonb the migration emits and asserts that
 * TypeScript reads it as the same form, and it pins the row set
 * `vizserve_pms_save_form_schema` has to produce for the cases the plan calls
 * out. If the SQL and these expectations disagree, the SQL is wrong.
 *
 * ⚠️ NONE OF THIS EXECUTES THE MIGRATION. The project in .env is live
 * production and tests/db/ is not run. Everything below is the SQL's output
 * MODELLED in TypeScript, so it catches a wrong attribute name, a dropped
 * archived field or a mis-ordered `root` — and cannot catch a syntax error, a
 * grant, or an RLS decision.
 */

const NOTE_ID = "c1000000-0000-4000-8000-000000000001";
const PRIORITY_ID = "c1000000-0000-4000-8000-000000000002";
const RETIRED_ID = "c1000000-0000-4000-8000-000000000003";
const ABSENT_ID = "c1000000-0000-4000-8000-0000000000ff";

/**
 * A `vizserve_pms_form_fields` row as it is read.
 *
 * `created_at` is no longer bolted on here: `FormFieldRow` REQUIRES it, because
 * it is one of the three columns the backfill orders by and the twins have to
 * break a tie the same way. See the type's own note.
 */
function storedRow(
  overrides: Partial<FormFieldRow> & { id: string; field_key: string },
): FormFieldRow {
  return {
    label: "A field",
    field_type: "text",
    help_text: "",
    options: [],
    is_required: true,
    is_active: true,
    sort_order: 0,
    created_at: "2026-07-29T10:00:00Z",
    ...overrides,
  };
}

/**
 * The row without its tiebreak column — written out longhand rather than by
 * rest-destructuring, so it doubles as the list of columns the projection
 * actually touches.
 *
 * `created_at` is an INPUT to the ordering and never an output of a save:
 * `vizserve_pms_save_form_schema` leaves the column alone on update and lets the
 * default fire on insert, so `fieldsFromSchema` has none to emit and its return
 * type is `ProjectedFormFieldRow`. This is what a round trip is compared against.
 */
function rowOf(row: FormFieldRow): ProjectedFormFieldRow {
  return {
    id: row.id,
    field_key: row.field_key,
    label: row.label,
    field_type: row.field_type,
    help_text: row.help_text,
    options: row.options,
    is_required: row.is_required,
    is_active: row.is_active,
    sort_order: row.sort_order,
  };
}

/**
 * THE BACKFILL, MODELLED.
 *
 * Every line here answers to one line of the migration's `update
 * vizserve_pms_forms … set schema = …`, and the whole point is that it is
 * written out longhand rather than by calling `schemaFromFields`: the test is
 * worthless if it builds its input with the function it is checking.
 *
 *   * the entity object is `{ type, attributes }` and NOTHING else — the id is
 *     the record key
 *   * all six attributes, named exactly as attributes.ts declares them
 *   * `archived` is `not is_active`, and there is no `is_active` attribute
 *   * `root` is ordered by `sort_order, created_at, id` — three columns,
 *     because live forms share `sort_order` values (the old builder inserted
 *     every field at the literal 999)
 */
function backfilledBlob(rows: ReadonlyArray<FormFieldRow>): unknown {
  const ordered = [...rows].sort(
    (a, b) =>
      a.sort_order - b.sort_order ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );

  return JSON.parse(
    JSON.stringify({
      entities: Object.fromEntries(
        ordered.map((row) => [
          row.id,
          {
            type: row.field_type,
            attributes: {
              key: row.field_key,
              label: row.label,
              helpText: row.help_text,
              required: row.is_required,
              options: row.options,
              archived: !row.is_active,
            },
          },
        ]),
      ),
      root: ordered.map((row) => row.id),
    }),
  );
}

const noteRow = storedRow({
  id: NOTE_ID,
  field_key: "requester_note",
  label: "Note",
  help_text: "Anything else we should know",
  is_required: false,
  sort_order: 0,
});

const priorityRow = storedRow({
  id: PRIORITY_ID,
  field_key: "priority",
  label: "Priority",
  field_type: "select",
  options: ["Low", "High"],
  sort_order: 1,
});

const retiredRow = storedRow({
  id: RETIRED_ID,
  field_key: "retired_question",
  label: "No longer asked",
  is_active: false,
  sort_order: 2,
});

const liveForm = [noteRow, priorityRow, retiredRow];

/*
 * A FORM WHOSE ROWS SHARE A `sort_order`, hoisted to module scope because the
 * seam below has to be checked against it and not only against `liveForm`.
 *
 * Seeded and hand-edited forms share `sort_order` values — the old builder
 * inserted every field at the literal 999 — so this is live data rather than a
 * hypothetical - and it is the ONLY shape on which the two twins could
 * disagree, because it is the only one where `sort_order` alone does not decide
 * the order. A seam test built from distinct `sort_order` values passes whatever
 * the tiebreak is, which is why it could not catch this.
 */
const tiedFirst = storedRow({
  // ⚠️ The LATER id, deliberately. `id` is the last tiebreak, so if
  // `created_at` were dropped from either twin this row would move to second and
  // the assertions below would say so. A tiebreak test whose columns agree with
  // each other proves nothing.
  id: "c1000000-0000-4000-8000-00000000000f",
  field_key: "asked_first",
  label: "First",
  sort_order: 0,
  created_at: "2026-07-29T10:00:00Z",
});

const tiedSecond = storedRow({
  id: "c1000000-0000-4000-8000-00000000000a",
  field_key: "asked_second",
  label: "Second",
  sort_order: 0,
  created_at: "2026-07-30T10:00:00Z",
});

const tiedForm = [tiedFirst, tiedSecond];

describe("the backfill produces a schema the app can read", () => {
  it("is accepted by the same parser the public submit path uses", async () => {
    await expect(parseFormSchema(backfilledBlob(liveForm))).resolves.toBeTruthy();
  });

  /*
   * THE SEAM. `schemaFromFields` is the TypeScript twin of the backfill, so the
   * two must produce the same form from the same rows. If they ever diverge —
   * an attribute renamed on one side, `archived` inverted, a stray `id` on the
   * entity — this is the assertion that says so, and it says so before the
   * migration is pasted into the SQL editor rather than after.
   */
  /*
   * DRIVEN OVER THE TIED FORM AS WELL AS THE DISTINCT ONE. With distinct
   * `sort_order` values this assertion held while the twins genuinely disagreed:
   * `schemaFromFields` sorted on `sort_order` alone, and `Array.prototype.sort`
   * being stable meant it merely preserved the order the rows were passed in,
   * whereas the SQL orders `sort_order, created_at, id`. Give it tied rows and
   * the two produce different `root` arrays. So the tie is the case the seam has
   * to cover, and `rowOf` no longer strips anything the twin needs: `created_at`
   * is a required column of `FormFieldRow` now.
   */
  it.each([
    { name: "distinct sort_order values", rows: liveForm },
    { name: "rows sharing a sort_order", rows: tiedForm },
    /*
     * THE PERMUTATION IS THE POINT, not decoration. The backfill sorts the rows
     * itself, so the blob is identical either way, while `schemaFromFields`
     * under the old stable-sort-on-one-column read the arrival order straight
     * through. Feeding the tie in the order it already wants therefore agreed by
     * luck; only the reversed one tests the tiebreak rather than the fixture.
     */
    {
      name: "rows sharing a sort_order, arriving in the other order",
      rows: [...tiedForm].reverse(),
    },
  ])("means the same form as schemaFromFields, the TypeScript twin ($name)", async ({ rows }) => {
    expect(await parseFormSchema(backfilledBlob(rows))).toEqual(schemaFromFields(rows));
  });

  it("round-trips back to the rows it was built from, archived field included", async () => {
    expect(fieldsFromSchema(await parseFormSchema(backfilledBlob(liveForm)))).toEqual(
      liveForm.map(rowOf),
    );
  });

  it("carries the archived field as `archived`, never as a dropped row", async () => {
    const parsed = await parseFormSchema(backfilledBlob(liveForm));

    expect(parsed.root).toContain(RETIRED_ID);
    expect(parsed.entities[RETIRED_ID]!.attributes.archived).toBe(true);
    // The row is what holds the historical answers, and what the R5 trigger
    // refuses to let go. Dropping it here makes the first save unsaveable.
    expect(fieldsFromSchema(parsed).map((field) => field.id)).toContain(RETIRED_ID);
  });
});

describe("the backfill's `root` ordering", () => {
  /*
   * `jsonb_agg` over a tie with no tiebreaker is free to order the two rows
   * differently on every run, which would make the backfilled field order a coin
   * toss on exactly the oldest forms. Hence three columns in the migration's
   * `order by`, and three in `schemaFromFields`.
   */
  it("breaks a sort_order tie by created_at, as the public form already does", async () => {
    // `vizserve_pms_get_public_form` renders `order by ff.sort_order,
    // ff.created_at`, so this is the order clients have been seeing.
    const parsed = await parseFormSchema(backfilledBlob([tiedSecond, tiedFirst]));

    expect(parsed.root).toEqual([tiedFirst.id, tiedSecond.id]);
  });

  it("re-derives a dense sort_order from that order, so the tie is gone after one save", async () => {
    const parsed = await parseFormSchema(backfilledBlob([tiedSecond, tiedFirst]));

    expect(fieldsFromSchema(parsed).map((field) => [field.field_key, field.sort_order])).toEqual([
      ["asked_first", 0],
      ["asked_second", 1],
    ]);
  });

  /*
   * THE TWIN HAS TO BE ORDER-BLIND, NOT MERELY ORDERED. A row set arrives from
   * Postgres in whatever order the planner produced: a `select` with no
   * `order by`, an index-only scan, a plan change after an ANALYZE - any of them
   * reshuffles tied rows. `schemaFromFields` sorting on `sort_order` alone was a
   * STABLE sort, so its output was a function of that arrival order rather than
   * of the rows, and the previous round's answer to that was a comment asking
   * Phase 2's loader to remember `order by sort_order, created_at, id`. It is a
   * property of the function now: both permutations below must give one answer,
   * and it must be the SQL's.
   */
  it("gives the same root whichever order the tied rows arrive in", () => {
    const forwards = schemaFromFields([tiedFirst, tiedSecond]);
    const backwards = schemaFromFields([tiedSecond, tiedFirst]);

    expect(forwards.root).toEqual([tiedFirst.id, tiedSecond.id]);
    expect(backwards).toEqual(forwards);
  });

  it("agrees with the backfill on a tie whichever order the rows arrive in", async () => {
    const fromSql = await parseFormSchema(backfilledBlob([tiedSecond, tiedFirst]));

    expect(schemaFromFields([tiedFirst, tiedSecond])).toEqual(fromSql);
    expect(schemaFromFields([tiedSecond, tiedFirst])).toEqual(fromSql);
  });

  it("falls through to id only when created_at ties too, as the SQL's third column does", async () => {
    // Same instant, so `id` decides - and `tiedSecond` holds the lower id, which
    // is why it comes FIRST here and second above. A twin that dropped either
    // column would fail one of these two tests.
    const sameInstant = { ...tiedSecond, created_at: tiedFirst.created_at };
    const rows = [tiedFirst, sameInstant];

    expect(schemaFromFields(rows).root).toEqual([sameInstant.id, tiedFirst.id]);
    expect(await parseFormSchema(backfilledBlob(rows))).toEqual(schemaFromFields(rows));
  });

  it("is the order-by the migration actually ships", () => {
    // The model above is only worth what the shipped SQL matches. Pinned so a
    // dropped column in either `order by` fails here rather than in production.
    expect(SQL).toContain("order by x.sort_order, x.created_at, x.id");
  });
});

describe("the two ways the backfill's jsonb could be shaped wrong", () => {
  /*
   * Both are pinned because both are one typo away in the migration, and both
   * fail LATER than they are made — the backfill succeeds, and the form is
   * unopenable the next time somebody clicks it.
   */
  it("refuses `is_active` where the attribute is called `archived`", async () => {
    const blob = backfilledBlob([noteRow]) as {
      entities: Record<string, { attributes: Record<string, unknown> }>;
    };
    delete blob.entities[NOTE_ID]!.attributes.archived;
    blob.entities[NOTE_ID]!.attributes.is_active = true;

    // `UnknownEntityAttributeType` — the entities declare six attributes and
    // the library refuses a seventh, which is why the backfill writes exactly
    // the six in attributes.ts and no column name from the table.
    await expect(parseFormSchema(blob)).rejects.toBeInstanceOf(FormSchemaError);
  });

  it("tolerates a stray `id` on the entity but silently drops it", async () => {
    /*
     * MEASURED, NOT ASSUMED, and the opposite of what the docs site's example
     * implies. `SchemaEntity` is `{ type, attributes, parentId?, children? }`;
     * an `id` inside the object is accepted and does not survive
     * normalisation. So writing one in the migration is not an error — it is
     * dead weight in the column that reads to the next person as though it
     * meant something. The backfill leaves it out for that reason, and this
     * test is what keeps the migration's comment honest.
     */
    const blob = backfilledBlob([noteRow]) as {
      entities: Record<string, Record<string, unknown>>;
    };
    blob.entities[NOTE_ID]!.id = NOTE_ID;

    expect(await parseFormSchema(blob)).toEqual(schemaFromFields([noteRow]));
  });
});

describe("the pre-flight queries report exactly what the parser refuses", () => {
  /*
   * The migration's pre-flight block exists because `parseFormSchema` is
   * STRICTER than the CHECK constraints on `vizserve_pms_form_fields`, in two
   * places. A pre-flight that under-reports is worse than none: it clears a
   * form the parser then refuses, and the failure surfaces in the builder as a
   * `FormSchemaError` with nothing to go on.
   *
   * So the shipped predicates are re-stated here in TypeScript and driven
   * against the parser over a table. Any label or option where the two disagree
   * fails a test.
   */

  /** The shipped query's predicate: `label ~ '^[[:space:]]*$'`. */
  const flaggedByLabelQuery = (label: string) => /^[\t\n\v\f\r ]*$/.test(label);

  /** The shipped query's predicate: `jsonb_typeof(o) <> 'string' or (o #>> '{}') = ''`. */
  const flaggedByOptionQuery = (option: unknown) => typeof option !== "string" || option === "";

  async function parses(blob: unknown): Promise<boolean> {
    try {
      await parseFormSchema(blob);
      return true;
    } catch {
      return false;
    }
  }

  it.each(["", " ", "  ", "\t", "\n", " \t ", "Note", " Note ", "0", "-"])(
    "agrees with the parser about the label %j",
    async (label) => {
      const blob = backfilledBlob([storedRow({ ...noteRow, label })]);

      expect(await parses(blob)).toBe(!flaggedByLabelQuery(label));
    },
  );

  it("is why the shipped label query is a regex and not btrim(label) = ''", async () => {
    /*
     * ⚠️ `btrim(label)` WITH NO SECOND ARGUMENT STRIPS SPACES ONLY. A label of
     * a single TAB is left untouched by it, so `btrim(label) = ''` reports
     * nothing — while `labelAttribute` uses JS `.trim()`, which strips tabs and
     * refuses the field. That is the pre-flight passing on a form the parser
     * will not open, which is the one failure mode a pre-flight must not have.
     */
    const naive = (label: string) => label.replace(/^ +| +$/g, "") === "";

    expect(naive("\t")).toBe(false);
    expect(flaggedByLabelQuery("\t")).toBe(true);
    expect(await parses(backfilledBlob([storedRow({ ...noteRow, label: "\t" })]))).toBe(false);
  });

  it.each([
    { options: ["Low", "High"], label: "two ordinary options" },
    { options: ["Low ", " High"], label: "options with padding, which must be kept verbatim" },
    { options: [""], label: "an option that is the empty string" },
    { options: ["Low", ""], label: "one good option and one empty" },
    { options: ["  "], label: "an option of only spaces, which is a legal choice" },
  ])("agrees with the parser about $label", async ({ options }) => {
    const blob = backfilledBlob([
      storedRow({ ...priorityRow, field_type: "select", options: options as string[] }),
    ]);

    expect(await parses(blob)).toBe(!options.some(flaggedByOptionQuery));
  });

  it("does not flag a padded option, which would be a destructive false positive", () => {
    /*
     * `selectEntity` builds `z.enum(options)`, so the accepted set IS the stored
     * set. A pre-flight that told the reader to "clean up" `"Low "` would move
     * the accepted set away from the answers already filed in `field_values`,
     * and the form would start refusing its own historical values. Hence exact
     * `= ''` in the query rather than `btrim(...) = ''`.
     */
    expect(flaggedByOptionQuery("Low ")).toBe(false);
    expect(flaggedByOptionQuery("  ")).toBe(false);
    expect(flaggedByOptionQuery("")).toBe(true);
  });
});

/**
 * THE PROJECTION, MODELLED - the other direction's `backfilledBlob`.
 *
 * `vizserve_pms_save_form_schema` builds `v_rows` through four CTEs and one
 * `jsonb_build_object`. Everything below answers to a line of that statement,
 * and it is written out longhand for the reason stated at the top of this file:
 * a test that builds its expectation with the function it is checking checks
 * nothing. The old version of the block beneath this one called
 * `fieldsFromSchema` for both sides, so inverting `is_active` in the migration
 * to `is distinct from to_jsonb(false)` left all 27 tests green - an RPC that
 * un-archived every archived field on the first save, with nothing to say so.
 *
 * The two boolean columns are not retyped at all: they are READ OUT OF THE
 * SHIPPED SQL by `booleanProjection` below, so the migration is what decides
 * what this model does. The rest is pinned by
 * `it("is the projection the migration actually ships")`.
 *
 * NOT MODELLED, deliberately: a `root` that is not an array and an `entities`
 * that is not an object. The SQL defends against both (`case when jsonb_typeof
 * ... else '[]'`) because it is handed raw jsonb; `fieldsFromSchema` takes a
 * typed `FormSchema` and would throw. The two cannot be compared there, so the
 * guards are modelled for faithfulness and never used as an agreement case.
 */

type SqlJson = Record<string, unknown>;

/**
 * `'<column>', (o.attributes -> '<attribute>') is distinct from to_jsonb(<v>)`,
 * lifted from the migration rather than copied by hand.
 *
 * `is distinct from` is null-safe, so an ABSENT attribute is distinct from the
 * literal and the column comes out true: absent means required, absent means
 * live. That is `?? true` on the TypeScript side, and it is why the operand is
 * `false` for `is_required` and `true` for `is_active` - the two read as
 * opposites and that asymmetry is exactly the typo worth catching.
 */
function booleanProjection(column: string): { attribute: string; distinctFrom: boolean } {
  const pattern = new RegExp(
    `'${column}', \\(o\\.attributes -> '([A-Za-z]+)'\\) is distinct from to_jsonb\\((true|false)\\)`,
  );
  const match = pattern.exec(SQL);

  if (!match) {
    throw new Error(
      `${MIGRATION_PATH} no longer projects '${column}' as an "is distinct from to_jsonb(...)" ` +
        "expression. Update this model to match the SQL, then re-check the row set below.",
    );
  }

  return { attribute: match[1]!, distinctFrom: match[2] === "true" };
}

const IS_REQUIRED = booleanProjection("is_required");
const IS_ACTIVE = booleanProjection("is_active");

/** `jsonb_typeof(x) = 'string' ? x ->> k : ''` - a non-string becomes `''`. */
function sqlText(attributes: SqlJson, key: string): string {
  return typeof attributes[key] === "string" ? (attributes[key] as string) : "";
}

/** The four CTEs and the `jsonb_build_object`, in the order the SQL runs them. */
function projectedBySql(schema: unknown): unknown[] {
  const blob = (typeof schema === "object" && schema !== null ? schema : {}) as SqlJson;

  // root_ids - `jsonb_array_elements(...) with ordinality as r(elem, pos)`,
  // guarded so a non-array `root` addresses nothing. `pos` is 1-based.
  const root = Array.isArray(blob.root) ? (blob.root as unknown[]) : [];
  const rootIds = root.map((elem, index) => ({
    // `r.elem #>> '{}'` - the element as text. A json `null` yields SQL NULL.
    entity_id: elem === null || elem === undefined ? null : String(elem),
    pos: index + 1,
  }));

  // first_mention - `where entity_id is not null group by entity_id`, keeping
  // `min(pos)`. First mention of a repeated id wins; a json null is dropped.
  const firstMention = new Map<string, number>();
  for (const { entity_id, pos } of rootIds) {
    if (entity_id === null) continue;
    if (!firstMention.has(entity_id)) firstMention.set(entity_id, pos);
  }

  // entity_map - the `entities` object, or `{}` if it is not one.
  const map = (
    typeof blob.entities === "object" && blob.entities !== null && !Array.isArray(blob.entities)
      ? blob.entities
      : {}
  ) as SqlJson;

  // resolved - `where jsonb_exists(em.map, fm.entity_id)`, which is exact own-key
  // membership and NOT a truthiness test: `entities['constructor']` is a
  // function on the JS side and simply not a key on the SQL side.
  const resolved = [...firstMention.entries()]
    .filter(([entityId]) => Object.hasOwn(map, entityId))
    .map(([entityId, pos]) => ({ entityId, pos, entity: map[entityId] as SqlJson }));

  // usable - `where jsonb_typeof(res.entity -> 'attributes' -> 'key') = 'string'`.
  const usable = resolved
    .map((row) => ({
      ...row,
      attributes: (typeof row.entity?.attributes === "object" && row.entity.attributes !== null
        ? row.entity.attributes
        : {}) as SqlJson,
    }))
    .filter((row) => typeof row.attributes.key === "string");

  // ordered - `(row_number() over (order by u.pos))::int - 1`, so `sort_order`
  // counts SURVIVING ROWS and is dense 0..n-1, never a position in `root`.
  return usable
    .sort((a, b) => a.pos - b.pos)
    .map(({ entityId, entity, attributes }, index) => ({
      id: entityId,
      field_key: attributes.key as string,
      label: sqlText(attributes, "label"),
      field_type: entity.type as string,
      help_text: sqlText(attributes, "helpText"),
      options: Array.isArray(attributes.options) ? (attributes.options as unknown[]) : [],
      is_required: attributes[IS_REQUIRED.attribute] !== IS_REQUIRED.distinctFrom,
      is_active: attributes[IS_ACTIVE.attribute] !== IS_ACTIVE.distinctFrom,
      sort_order: index,
    }));
}

describe("the row set vizserve_pms_save_form_schema has to produce", () => {
  /*
   * The four projection rules the plan names, exercised TOGETHER in one schema
   * and pinned as a single expected row set - because that combined result is
   * what the SQL's four CTEs (`first_mention`, `resolved`, `usable`, `ordered`)
   * have to reproduce between them, and the individual rules are each already
   * covered on their own in tests/unit/form-values-translation.test.ts
   * (`describe("a root listing the same entity twice")` and
   * `describe("projecting a schema the attribute validators never touched")`).
   *
   * THIS IS THE RAW BUILDER-STORE SHAPE, deliberately not run through
   * `parseFormSchema`. The RPC is handed the store's own schema, where the
   * attribute validators have not fired: `options` may be null and `label` may
   * simply be absent. That is the input the SQL has to survive, so it is the
   * input tested.
   */
  const raw = {
    entities: {
      [NOTE_ID]: {
        type: "text" as const,
        attributes: { key: "requester_note", options: null },
      },
      [PRIORITY_ID]: {
        type: "select" as const,
        attributes: {
          key: "priority",
          label: "Priority",
          helpText: "Pick one",
          required: false,
          options: ["Low", "High"],
          archived: true,
        },
      },
      // No `key`. The one attribute that cannot be defaulted - inventing one
      // files answers under a key nothing reads (§1).
      [RETIRED_ID]: { type: "text" as const, attributes: { label: "Nameless" } },
    },
    root: [
      NOTE_ID, // 1st mention wins
      ABSENT_ID, // dangling - no entity behind it
      NOTE_ID, // duplicate - skipped
      RETIRED_ID, // no key - skipped
      PRIORITY_ID,
    ],
  };

  /** What both sides have to produce, written down once and asserted twice. */
  const expected = [
    {
      id: NOTE_ID,
      field_key: "requester_note",
      // absent -> '' , not undefined and not null: the column is NOT NULL.
      label: "",
      field_type: "text",
      help_text: "",
      // null -> [] , which is why the SQL branches on
      // `jsonb_typeof(attributes -> 'options') = 'array'`.
      options: [],
      // absent -> true. `is distinct from false` in the SQL, mirroring `?? true`
      // - layer 1 of the completeness rule.
      is_required: true,
      is_active: true,
      sort_order: 0,
    },
    {
      id: PRIORITY_ID,
      field_key: "priority",
      label: "Priority",
      field_type: "select",
      help_text: "Pick one",
      options: ["Low", "High"],
      is_required: false,
      // `archived: true` -> `is_active: false`. The row survives; it is the
      // R5 guard's whole reason for existing.
      is_active: false,
      // 1, NOT 4. Dense, counting SURVIVING ROWS rather than positions in
      // `root` - `row_number()` over the CTE, never `ordinality`.
      sort_order: 1,
    },
  ];

  it("skips a duplicate, a dangling id and a keyless entity, and keeps sort_order dense", () => {
    expect(fieldsFromSchema(raw as unknown as FormSchema)).toEqual(expected);
  });

  /*
   * THE OTHER SEAM, and the one that was missing. The block above pins what
   * `fieldsFromSchema` does; this pins that the SQL projection - modelled from
   * the migration, with its two boolean expressions read straight out of the
   * file - produces the same rows. Without it the RPC half of this file was
   * `fieldsFromSchema` checked against itself.
   */
  it("is what the modelled SQL projection produces, rule for rule", () => {
    expect(projectedBySql(raw)).toEqual(expected);
  });

  it("means the same row set as fieldsFromSchema, the TypeScript twin", () => {
    expect(projectedBySql(raw)).toEqual(fieldsFromSchema(raw as unknown as FormSchema));
  });

  it("agrees with the twin on a schema the backfill itself produced", async () => {
    // The other direction's output fed straight in, so the two projections meet
    // on a realistic blob rather than only on the adversarial one above.
    const parsed = await parseFormSchema(backfilledBlob(liveForm));
    const asBlob = JSON.parse(JSON.stringify(parsed)) as unknown;

    expect(projectedBySql(asBlob)).toEqual(fieldsFromSchema(parsed));
    expect(projectedBySql(asBlob)).toEqual(liveForm.map(rowOf));
  });

  it("never projects two rows sharing a primary key", () => {
    const ids = fieldsFromSchema(raw as unknown as FormSchema).map((field) => field.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  /*
   * THE MODEL IS ONLY WORTH WHAT THE SHIPPED SQL MATCHES. Every expression the
   * model encodes is pinned to the migration text here, so editing the SQL
   * without editing the model fails loudly instead of leaving a model that
   * describes a projection nobody runs.
   */
  it("is the projection the migration actually ships", () => {
    expect(SQL).toContain("with ordinality as r(elem, pos)");
    expect(SQL).toContain("select entity_id, min(pos) as pos from root_ids");
    expect(SQL).toContain("where entity_id is not null");
    expect(SQL).toContain("where jsonb_exists(em.map, fm.entity_id)");
    expect(SQL).toContain("where jsonb_typeof(res.entity -> 'attributes' -> 'key') = 'string'");
    expect(SQL).toContain("(row_number() over (order by u.pos))::int - 1 as sort_order");

    expect(SQL).toContain("'id', o.entity_id,");
    expect(SQL).toContain("'field_key', o.attributes ->> 'key',");
    expect(SQL).toContain(
      "'label', case when jsonb_typeof(o.attributes -> 'label') = 'string' " +
        "then o.attributes ->> 'label' else '' end,",
    );
    expect(SQL).toContain("'field_type', o.entity ->> 'type',");
    expect(SQL).toContain(
      "'help_text', case when jsonb_typeof(o.attributes -> 'helpText') = 'string' " +
        "then o.attributes ->> 'helpText' else '' end,",
    );
    expect(SQL).toContain(
      "'options', case when jsonb_typeof(o.attributes -> 'options') = 'array' " +
        "then o.attributes -> 'options' else '[]'::jsonb end,",
    );
    expect(SQL).toContain("'sort_order', o.sort_order");
    expect(SQL).toContain("order by o.sort_order");
  });

  /*
   * The two booleans again, spelled out rather than only lifted by regex - so a
   * reader sees which literal belongs to which column, and so an inversion of
   * either fails with a message naming the column rather than a row diff.
   */
  it("keeps the two boolean defaults the right way round", () => {
    expect(SQL).toContain(
      "'is_required', (o.attributes -> 'required') is distinct from to_jsonb(false),",
    );
    expect(SQL).toContain(
      "'is_active', (o.attributes -> 'archived') is distinct from to_jsonb(true),",
    );

    expect(IS_REQUIRED).toEqual({ attribute: "required", distinctFrom: false });
    expect(IS_ACTIVE).toEqual({ attribute: "archived", distinctFrom: true });
  });
});

/*
 * `schemaFromFields` AS JSONB rather than as an object.
 *
 * Written for Phase 1's dual-write, which Phase 2 deleted, and kept because
 * `reconcileFormSchema` now rests on exactly the same equality: the loader calls
 * a stored blob CURRENT when it matches `schemaFromFields(rows)`, so if the two
 * were only usually the same the builder would report every healthy form as
 * stale — or, worse, a genuinely stale one as current.
 *
 * ⚠️ SERIALISED, DELIBERATELY. The seam test above compares the two twins after
 * the library has normalised one of them, which is the right check for the
 * projection and the wrong one for this: it would still pass if the raw object
 * carried an extra own property, an `undefined` attribute that JSON drops, or
 * anything else that does not survive `JSON.stringify` on its way into jsonb.
 */
describe("the blob schemaFromFields serialises to", () => {
  it.each([
    { name: "distinct sort_order values", rows: liveForm },
    { name: "rows sharing a sort_order", rows: tiedForm },
    { name: "rows sharing a sort_order, arriving in the other order", rows: [...tiedForm].reverse() },
  ])("is byte-for-byte the backfill's jsonb for the same rows ($name)", ({ rows }) => {
    expect(JSON.parse(JSON.stringify(schemaFromFields(rows)))).toEqual(backfilledBlob(rows));
  });

  /*
   * A form with no fields — what `createForm` leaves behind, and the one blob
   * the migration's re-run guard treats as "not yet backfilled". The dual-write
   * must reproduce that exact default rather than something merely equivalent,
   * or a form whose last field was deleted would look un-backfilled forever.
   */
  it("is the column default for a form with no fields", () => {
    expect(JSON.parse(JSON.stringify(schemaFromFields([])))).toEqual({ entities: {}, root: [] });
    expect(SQL).toContain(`default '{\"entities\": {}, \"root\": []}'::jsonb`);
  });
});

/*
 * P7-66 — THE REORDER RULE, on its own.
 *
 * Written for `moveField`, which was round trips wrapped around one decision —
 * and the decision was the part that was wrong. Phase 2 deleted the action and
 * kept the rule: `planEntityReorder` (tested at the end of this file) is the
 * builder store's reorder and is a thin adaptation of this function, so these
 * assertions still guard the live path. Rows in, `sort_order` writes out, no
 * database.
 *
 * ⚠️ EVERY ASSERTION BELOW IS ABOUT THE ORDER THE USER ENDS UP LOOKING AT, not
 * about the numbers. `orderAfter` applies the plan to the rows and then reads
 * the order back through `schemaFromFields`, the same projection that builds
 * the blob and the same `order by` the SQL and `vizserve_pms_get_public_form`
 * use — so a plan that writes plausible numbers in the wrong places fails here
 * rather than looking fine.
 */

/**
 * Rows as the builder actually creates them: `sort_order: 999` on every one,
 * because field-builder.tsx inserts new fields with that literal and nothing
 * renumbers until the first move.
 *
 * ⚠️ THE IDS DESCEND AS THE INTENDED ORDER ASCENDS. `id` is the last tiebreak,
 * so a plan that fell back to it — or that sorted on `sort_order` alone and
 * inherited the arrival order — would reverse this list and say so loudly.
 */
function movableRow(letter: string, index: number): FormFieldRow {
  return storedRow({
    id: `d1000000-0000-4000-8000-00000000000${(9 - index).toString(16)}`,
    field_key: `field_${letter}`,
    label: letter.toUpperCase(),
    sort_order: 999,
    created_at: `2026-07-2${index + 1}T10:00:00Z`,
  });
}

/** A, B, C, D, E — all tied at 999, separated only by `created_at`. */
const allTied = ["a", "b", "c", "d", "e"].map((letter, index) => movableRow(letter, index));

/** The same five after one previous move: dense, zero-based, no ties left. */
const alreadyDense = allTied.map((row, index) => ({ ...row, sort_order: index }));

/**
 * Applies a plan and reads the resulting order back as field keys.
 *
 * Deliberately routed through `schemaFromFields` rather than a local sort: the
 * question a reorder has to answer is "what will the form look like", and the
 * form's order is whatever that projection says it is.
 */
function orderAfter(
  rows: ReadonlyArray<FormFieldRow>,
  updates: ReadonlyArray<FieldOrderUpdate>,
): string[] {
  const written = new Map(updates.map((update) => [update.id, update.sort_order]));
  const applied = rows.map((row) => ({ ...row, sort_order: written.get(row.id) ?? row.sort_order }));
  const byId = new Map(applied.map((row) => [row.id, row.field_key]));

  return schemaFromFields(applied).root.map((id) => byId.get(id)!);
}

describe("planFieldReorder", () => {
  /*
   * ⚠️ THE REGRESSION THIS BLOCK EXISTS FOR.
   *
   * The shipped `moveField` renumbered ONLY the two swapped rows, to
   * `(position + 1) * 10`, and left everything else at 999. On this form —
   * which is every form the builder has ever produced, since 999 is what it
   * inserts — moving C up wrote C = 20 and B = 30 while A, D and E stayed at
   * 999, so BOTH swapped fields jumped in front of three fields nobody had
   * touched and the user saw `C B A D E`. The comment above the two updates
   * said the author knew ties were real; the fix only covered two rows.
   */
  it("moves one place, not to the front, when every row is tied at 999", () => {
    const updates = planFieldReorder(allTied, allTied[2]!.id, "up");

    expect(orderAfter(allTied, updates)).toEqual([
      "field_a",
      "field_c",
      "field_b",
      "field_d",
      "field_e",
    ]);
    // Not `C B A D E`, which is what renumbering two rows out of five produced.
    expect(orderAfter(allTied, updates)).not.toEqual([
      "field_c",
      "field_b",
      "field_a",
      "field_d",
      "field_e",
    ]);
  });

  it("renumbers every row densely when they were all tied", () => {
    // All five, because all five held a value that separated them from nothing.
    expect(planFieldReorder(allTied, allTied[2]!.id, "up")).toEqual([
      { id: allTied[0]!.id, sort_order: 0 },
      { id: allTied[2]!.id, sort_order: 1 },
      { id: allTied[1]!.id, sort_order: 2 },
      { id: allTied[3]!.id, sort_order: 3 },
      { id: allTied[4]!.id, sort_order: 4 },
    ]);
  });

  it("writes only the two rows that swap once the form is dense", () => {
    // The dense case is the one the old code was correct for, and it stays
    // cheap: a full renumbering is computed, but only the differences are sent.
    expect(planFieldReorder(alreadyDense, alreadyDense[2]!.id, "up")).toEqual([
      { id: alreadyDense[2]!.id, sort_order: 1 },
      { id: alreadyDense[1]!.id, sort_order: 2 },
    ]);
  });

  it("moves down as well as up", () => {
    const updates = planFieldReorder(alreadyDense, alreadyDense[1]!.id, "down");

    expect(orderAfter(alreadyDense, updates)).toEqual([
      "field_a",
      "field_c",
      "field_b",
      "field_d",
      "field_e",
    ]);
  });

  it("gives the same plan whichever order the rows arrive in", () => {
    // A row set arrives from Postgres in whatever order the planner produced.
    // The plan is a function of the rows, so a reshuffle must not change it.
    expect(planFieldReorder([...allTied].reverse(), allTied[2]!.id, "up")).toEqual(
      planFieldReorder(allTied, allTied[2]!.id, "up"),
    );
  });

  /*
   * A form that has been half-renumbered: some rows carry values from an
   * earlier move, the rest are still at the builder's 999. Ordering by
   * `sort_order, created_at, id` reads it as A, D, B, C, E.
   */
  const mixed = [
    { ...allTied[0]!, sort_order: 0 },
    allTied[1]!,
    allTied[2]!,
    { ...allTied[3]!, sort_order: 10 },
    allTied[4]!,
  ];

  it("picks the neighbour by the projection's order, not by sort_order alone", () => {
    expect(orderAfter(mixed, [])).toEqual(["field_a", "field_d", "field_b", "field_c", "field_e"]);

    // C's neighbour above is B — which `sort_order` alone cannot tell it, since
    // B, C and E all read 999.
    expect(orderAfter(mixed, planFieldReorder(mixed, allTied[2]!.id, "up"))).toEqual([
      "field_a",
      "field_d",
      "field_c",
      "field_b",
      "field_e",
    ]);
  });

  it.each([
    { name: "the first field, up", index: 0, direction: "up" as const },
    { name: "the last field, down", index: 4, direction: "down" as const },
  ])("plans nothing for $name", ({ index, direction }) => {
    expect(planFieldReorder(allTied, allTied[index]!.id, direction)).toEqual([]);
    expect(planFieldReorder(alreadyDense, alreadyDense[index]!.id, direction)).toEqual([]);
  });

  it("plans nothing for a field that is not on this form", () => {
    // Not an error: an id that is not on this form must simply move nothing,
    // and above all must not renumber the form on the strength of it.
    expect(planFieldReorder(allTied, ABSENT_ID, "up")).toEqual([]);
  });

  /*
   * The builder renders active and archived fields as two separate lists, and
   * only the active list carries move buttons. So the row above `field_b` on
   * screen is `field_a`, not the archived row sitting between them — swapping
   * into the archived row would be a click that visibly does nothing.
   */
  it("swaps past an archived field rather than into it", () => {
    const withArchived = [
      { ...allTied[0]!, sort_order: 0 },
      storedRow({
        id: "d1000000-0000-4000-8000-0000000000b0",
        field_key: "retired",
        is_active: false,
        sort_order: 1,
      }),
      { ...allTied[1]!, sort_order: 2 },
    ];

    expect(orderAfter(withArchived, planFieldReorder(withArchived, allTied[1]!.id, "up"))).toEqual([
      "field_b",
      // The archived row keeps its place in the overall order, and therefore in
      // the blob's `root`. Only the two visible rows trade places around it.
      "retired",
      "field_a",
    ]);
  });

  it("resolves a sort_order tie on the existing tied fixture", () => {
    // `tiedForm` is the pair the backfill tests use: same `sort_order`, ordered
    // by `created_at`. Moving the second one up must swap them and leave the
    // form with no tie left to disagree about.
    const updates = planFieldReorder(tiedForm, tiedSecond.id, "up");

    // ONE write, not two: both rows read 0, so the row moving to the front is
    // already holding the value it needs and only the other one is written.
    // The tie is what made them look interchangeable; writing 1 is what ends it.
    expect(updates).toEqual([{ id: tiedFirst.id, sort_order: 1 }]);
    expect(orderAfter(tiedForm, updates)).toEqual(["asked_second", "asked_first"]);
  });
});

/*
 * P7-66 Phase 2 — THE LOADER'S RECONCILE RULE.
 *
 * Phase 1's dual-write logged and swallowed a failed blob write, on the argument
 * that the next save re-derives it. The save that argument does not cover is the
 * LAST one before a form is published and left alone — and that form's stale
 * blob, opened in the builder and saved back, would have
 * `vizserve_pms_save_form_schema` project it over the rows and DELETE every
 * field it omits.
 *
 * ⚠️ SO THE ROWS ALWAYS WIN, and every assertion below is really about one of
 * two things: that the schema handed to the builder is the rows' whatever the
 * blob said, and that `storedWasCurrent` tells the truth about whether the blob
 * agreed. The second is not decoration — it is what turns a silent repair into a
 * line in the log saying a Phase 1 write never landed.
 *
 * `backfilledBlob` is reused rather than re-modelled: it is already this file's
 * longhand model of the jsonb the migration writes, so "the stored blob" and
 * "what the database would have put there" are the same object by construction.
 */
describe("reconcileFormSchema", () => {
  it("recognises the backfill's own jsonb as current", () => {
    const { schema, storedWasCurrent } = reconcileFormSchema(backfilledBlob(liveForm), liveForm);

    expect(storedWasCurrent).toBe(true);
    expect(schema).toEqual(schemaFromFields(liveForm));
  });

  it("is indifferent to the key order jsonb hands back", () => {
    // Postgres preserves nothing about object key order, so two byte-different
    // blobs routinely mean the same form. A `JSON.stringify` comparison would
    // call this stale and re-log a healthy form on every page load.
    const blob = backfilledBlob(liveForm) as { entities: Record<string, unknown>; root: string[] };
    const shuffled = {
      root: blob.root,
      entities: Object.fromEntries(Object.entries(blob.entities).reverse()),
    };

    expect(reconcileFormSchema(shuffled, liveForm).storedWasCurrent).toBe(true);
  });

  it("overrules a blob that has lost a field, and opens on the field", () => {
    // THE FAILURE THIS EXISTS FOR: an archived field missing from the blob. Save
    // that blob and the projection deletes a row holding historical answers —
    // or, once the R5 trigger refuses the delete, the form can never be saved
    // again.
    const stale = backfilledBlob([noteRow, priorityRow]);
    const { schema, storedWasCurrent } = reconcileFormSchema(stale, liveForm);

    expect(storedWasCurrent).toBe(false);
    expect(fieldsFromSchema(schema).map((field) => field.id)).toEqual([
      NOTE_ID,
      PRIORITY_ID,
      RETIRED_ID,
    ]);
  });

  it.each([
    {
      name: "a stale order",
      stale: backfilledBlob([
        { ...priorityRow, sort_order: 0 },
        { ...noteRow, sort_order: 1 },
        retiredRow,
      ]),
    },
    {
      name: "a stale label",
      stale: backfilledBlob([{ ...noteRow, label: "Yesterday's label" }, priorityRow, retiredRow]),
    },
    {
      name: "a stale option list",
      stale: backfilledBlob([
        noteRow,
        { ...priorityRow, options: ["Low", "High", "Urgent"] },
        retiredRow,
      ]),
    },
    {
      name: "a field that is archived in the rows and live in the blob",
      stale: backfilledBlob([noteRow, priorityRow, { ...retiredRow, is_active: true }]),
    },
    {
      // What the column default is, and what a form nobody has saved since the
      // migration would hold if the backfill had not run.
      name: "the empty default on a form that has fields",
      stale: { entities: {}, root: [] },
    },
    { name: "a blob that is not an object at all", stale: null },
  ])("overrules $name", ({ stale }) => {
    const { schema, storedWasCurrent } = reconcileFormSchema(stale, liveForm);

    expect(storedWasCurrent).toBe(false);
    expect(schema).toEqual(schemaFromFields(liveForm));
  });

  it("calls the empty default current for a form with no fields", () => {
    // Every live form is in exactly this state (measured 2026-09-02: four forms,
    // zero `vizserve_pms_form_fields` rows), so a reconcile that reported them
    // all as stale would log a warning per page load and cry wolf about the one
    // form that really was.
    expect(reconcileFormSchema({ entities: {}, root: [] }, []).storedWasCurrent).toBe(true);
  });
});

/*
 * P7-66 Phase 2 — the up/down buttons, now `setEntityIndex` calls.
 *
 * The RULE — the neighbour is the nearest field the user can SEE — is
 * `planFieldReorder`'s and is tested above against rows. What is new here is the
 * adaptation: root position as `sort_order`, and a swap expressed as an ORDERED
 * pair of remove-then-insert calls, which is what `setEntityIndex` does.
 *
 * `applyMoves` is that operation modelled — `Set.delete` then splice-insert,
 * exactly as the shipped `dist` does it — so the assertions are about the order
 * the user ends up looking at rather than about the numbers in the plan.
 */
function applyMoves(root: ReadonlyArray<string>, moves: ReadonlyArray<EntityIndexMove>): string[] {
  const next = [...root];

  for (const move of moves) {
    next.splice(next.indexOf(move.entityId), 1);
    next.splice(move.index, 0, move.entityId);
  }

  return next;
}

describe("planEntityReorder", () => {
  const denseSchema = schemaFromFields(alreadyDense);

  it("moves one field one place, not to the front", () => {
    const moves = planEntityReorder(denseSchema, alreadyDense[2]!.id, "up");

    expect(applyMoves(denseSchema.root, moves)).toEqual([
      alreadyDense[0]!.id,
      alreadyDense[2]!.id,
      alreadyDense[1]!.id,
      alreadyDense[3]!.id,
      alreadyDense[4]!.id,
    ]);
  });

  it("moves down as well as up", () => {
    const moves = planEntityReorder(denseSchema, alreadyDense[1]!.id, "down");

    expect(applyMoves(denseSchema.root, moves)).toEqual([
      alreadyDense[0]!.id,
      alreadyDense[2]!.id,
      alreadyDense[1]!.id,
      alreadyDense[3]!.id,
      alreadyDense[4]!.id,
    ]);
  });

  it("swaps past an archived field rather than into it", () => {
    // The builder renders active and archived as two lists and only the active
    // one carries move buttons, so the row above `priority` on screen is `note`
    // — swapping into the archived row would be a click that visibly does
    // nothing. The archived field keeps its place in `root`.
    const between = schemaFromFields([
      { ...noteRow, sort_order: 0 },
      { ...retiredRow, sort_order: 1 },
      { ...priorityRow, sort_order: 2 },
    ]);

    expect(applyMoves(between.root, planEntityReorder(between, PRIORITY_ID, "up"))).toEqual([
      PRIORITY_ID,
      RETIRED_ID,
      NOTE_ID,
    ]);
  });

  it.each([
    { name: "the first field, up", index: 0, direction: "up" as const },
    { name: "the last field, down", index: 4, direction: "down" as const },
  ])("plans nothing for $name", ({ index, direction }) => {
    expect(planEntityReorder(denseSchema, alreadyDense[index]!.id, direction)).toEqual([]);
  });

  it("plans nothing for an id that is not on this form", () => {
    expect(planEntityReorder(denseSchema, ABSENT_ID, "up")).toEqual([]);
  });
});
