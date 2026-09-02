import { validateEntitiesValues, validateSchema } from "@coltorapps/builder";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formBuilder } from "@/lib/form-builder/builder";
import { schemaFromFields, type FormFieldRow } from "@/lib/form-builder/schema";
import {
  buildFieldSchema,
  FIELD_TYPES,
  type FieldType,
  type PublicFormField,
} from "@/lib/schemas/forms";

/**
 * P7-63 Phase 0 — THE DELIVERABLE THAT MATTERS.
 *
 * `buildFieldSchema` has validated every client submission since Phase 1. The
 * eight entity validators in lib/form-builder/entities.ts replace it. This file
 * drives the same input through both and asserts they produce the same outcome
 * — accepted or refused, the same message, and the same parsed value.
 *
 * It is what makes Phase 5 safe: the old builders are deleted only once this
 * has held green, and a divergence found here is a divergence that would
 * otherwise have been found by a client whose submission stopped working.
 *
 * The comparison is a single deep equality on purpose. Asserting only
 * accept/reject would let a message drift; asserting only messages would let a
 * value change shape — an optional email that used to store "" quietly storing
 * undefined is exactly the kind of change that surfaces months later, when
 * somebody opens a historical request and finds an answer missing.
 */

const LABEL = "Your answer";
const FIELD_ID = "b1000000-0000-4000-8000-000000000001";

/** A file the server has already accepted — the receipt, not the blob. */
const ATTACHMENT_REF = {
  id: "a1000000-0000-4000-8000-000000000009",
  field_key: "answer",
  filename: "brief.pdf",
  mime_type: "application/pdf",
  size_bytes: 2400,
};

function row(field_type: FieldType, is_required: boolean, options: string[]): FormFieldRow {
  return {
    id: FIELD_ID,
    field_key: "answer",
    label: LABEL,
    field_type,
    help_text: "",
    options,
    is_required,
    is_active: true,
    sort_order: 0,
    // `created_at` is a required column of `FormFieldRow`: it is the second of
    // the three the backfill orders by, and `schemaFromFields` has to break a
    // `sort_order` tie the same way. Every row here is a form of one field, so
    // the value never decides anything - it is here because the compiler is the
    // reminder that a loader must select the column.
    created_at: "2026-07-29T10:00:00Z",
  };
}

/** The same field as the OLD renderer received it. */
function asPublicField(field: FormFieldRow): PublicFormField {
  return {
    id: field.id,
    label: field.label,
    field_key: field.field_key,
    field_type: field.field_type,
    help_text: field.help_text,
    options: field.options,
    is_required: field.is_required,
  };
}

type Outcome = { ok: boolean; data?: unknown; messages?: string[] };

function oldOutcome(field: FormFieldRow, input: unknown): Outcome {
  const result = buildFieldSchema(asPublicField(field)).safeParse(input);

  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, messages: result.error.issues.map((issue) => issue.message) };
}

async function newOutcome(field: FormFieldRow, input: unknown): Promise<Outcome> {
  const schema = schemaFromFields([field]);
  const result = await validateEntitiesValues({ [field.id]: input }, formBuilder, schema);

  if (result.success) return { ok: true, data: result.data[field.id] };

  // The library types an entity error as `unknown` — it is whatever `validate`
  // threw. Ours throw ZodError, and comparing the whole issue list rather than
  // just the first catches a branch that rejects for a second, different reason.
  const error = result.entitiesErrors[field.id];

  return {
    ok: false,
    messages:
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message)
        : [`not a ZodError: ${String(error)}`],
  };
}

/**
 * Every input each type is asked to survive: a good answer, a blank, an absent
 * one, and something of the wrong shape entirely.
 *
 * ⚠️ EVERY DISPLAY-ONLY TYPE IS EXCLUDED, AND THEIR CONTRACT IS ASSERTED IN
 * form-sections.test.ts AND form-media.test.ts INSTEAD.
 * This table exists to prove the entity validators agree with
 * `buildFieldSchema`. A page break has no validator to agree with: its
 * `shouldBeProcessed` is `() => false`, so the interpreter never calls
 * `validate` and never puts a key in its output — there is no outcome to
 * compare. Driving it through this harness would compare "the library skipped
 * it" against "zod accepted anything", which is two right answers to two
 * different questions.
 *
 * `Exclude` rather than an optional entry, so adding a NINTH answering type
 * still fails this file until its cases are written.
 */
const CASES: Record<
  Exclude<FieldType, "section" | "image" | "youtube">,
  { options: string[]; inputs: Array<[string, unknown]> }
