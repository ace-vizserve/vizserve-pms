import { describe, expect, it } from "vitest";

import type { FormSchema } from "@/lib/form-builder/builder";
import {
  answerFor,
  answeredKeysOf,
  formatResponseAnswer,
  responseColumns,
} from "@/lib/form-builder/responses";

/**
 * P7-66 — THE COLUMNS AND CELLS OF A FORM'S ANSWERS.
 *
 * The rule worth a test is "a column that vanishes takes its history with it".
 * Both ways it can vanish are silent: the FILE simply looks complete, and the
 * answers people gave are gone from it with nothing to notice.
 *
 * ⚠️ THE ONE CONSUMER IS NOW `lib/form-builder/csv.ts`, which is why these
 * matter MORE than they did rather than less. A missing column on a screen is a
 * thing somebody spots; a missing column in a spreadsheet somebody analyses next
 * month is not.
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
    // internal form can be deleted while responses still hold its key.
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

/*
 * ⚠️ THE SUMMARY BLOCK IS GONE WITH THE SCREEN IT FED — P7-66 Phase 4.
 *
 * Roughly 250 lines here pinned `summariseResponses` and `rawAnswerFor`:
 * per-question tallies with their denominator, retired choices still counted,
 * date spans, and what counts as an answer. All of it fed the Responses tab's
 * Summary · Question · Individual views.
 *
 * Ace, on reading that tab: "no need to capture all questions its hard to read
 * it." The tab is now a count and, on a named form, who answered; the answers
 * themselves are in the CSV export, which never went through `summariseResponses`
 * at all. So the functions were deleted rather than kept green against nothing —
 * a test suite guarding code no screen calls is how dead code survives a
 * clear-out.
 *
 * The rules that OUTLIVED the screen are still pinned, and above: `responseColumns`
 * (archived and orphaned questions keep their column), `answeredKeysOf` and
 * `formatResponseAnswer`/`answerFor` (what one stored value looks like in a
 * cell). Those are the export's rules, and the export is what people actually
 * read the answers with.
 *
 * `responseViewsFor` went the same way, out of `tests/unit/form-anonymity.test.ts`.
 * What it decided — that an anonymous form has no Individual view — is no longer
 * a decision: there are no views. The rule that survives it is the one the
 * Responses tab still obeys and the test file still pins, that anonymity is read
 * off `vizserve_pms_forms.is_anonymous` and NEVER off whether a row's
 * `submitted_by` happens to be null.
 */
