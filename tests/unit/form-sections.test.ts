import { describe, expect, it } from "vitest";

import { paginateFields } from "@/lib/form-builder/canvas";
import { responseColumns } from "@/lib/form-builder/responses";
import type { FormSchema } from "@/lib/form-builder/builder";
import { buildFieldSchema, type PublicFormField } from "@/lib/schemas/forms";

/**
 * P7-66 Phase 7 — SECTIONS, AND THE FOUR PLACES A PAGE BREAK COULD PRETEND TO
 * BE A QUESTION.
 *
 * A section is a row in `vizserve_pms_form_fields` with `field_type = 'section'`
 * (20260902150000). That is what makes the feature cheap — `save_form_schema`,
 * `reconcileFormSchema`, `schemaFromFields` and `planEntityReorder` all keep
 * working with no changes at all — and it is also the whole risk: everything
 * that assumes ONE ROW MEANS ONE ANSWER now has a row that means no answer.
 *
 * These are the four assumptions, and each has a failure that would ship
 * quietly:
 *
 *   1. `buildFieldSchema` — a section falling through to the `text` default
 *      makes every submission fail with "Your details is required." against a
 *      heading.
 *   2. `responseColumns` — a column per section is a heading over an em-dash on
 *      every row of the table and every line of the CSV export.
 *   3. The key collision in `responseColumns` — a section and a question with
 *      the same title derive the same key, and claiming it for the section
 *      DELETES the question's column and its answers from the export.
 *   4. `paginateFields` — the split the respondent walks through, which three
 *      screens share and must not disagree about.
 *
 * The database's own half of this is `vizserve_pms_form_fields_section_asks_nothing`
 * (20260902155000) and is not testable from here — `tests/db` runs against
 * LIVE production and is not run.
 */

function field(overrides: Partial<PublicFormField> & { field_key: string }): PublicFormField {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    label: overrides.field_key,
    field_type: "text",
    help_text: "",
    options: [],
    is_required: true,
    ...overrides,
  };
}

describe("buildFieldSchema · a page break demands nothing", () => {
  /*
   * The key IS in the shape — `buildSubmissionSchema` builds it from the form's
   * fields and a caller reading that shape should find every field in it — so
   * the guarantee is that it accepts absence, not that it is absent.
   */
  const schema = buildFieldSchema(
    field({ field_key: "your_details", field_type: "section", label: "Your details" }),
  );

  for (const [name, value] of [
    ["nothing at all", undefined],
    ["a blank", ""],
    ["null", null],
    ["something absurd", { unexpected: true }],
  ] as Array<[string, unknown]>) {
    it(`accepts ${name}`, () => {
      expect(schema.safeParse(value).success).toBe(true);
    });
  }

  it("is required:true on the row and still demands nothing", () => {
    /*
     * `is_required` cannot be true on a real section — the check constraint
     * refuses the row — but the schema must not depend on that being enforced.
     * A hand-edited row reaching a browser should page the form, not lock it.
     */
    const required = buildFieldSchema(
      field({ field_key: "s", field_type: "section", is_required: true }),
    );

    expect(required.safeParse(undefined).success).toBe(true);
  });
});

/** A schema in the shape `responseColumns` reads: `root` order plus entities. */
function schemaOf(
  fields: Array<{ id: string; type: string; key: string; label: string; archived?: boolean }>,
): FormSchema {
  return {
    root: fields.map((f) => f.id),
    entities: Object.fromEntries(
      fields.map((f) => [
        f.id,
        {
          type: f.type,
          attributes: {
            key: f.key,
            label: f.label,
            helpText: "",
            required: false,
            options: [],
            archived: f.archived ?? false,
          },
        },
      ]),
    ),
  } as unknown as FormSchema;
}

describe("responseColumns · a page break is not a column", () => {
  it("omits the section and keeps every question", () => {
    const schema = schemaOf([
      { id: "a", type: "section", key: "your_details", label: "Your details" },
      { id: "b", type: "text", key: "full_name", label: "Full name" },
      { id: "c", type: "section", key: "your_request", label: "Your request" },
      { id: "d", type: "textarea", key: "brief", label: "Brief" },
    ]);

    expect(responseColumns(schema, []).map((column) => column.key)).toEqual([
      "full_name",
      "brief",
    ]);
  });

  it("does not claim a key the section shares with a real question", () => {
    /*
     * ⚠️ THE ONE THAT LOSES DATA. A section titled "Your details" derives
     * `your_details`, and so does a question titled the same. `responseColumns`
     * claims a key once — first field in form order wins — so a section that
     * claimed on its way past would suppress the question's column, and the
     * answers under that key would vanish from the table AND from the CSV with
     * nothing on screen saying they had.
     */
    const schema = schemaOf([
      { id: "a", type: "section", key: "your_details", label: "Your details" },
      { id: "b", type: "text", key: "your_details", label: "Your details" },
    ]);

    const columns = responseColumns(schema, ["your_details"]);

    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({ key: "your_details", origin: "active" });
  });

  it("does not turn a section's key into an orphan column", () => {
    // Orphans are keys answers hold that no field claims. A section is skipped
    // rather than claimed, so the only thing that could put its key in this
    // list is an answer under it — and nothing writes one.
    const schema = schemaOf([{ id: "a", type: "section", key: "intro", label: "Intro" }]);

    expect(responseColumns(schema, [])).toEqual([]);
  });
});

describe("paginateFields", () => {
  const isBreak = (item: string) => item.startsWith("#");
  const heading = (item: string) => ({ title: item.slice(1), blurb: "" });

  it("returns one page for a form with no breaks", () => {
    const pages = paginateFields(["a", "b"], isBreak, heading);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({ title: "", blurb: "", items: ["a", "b"] });
  });

  it("returns one empty page for a form with no fields", () => {
    // The empty form somebody has just created is the first thing anybody sees;
    // a caller that has to handle "no pages" separately will get it wrong there.
    expect(paginateFields([], isBreak, heading)).toEqual([
      { title: "", blurb: "", items: [] },
    ]);
  });

  it("opens page one with a leading break rather than an empty page", () => {
    const pages = paginateFields(["#One", "a"], isBreak, heading);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toBe("One");
    expect(pages[0]!.items).toEqual(["#One", "a"]);
  });

  it("keeps the break row inside the page it opens", () => {
    // Both hosts render a page by handing its items to the same component map;
    // the heading is drawn by the section's own component, not a second one.
    const pages = paginateFields(["a", "#Two", "b"], isBreak, heading);

    expect(pages.map((page) => page.items)).toEqual([["a"], ["#Two", "b"]]);
  });

  it("splits on every break, including consecutive ones", () => {
    const pages = paginateFields(["#One", "#Two", "b"], isBreak, heading);

    expect(pages.map((page) => page.title)).toEqual(["One", "Two"]);
    // An empty page is a real page: a break with nothing under it is a form the
    // builder can produce, and swallowing it would make the preview disagree
    // with the canvas about how many pages there are.
    expect(pages.map((page) => page.items)).toEqual([["#One"], ["#Two", "b"]]);
  });

  it("ends a form on a trailing break", () => {
    const pages = paginateFields(["a", "#End"], isBreak, heading);

    expect(pages).toHaveLength(2);
    expect(pages[1]!.items).toEqual(["#End"]);
  });
});