> = {
  text: {
    options: [],
    inputs: [
      ["an answer", "Hello"],
      ["a blank", ""],
      ["whitespace only", "   "],
      ["nothing at all", undefined],
      ["null", null],
      ["a number", 42],
      ["an array", ["Hello"]],
    ],
  },
  textarea: {
    options: [],
    inputs: [
      ["an answer", "A longer answer, on one line."],
      ["a blank", ""],
      ["whitespace only", "   "],
      ["nothing at all", undefined],
      ["null", null],
      ["a number", 42],
    ],
  },
  date: {
    options: [],
    inputs: [
      ["a date", "2026-12-01"],
      ["a blank", ""],
      ["nothing at all", undefined],
      ["null", null],
      ["a number", 42],
    ],
  },
  select: {
    options: ["Alpha", "Beta"],
    inputs: [
      ["a listed option", "Alpha"],
      ["an unlisted option", "Gamma"],
      ["a blank", ""],
      ["nothing at all", undefined],
      ["null", null],
      ["a number", 42],
    ],
  },
  multiselect: {
    options: ["Alpha", "Beta"],
    inputs: [
      ["one option", ["Alpha"]],
      ["both options", ["Alpha", "Beta"]],
      ["an empty selection", []],
      ["an unlisted option", ["Gamma"]],
      ["a bare string", "Alpha"],
      ["a blank", ""],
      ["nothing at all", undefined],
      ["null", null],
    ],
  },
  file: {
    options: [],
    inputs: [
      ["one reference", [ATTACHMENT_REF]],
      ["no references", []],
      ["a reference with no id", [{ ...ATTACHMENT_REF, id: undefined }]],
      ["a blank", ""],
      ["nothing at all", undefined],
      ["null", null],
    ],
  },
  email: {
    options: [],
    inputs: [
      ["an address", "someone@example.com"],
      ["not an address", "nope"],
      ["a blank", ""],
      ["nothing at all", undefined],
      ["null", null],
      ["a number", 42],
    ],
  },
  number: {
    options: [],
    inputs: [
      ["a number", 7],
      ["a numeric string", "7"],
      ["not a number", "abc"],
      ["a blank", ""],
      ["nothing at all", undefined],
      ["null", null],
    ],
  },
};

describe("entity validators match buildFieldSchema", () => {
  for (const fieldType of FIELD_TYPES) {
    /*
     * Every display-only type, for the reason above: there is no validator to
     * agree with, so there is no outcome to compare.
     *
     * ⚠️ SPELLED OUT RATHER THAN `isDisplayOnly(fieldType)`. The helper returns a
     * boolean, which does not narrow `fieldType` — so `CASES[fieldType]` below
     * would still be indexed by the full union and fail. Listing them keeps the
     * `Exclude` on `CASES` doing its job: adding a tenth ANSWERING type still
     * fails this file until its cases are written.
     */
    if (fieldType === "section" || fieldType === "image" || fieldType === "youtube") continue;

    describe(fieldType, () => {
      for (const required of [true, false]) {
        for (const [name, input] of CASES[fieldType].inputs) {
          it(`${required ? "required" : "optional"} · ${name}`, async () => {
            const field = row(fieldType, required, CASES[fieldType].options);

            expect(await newOutcome(field, input)).toEqual(oldOutcome(field, input));
          });
        }
      }
    });
  }
});

describe("the option-less select branch", () => {
  /*
   * `buildFieldSchema` degenerates to `z.any().optional()` when a select has no
   * options, and the port keeps that. It is unreachable through the builder —
   * see the guard below — but a form built before the option rule existed can
   * still be sitting in the database.
   */
  const inputs: Array<[string, unknown]> = [
    ["a value", "Anything"],
    ["a blank", ""],
    ["nothing at all", undefined],
    ["a number", 42],
  ];

  for (const required of [true, false]) {
    for (const [name, input] of inputs) {
      it(`${required ? "required" : "optional"} · ${name}`, async () => {
        const field = row("select", required, []);

        expect(await newOutcome(field, input)).toEqual(oldOutcome(field, input));
      });
    }
  }

  it("cannot be saved through the builder in the first place", async () => {
    const result = await validateSchema(schemaFromFields([row("select", true, [])]), formBuilder);

    expect(result.success).toBe(false);
  });
});

describe("an option-less multiselect", () => {
  /*
   * Not in the parity table above, deliberately: `z.enum([])` accepts nothing,
   * so every answer fails on BOTH sides and the case would assert nothing about
   * the port. What is worth pinning is that the builder refuses to produce one.
   */
  it("cannot be saved through the builder", async () => {
    const result = await validateSchema(
      schemaFromFields([row("multiselect", true, [])]),
      formBuilder,
    );

    expect(result.success).toBe(false);
  });
});
