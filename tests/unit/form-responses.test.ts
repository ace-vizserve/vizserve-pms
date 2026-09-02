import { describe, expect, it } from "vitest";

import type { FormSchema } from "@/lib/form-builder/builder";
import { FIELD_KEY_PATTERN } from "@/lib/form-builder/attributes";
import {
  ANSWER_COLUMN_PREFIX,
  answerColumnId,
  answerFor,
  answeredKeysOf,
  formatResponseAnswer,
  RESPONSE_IDENTITY_COLUMN_IDS,
  responseColumns,
} from "@/lib/form-builder/responses";

/**
 * P7-66 Phase 4b — THE RESPONSES TABLE'S COLUMNS.
 *
 * The rule worth a test is "a column that vanishes takes its history with it".
 * Both ways it can vanish are silent: the table simply looks complete, and the
 * answers people gave are gone from the screen with nothing to notice.
 */

function entity(
  type: string,
  key: string,
  label: string,
  archived = false,
): FormSchema["entities"][string] {
  return {
    type,
    attributes: { key, label, helpText: "", required: false, options: [], archived },
  } as unknown as FormSchema["entities"][string];
}

function schemaOf(
  entries: Array<[string, FormSchema["entities"][string]]>,
  root?: string[],
): FormSchema {
  return {
    entities: Object.fromEntries(entries),
    root: root ?? entries.map(([id]) => id),
  } as FormSchema;
}

