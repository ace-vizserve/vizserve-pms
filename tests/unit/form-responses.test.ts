import { describe, expect, it } from "vitest";

import type { FormSchema } from "@/lib/form-builder/builder";
import {
  answerFor,
  answeredKeysOf,
  formatResponseAnswer,
  rawAnswerFor,
  responseColumns,
  summariseResponses,
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

/*
 * ⚠️ THE NAMESPACED-COLUMN BLOCK IS GONE WITH THE TABLE IT GUARDED.
 *
 * It pinned `answerColumnId`, which prefixed every answer column's DataTable id
 * so a question keyed `submitted_by` could not collide with the flat table's
 * pinned identity column — duplicate TanStack ids, duplicate React keys, and an
 * answer cell painted `sticky left-0` over the frozen one.
 *
 * The flat table was replaced by Summary · Question · Individual
 * (`response-views.tsx`), none of which renders a per-question COLUMN at all:
 * the summary keys its sections by `field_key` directly, and there are no fixed
 * identity columns left for one to collide with. So the helper, its prefix and
 * their tests were deleted rather than kept green against nothing.
 *
 * The rule that DID survive the screen is the anonymity one, and it moved with
 * it: `responseViewsFor` is tested in `tests/unit/form-anonymity.test.ts`.
 */


// ---------------------------------------------------------------------------
// P7-66 — THE SUMMARY, WHICH IS WHERE THE NUMBERS COME FROM.
//
// The flat table this replaced needed no tests like these because it made no
// claims: it showed what was stored. A summary asserts things — "7 of 12 chose
// Home", "4 skipped" — and every one of those is a decision that can be wrong in
// a way nobody spots, because a confident number looks the same whether or not
// it is true.
// ---------------------------------------------------------------------------

/** A choice question, with its offered options. */
function choice(
  key: string,
  label: string,
  options: string[],
  type: "select" | "multiselect" = "select",
): FormSchema["entities"][string] {
  return {
    type,
    attributes: { key, label, helpText: "", required: false, options, archived: false },
  } as unknown as FormSchema["entities"][string];
}

const answers = (...values: Record<string, unknown>[]) =>
  values.map((field_values) => ({ field_values }));

describe("summariseResponses — choice questions", () => {
  const schema = schemaOf([["a", choice("pages", "Which pages?", ["Home", "Pricing", "Contact"])]]);

  it("counts each option, and keeps the ones nobody picked", () => {
    // "Nobody picked Contact" is a finding. A missing row is an absence somebody
    // has to notice.
    const [summary] = summariseResponses(
      schema,
      answers({ pages: "Home" }, { pages: "Home" }, { pages: "Pricing" }),
    );

    expect(summary!.kind).toBe("choice");
    if (summary!.kind !== "choice") return;

    expect(summary!.tallies).toEqual([
      { option: "Home", count: 2, offered: true },
      { option: "Pricing", count: 1, offered: true },
      { option: "Contact", count: 0, offered: true },
    ]);
  });

  it("keeps the form's own option order, not the order answers arrived in", () => {
    const [summary] = summariseResponses(schema, answers({ pages: "Contact" }));

    if (summary!.kind !== "choice") throw new Error("expected a choice summary");
    expect(summary!.tallies.map((tally) => tally.option)).toEqual([
      "Home",
      "Pricing",
      "Contact",
    ]);
  });

  it("⚠️ still counts an answer given under a choice since removed", () => {
    /*
     * Options are editable. An answer given under an option that has since been
     * deleted is still a real answer — dropping it would make the tallies
     * disagree with the number of people who answered, which is the one
     * arithmetic error on this page nobody would catch.
     */
    const [summary] = summariseResponses(
      schema,
      answers({ pages: "Home" }, { pages: "Careers" }),
    );

    if (summary!.kind !== "choice") throw new Error("expected a choice summary");

    expect(summary!.tallies.at(-1)).toEqual({ option: "Careers", count: 1, offered: false });
    // And it counts toward the total, so `answered` and the tallies agree.
    expect(summary!.answered).toBe(2);
  });

  it("counts a multiselect answer once per option chosen", () => {
    const multi = schemaOf([
      ["a", choice("pages", "Which pages?", ["Home", "Pricing"], "multiselect")],
    ]);

    const [summary] = summariseResponses(
      multi,
      answers({ pages: ["Home", "Pricing"] }, { pages: ["Home"] }),
    );

    if (summary!.kind !== "choice") throw new Error("expected a choice summary");

    expect(summary!.tallies).toEqual([
      { option: "Home", count: 2, offered: true },
      { option: "Pricing", count: 1, offered: true },
    ]);
    // ⚠️ THE TALLIES SUM TO MORE THAN `answered`, AND THAT IS THE POINT. It is
    // why the screen's percentage is against `answered` rather than the sum:
    // "60% of the people who answered chose Home" is the useful claim.
    expect(summary!.answered).toBe(2);
  });
});

describe("summariseResponses — what counts as an answer", () => {
  const schema = schemaOf([["a", entity("text", "note", "Notes")]]);

  it("counts blanks separately, so an optional question's skipping is visible", () => {
    const [summary] = summariseResponses(
      schema,
      answers({ note: "Yes" }, {}, { note: "" }, { note: "   " }),
    );

    expect(summary!.answered).toBe(1);
    expect(summary!.blank).toBe(3);
  });

  it("⚠️ treats the empty string an optional field stores as NOT answered", () => {
    /*
     * An optional email, date, select or number genuinely stores `""` — a ported
     * quirk documented in entities.ts. A rule that counted those would inflate
     * every optional question on every form, and the inflation would look
     * exactly like engagement.
     */
    const [summary] = summariseResponses(schema, answers({ note: "" }));

    expect(summary!.answered).toBe(0);
    expect(summary!.blank).toBe(1);
  });

  it("answered + blank is always the response count", () => {
    const summaries = summariseResponses(
      schemaOf([
        ["a", entity("text", "note", "Notes")],
        ["b", choice("pages", "Pages", ["Home"])],
      ]),
      answers({ note: "Yes" }, { pages: "Home" }, {}),
    );

    for (const summary of summaries) {
      expect(summary.answered + summary.blank).toBe(3);
    }
  });
});

describe("summariseResponses — free text", () => {
  const schema = schemaOf([["a", entity("text", "note", "Notes")]]);

  it("⚠️ returns an INDEX rather than a name, so the aggregation never sees one", () => {
    /*
     * The pure summary must not touch attribution: on an anonymous form there is
     * none, and on a named one the decision about whether to show it belongs to
     * the screen. An index is enough for the screen to attach an author and a
     * timestamp, and carries neither itself.
     */
    const [summary] = summariseResponses(schema, answers({}, { note: "Second" }));

    if (summary!.kind !== "text") throw new Error("expected a text summary");
    expect(summary!.answers).toEqual([{ responseIndex: 1, text: "Second" }]);
  });

  it("summarises an ORPHANED key as text, because nothing is left to say otherwise", () => {
    // The field was deleted; the answers under its key were not. There is no
    // option list to tally against, and inventing one from the values that
    // happen to be there would be a guess presented as a fact.
    const [summary] = summariseResponses(schemaOf([]), answers({ gone: "still here" }));

    expect(summary!.column.origin).toBe("orphan");
    expect(summary!.fieldType).toBeNull();
    expect(summary!.kind).toBe("text");
  });

  it("summarises an ARCHIVED question rather than dropping it", () => {
    // Its answers are still stored and still real. A summary that quietly
    // stopped counting them would report fewer answers than the form received.
    const schemaWithArchived = schemaOf([["a", entity("text", "note", "Notes", true)]]);

    const [summary] = summariseResponses(schemaWithArchived, answers({ note: "Kept" }));

    expect(summary!.column.origin).toBe("archived");
    expect(summary!.answered).toBe(1);
  });
});

describe("summariseResponses — dates", () => {
  const schema = schemaOf([["a", entity("date", "when", "When?")]]);

  it("reports the span, compared as strings because YYYY-MM-DD sorts that way", () => {
    const [summary] = summariseResponses(
      schema,
      answers({ when: "2026-09-30" }, { when: "2026-09-12" }, { when: "2026-12-01" }),
    );

    if (summary!.kind !== "date") throw new Error("expected a date summary");
    expect(summary!.earliest).toBe("2026-09-12");
    expect(summary!.latest).toBe("2026-12-01");
  });

  it("⚠️ ignores anything that is not that shape rather than guessing", () => {
    /*
     * `31/12/2026` would sort as the latest date on any form it appeared on, and
     * this never parses — which is the point. `lib/dates.ts` exists because
     * parsing a bare date wrong lands it on the previous day in any negative
     * offset; a comparison that never parses cannot make that mistake.
     */
    const [summary] = summariseResponses(
      schema,
      answers({ when: "2026-09-12" }, { when: "31/12/2026" }),
    );

    if (summary!.kind !== "date") throw new Error("expected a date summary");
    expect(summary!.latest).toBe("2026-09-12");
  });

  it("reports nulls when nobody gave a date", () => {
    const [summary] = summariseResponses(schema, answers({}, {}));

    if (summary!.kind !== "date") throw new Error("expected a date summary");
    expect(summary!.earliest).toBeNull();
    expect(summary!.latest).toBeNull();
  });
});

describe("rawAnswerFor", () => {
  it("hands back the stored value, unformatted", () => {
    // The tally needs the ARRAY, not "Home, Pricing" — formatting a multiselect
    // first would count the whole joined string as one option.
    expect(rawAnswerFor({ pages: ["Home", "Pricing"] }, "pages")).toEqual(["Home", "Pricing"]);
  });

  it("is undefined for a key nothing holds", () => {
    expect(rawAnswerFor({}, "pages")).toBeUndefined();
  });

  it("does not answer for an inherited property", () => {
    // `"constructor" in {}` is true on every object there has ever been, and
    // FIELD_KEY_PATTERN permits a field keyed `constructor`.
    expect(rawAnswerFor({}, "constructor")).toBeUndefined();
  });
});
