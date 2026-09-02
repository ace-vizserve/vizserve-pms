import { describe, expect, it } from "vitest";

import type { FormSchema } from "@/lib/form-builder/builder";
import { csvCell, responsesCsvFilename, responsesToCsv, toCsv } from "@/lib/form-builder/csv";

/**
 * P7-66 — THE ANSWER SHEET, AS A FILE.
 *
 * ⚠️ A SPREADSHEET IS THE ONE OUTPUT NOBODY PROOFREADS. A missing column, a name
 * on an anonymous form, an answer split across two cells by a comma — none of
 * those looks wrong in Excel, and all of them are things somebody then quotes in
 * a meeting. So the rules are pinned here rather than checked by opening one.
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

function schemaOf(entries: Array<[string, FormSchema["entities"][string]]>): FormSchema {
  return {
    entities: Object.fromEntries(entries),
    root: entries.map(([id]) => id),
  } as FormSchema;
}

/** Injected so the module never has to know about time zones. */
const stamp = (value: string) => value;

describe("csvCell — RFC 4180 quoting", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvCell("Home")).toBe("Home");
  });

  it("quotes a value containing a comma, so it stays one column", () => {
    expect(csvCell("Poster, banner and social")).toBe('"Poster, banner and social"');
  });

  it("quotes and doubles an embedded quote", () => {
    expect(csvCell('She said "yes"')).toBe('"She said ""yes"""');
  });

  it("quotes a value containing a newline, so it stays one ROW", () => {
    // The failure this prevents is the worst of the three: a long-text answer
    // with a line break in it silently becomes two records, and every column
    // after it shifts.
    expect(csvCell("Line one\nLine two")).toBe('"Line one\nLine two"');
  });

  it("writes an empty cell for null and undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("keeps a zero, which is an answer rather than an absence", () => {
    expect(csvCell(0)).toBe("0");
  });
});

describe("toCsv", () => {
  it("joins rows with CRLF, which is what RFC 4180 and Excel expect", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d");
  });
});

describe("responsesToCsv", () => {
  const schema = schemaOf([
    ["a", entity("text", "note", "Notes")],
    ["b", entity("select", "pages", "Which pages?")],
  ]);

  const responses = [
    {
      submitted_by: "user-1",
      submitted_at: "2026-09-02T09:14:00Z",
      field_values: { note: "All good", pages: "Home" },
    },
  ];

  it("puts the timestamp first, then the person, then the answers in form order", () => {
    const csv = responsesToCsv(schema, responses, {
      isAnonymous: false,
      names: { "user-1": "Riza Santos" },
      formatTimestamp: stamp,
    });

    expect(csv.split("\r\n")).toEqual([
      "Submitted at,Submitted by,Notes,Which pages?",
      "2026-09-02T09:14:00Z,Riza Santos,All good,Home",
    ]);
  });

  it("⚠️ has NO name column at all on an anonymous form", () => {
    /*
     * Not an empty column with a header over it. `submitted_by` is NULL on every
     * row because the INSERT policy refused to let a name be written — so a
     * "Submitted by" heading over a column of blanks would suggest the names
     * were withheld from the export rather than never recorded, which is the one
     * thing this setting exists to make untrue.
     */
    const csv = responsesToCsv(
      schema,
      [{ ...responses[0]!, submitted_by: null }],
      { isAnonymous: true, names: {}, formatTimestamp: stamp },
    );

    expect(csv).not.toContain("Submitted by");
    expect(csv.split("\r\n")[0]).toBe("Submitted at,Notes,Which pages?");
  });

  it("says so when the reader cannot resolve a name, rather than leaving a blank", () => {
    // A blank cell reads as "nobody answered this row". The response policy is
    // scoped by the FORM's department and the user policies by the READER's, so
    // this is a real and legitimate state on a company-wide survey.
    const csv = responsesToCsv(schema, responses, {
      isAnonymous: false,
      names: {},
      formatTimestamp: stamp,
    });

    expect(csv).toContain("Outside your department");
  });

  it("⚠️ keeps a column for an ARCHIVED question, and marks it", () => {
    /*
     * The answers people gave it are still stored. An export built from "the
     * questions the form currently asks" drops every one of them — and the file
     * looks complete, which is why this is a test rather than a comment.
     */
    const withArchived = schemaOf([["a", entity("text", "note", "Notes", true)]]);

    const csv = responsesToCsv(
      withArchived,
      [{ submitted_by: null, submitted_at: "t", field_values: { note: "Kept" } }],
      { isAnonymous: true, names: {}, formatTimestamp: stamp },
    );

    expect(csv.split("\r\n")[0]).toBe("Submitted at,Notes (archived)");
    expect(csv).toContain("Kept");
  });

  it("keeps a column for an ORPHANED key, marked as removed", () => {
    const csv = responsesToCsv(
      schemaOf([]),
      [{ submitted_by: null, submitted_at: "t", field_values: { gone: "still here" } }],
      { isAnonymous: true, names: {}, formatTimestamp: stamp },
    );

    expect(csv.split("\r\n")[0]).toBe("Submitted at,gone (removed)");
    expect(csv).toContain("still here");
  });

  it("writes an empty cell for a question somebody skipped", () => {
    const csv = responsesToCsv(
      schema,
      [{ submitted_by: null, submitted_at: "t", field_values: { note: "Only this" } }],
      { isAnonymous: true, names: {}, formatTimestamp: stamp },
    );

    expect(csv.split("\r\n")[1]).toBe("t,Only this,");
  });

  it("still produces a header when nobody has answered", () => {
    // An empty file is indistinguishable from a failed download.
    const csv = responsesToCsv(schema, [], {
      isAnonymous: false,
      names: {},
      formatTimestamp: stamp,
    });

    expect(csv).toBe("Submitted at,Submitted by,Notes,Which pages?");
  });

  it("quotes an answer containing a comma", () => {
    const csv = responsesToCsv(
      schema,
      [{ submitted_by: null, submitted_at: "t", field_values: { note: "One, two" } }],
      { isAnonymous: true, names: {}, formatTimestamp: stamp },
    );

    expect(csv).toContain('"One, two"');
  });
});

describe("responsesCsvFilename", () => {
  it("slugs the form name", () => {
    expect(responsesCsvFilename("Q3 Pulse Survey", "2026-09-02")).toBe(
      "q3-pulse-survey-answers-2026-09-02.csv",
    );
  });

  it("⚠️ strips characters that are illegal or hostile in a filename", () => {
    // The browser's `download` attribute takes whatever it is given, and a form
    // may legitimately be called "Design / Brand: intake".
    expect(responsesCsvFilename('Design / Brand: "intake"', "2026-09-02")).toBe(
      "design-brand-intake-answers-2026-09-02.csv",
    );
  });

  it("falls back rather than producing a nameless file", () => {
    expect(responsesCsvFilename("＊＊＊", "2026-09-02")).toBe("form-answers-2026-09-02.csv");
  });
});