describe("responseColumns — form order, and nothing dropped", () => {
  it("follows the schema's root order, not the order of the entities record", () => {
    // `root` is the order the person answering saw. Reading a row across should
    // read like the form reads down.
    const schema = schemaOf(
      [
        ["c", entity("text", "third", "Third")],
        ["a", entity("text", "first", "First")],
        ["b", entity("text", "second", "Second")],
      ],
      ["a", "b", "c"],
    );

    expect(responseColumns(schema, []).map((column) => column.key)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("⚠️ KEEPS AN ARCHIVED FIELD, because its answers are still stored", () => {
    const schema = schemaOf([
      ["a", entity("text", "live", "Live")],
      ["b", entity("text", "retired", "Retired", true)],
    ]);

    const columns = responseColumns(schema, ["live", "retired"]);

    expect(columns.map((column) => column.key)).toEqual(["live", "retired"]);
    // Marked, so the header can say so in a word rather than in a colour.
    expect(columns[1].origin).toBe("archived");
  });

  it("⚠️ KEEPS A KEY WHOSE FIELD IS GONE ENTIRELY, as an orphan column", () => {
    // `vizserve_pms_form_field_protect` counts requests only, so a field on an
    // engagement form can be deleted while responses still hold its key.
    const schema = schemaOf([["a", entity("text", "still_here", "Still here")]]);

    const columns = responseColumns(schema, ["still_here", "deleted_field"]);

    expect(columns.map((column) => column.key)).toEqual(["still_here", "deleted_field"]);
    expect(columns[1].origin).toBe("orphan");
    // No label survives a deleted field, so the key is the header. Inventing
    // one would be a guess presented as a fact.
    expect(columns[1].label).toBe("deleted_field");
  });

  it("sorts orphans and puts them after every real field", () => {
    const schema = schemaOf([["a", entity("text", "kept", "Kept")]]);

    expect(responseColumns(schema, ["zeta", "alpha", "kept"]).map((c) => c.key)).toEqual([
      "kept",
      "alpha",
      "zeta",
    ]);
  });

  it("emits ONE column for a duplicated key, resolved to the first field", () => {
    // Matches `entityIdsByFieldKey`: one key in the stored object means one
    // answer, so a second column would render the same value twice.
    const schema = schemaOf([
      ["a", entity("text", "shared", "The first one")],
      ["b", entity("multiselect", "shared", "The second one")],
    ]);

    const columns = responseColumns(schema, ["shared"]);

    expect(columns).toHaveLength(1);
    expect(columns[0].label).toBe("The first one");
  });

  it("includes an entity missing from root rather than losing it", () => {
    const schema = schemaOf(
      [
        ["a", entity("text", "in_root", "In root")],
        ["b", entity("text", "orphaned_entity", "Not in root")],
      ],
      ["a"],
    );

    expect(responseColumns(schema, []).map((column) => column.key)).toEqual([
      "in_root",
      "orphaned_entity",
    ]);
  });

  it("survives a field legitimately keyed `constructor`", () => {
    // `FIELD_KEY_PATTERN` allows it, and `"constructor" in {}` is true on every
    // object there has ever been — the bug values.ts documents at length.
    const schema = schemaOf([["a", entity("text", "constructor", "Constructor")]]);

    expect(responseColumns(schema, ["constructor"]).map((column) => column.key)).toEqual([
      "constructor",
    ]);
    expect(answerFor({ constructor: "typed in" }, "constructor")).toBe("typed in");
    // And an answer that is genuinely absent stays absent rather than
    // resolving to the prototype's function.
    expect(answerFor({}, "constructor")).toBeNull();
  });
});

describe("answeredKeysOf", () => {
  it("collects every key across every response, de-duplicated", () => {
    expect(
      answeredKeysOf([
        { field_values: { a: 1, b: 2 } },
        { field_values: { b: 3, c: 4 } },
      ]).sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("ignores a field_values that is not an object", () => {
    expect(answeredKeysOf([{ field_values: null }, { field_values: [1, 2] }])).toEqual([]);
  });
});

describe("formatResponseAnswer — one stored answer, one line", () => {
  it("treats an empty string as no answer", () => {
    // An OPTIONAL email/date/select/number genuinely stores "" — a ported quirk
    // of buildFieldSchema. Rendering it as an answer would be a lie.
    expect(formatResponseAnswer("")).toBeNull();
    expect(formatResponseAnswer("   ")).toBeNull();
    expect(formatResponseAnswer(null)).toBeNull();
    expect(formatResponseAnswer(undefined)).toBeNull();
  });

  it("keeps a zero and a false, which are answers rather than absences", () => {
    expect(formatResponseAnswer(0)).toBe("0");
    expect(formatResponseAnswer(false)).toBe("No");
    expect(formatResponseAnswer(true)).toBe("Yes");
  });

  it("joins a multiselect, and drops empty members", () => {
    expect(formatResponseAnswer(["Design", "Copy"])).toBe("Design, Copy");
    expect(formatResponseAnswer([])).toBeNull();
    expect(formatResponseAnswer(["", "  "])).toBeNull();
  });

  it("shows a file receipt's NAME, never its id", () => {
    // The id is a UUID reference into the attachment tables. Never in front of
    // a person (design system §6).
    expect(
      formatResponseAnswer([
        { id: "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", name: "brief.pdf" },
        { id: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9", name: "logo.png" },
      ]),
    ).toBe("brief.pdf, logo.png");
  });

  it("never renders [object Object] for a shape nothing stores", () => {
    expect(formatResponseAnswer({ unexpected: true })).toBe("1 item");
  });
});

/**
 * ⚠️ AN ANSWER COLUMN MAY NEVER COLLIDE WITH AN IDENTITY COLUMN.
 *
 * `DataTable` uses `Column.key` as the TanStack column id and as the React key,
 * and it pins with `columns.find((c) => c.pin === "left")?.key`. The Responses
 * table pins `submitted_by`. `FIELD_KEY_PATTERN` permits a question keyed
 * `submitted_by`, so before `answerColumnId` a form could produce two columns
 * with that id — duplicate TanStack ids, duplicate React keys, and an ANSWER
 * cell painted `sticky left-0 z-20 bg-card` over the frozen identity column.
 */
describe("⚠️ answerColumnId — the answer columns are namespaced", () => {
  it("cannot produce either fixed column id, even for a field named after one", () => {
    for (const reserved of RESPONSE_IDENTITY_COLUMN_IDS) {
      // The exact collision: a legal field key spelled like a fixed column.
      expect(FIELD_KEY_PATTERN.test(reserved)).toBe(true);
      expect(answerColumnId(reserved)).not.toBe(reserved);
    }
  });

  it("is collision-proof by construction — a field key can never hold the prefix", () => {
    // Why this is a prefix rather than a reserved-word list: the list has to be
    // extended by hand the day a third fixed column is added, and the prefix
    // does not.
    expect(FIELD_KEY_PATTERN.test(ANSWER_COLUMN_PREFIX)).toBe(false);
    expect(FIELD_KEY_PATTERN.test(`${ANSWER_COLUMN_PREFIX}anything`)).toBe(false);
  });

  it("keeps every column id distinct on a form whose fields ARE the fixed names", () => {
    const schema = schemaOf([
      ["a", entity("text", "submitted_by", "Who did you thank?")],
      ["b", entity("date", "submitted_at", "When did it happen?")],
    ]);

    const ids = [
      ...RESPONSE_IDENTITY_COLUMN_IDS,
      ...responseColumns(schema, ["submitted_by", "submitted_at"]).map((column) =>
        answerColumnId(column.key),
      ),
    ];

    expect(new Set(ids).size).toBe(ids.length);
    // And the pinned column is still the identity one: `find` returns the first
    // match, so a duplicate id here is what used to move the freeze.
    expect(ids.filter((id) => id === RESPONSE_IDENTITY_COLUMN_IDS[0])).toHaveLength(1);
  });

  it("still round-trips to the storage key, which is what reads the answer", () => {
    // `answerFor(row.field_values, field.key)` keeps using the RAW key — the
    // namespace is a table-rendering concern and must never reach `field_values`.
    expect(answerColumnId("mood")).toBe(`${ANSWER_COLUMN_PREFIX}mood`);
    expect(answerFor({ mood: "good" }, "mood")).toBe("good");
    expect(answerFor({ mood: "good" }, answerColumnId("mood"))).toBeNull();
  });
});
