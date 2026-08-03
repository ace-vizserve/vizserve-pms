import { describe, expect, it } from "vitest";

import {
  buildSubmissionSchema,
  suggestFieldKey,
  type PublicForm,
  type PublicFormField,
} from "@/lib/schemas/forms";

/**
 * P0-12 — the Phase 1 contract (D3a).
 *
 * `buildSubmissionSchema` is the handoff artefact: the same generated schema
 * validates in the browser and in the server action. These tests pin its
 * behaviour so a change on one track cannot silently loosen the other.
 *
 * They do NOT stand in for `tests/db/submission.test.ts`. A `curl` loads neither
 * of these schemas — the database is the enforcement layer, this is the
 * usability layer.
 */

function field(overrides: Partial<PublicFormField> & { field_key: string }): PublicFormField {
  return {
    id: "b1000000-0000-4000-8000-000000000001",
    label: "Field",
    field_type: "text",
    help_text: "",
    options: [],
    is_required: true,
    ...overrides,
  };
}

function form(fields: PublicFormField[]): PublicForm {
  return {
    id: "c1000000-0000-4000-8000-000000000001",
    name: "Fixture",
    slug: "fixture",
    description: "",
    requires_attachment: false,
    fields,
  };
}

const core = {
  requester_name: "Juan dela Cruz",
  requester_email: "juan@example.com",
  requester_org: "HFSE",
  title: "A request",
  description: "Some detail",
  target_date: "2026-12-01",
};

describe("core fields every request carries", () => {
  it("accepts a complete core payload", () => {
    const schema = buildSubmissionSchema(form([]));
    expect(schema.safeParse({ ...core, field_values: {} }).success).toBe(true);
  });

  it("rejects a missing requester email", () => {
    // This is the Phase 4 identity. Without it "only the requestor may approve"
    // is unenforceable, which is why it is required on every form.
    const schema = buildSubmissionSchema(form([]));
    const result = schema.safeParse({ ...core, requester_email: "", field_values: {} });

    expect(result.success).toBe(false);
  });

  it("rejects a malformed requester email", () => {
    const schema = buildSubmissionSchema(form([]));
    expect(
      schema.safeParse({ ...core, requester_email: "not-an-email", field_values: {} }).success,
    ).toBe(false);
  });

  it("rejects a whitespace-only title", () => {
    const schema = buildSubmissionSchema(form([]));
    expect(schema.safeParse({ ...core, title: "   ", field_values: {} }).success).toBe(false);
  });

  it("rejects a missing target date", () => {
    const schema = buildSubmissionSchema(form([]));
    expect(schema.safeParse({ ...core, target_date: "", field_values: {} }).success).toBe(false);
  });
});

describe("generated per-field validation", () => {
  it("rejects a blank required text field", () => {
    const schema = buildSubmissionSchema(form([field({ field_key: "deliverable" })]));
    const result = schema.safeParse({ ...core, field_values: { deliverable: "" } });

    expect(result.success).toBe(false);
  });

  it("accepts an absent optional text field", () => {
    const schema = buildSubmissionSchema(
      form([field({ field_key: "notes", is_required: false })]),
    );
    expect(schema.safeParse({ ...core, field_values: {} }).success).toBe(true);
  });

  it("restricts a select to its offered options", () => {
    const schema = buildSubmissionSchema(
      form([
        field({
          field_key: "channel",
          field_type: "select",
          options: ["Facebook", "Instagram"],
        }),
      ]),
    );

    expect(schema.safeParse({ ...core, field_values: { channel: "Facebook" } }).success).toBe(true);
    expect(schema.safeParse({ ...core, field_values: { channel: "TikTok" } }).success).toBe(false);
  });

  it("requires at least one choice on a required multiselect", () => {
    const schema = buildSubmissionSchema(
      form([
        field({
          field_key: "sizes",
          field_type: "multiselect",
          options: ["A4", "A5"],
        }),
      ]),
    );

    expect(schema.safeParse({ ...core, field_values: { sizes: [] } }).success).toBe(false);
    expect(schema.safeParse({ ...core, field_values: { sizes: ["A4"] } }).success).toBe(true);
  });

  it("coerces a numeric string on a number field", () => {
    // Every HTML input hands back a string, including type=number.
    const schema = buildSubmissionSchema(
      form([field({ field_key: "quantity", field_type: "number" })]),
    );

    const result = schema.safeParse({ ...core, field_values: { quantity: "12" } });
    expect(result.success).toBe(true);
    expect(result.data!.field_values.quantity).toBe(12);
  });

  it("rejects non-numeric text on a number field", () => {
    const schema = buildSubmissionSchema(
      form([field({ field_key: "quantity", field_type: "number" })]),
    );
    expect(schema.safeParse({ ...core, field_values: { quantity: "twelve" } }).success).toBe(false);
  });

  it("requires at least one file reference on a required file field", () => {
    const schema = buildSubmissionSchema(
      form([field({ field_key: "brief", field_type: "file" })]),
    );

    expect(schema.safeParse({ ...core, field_values: { brief: [] } }).success).toBe(false);
    expect(
      schema.safeParse({
        ...core,
        field_values: {
          brief: [
            {
              field_key: "brief",
              storage_path: "requests/x/brief.pdf",
              filename: "brief.pdf",
              mime_type: "application/pdf",
              size_bytes: 1024,
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("regenerates from the form, so a newly required field starts failing", () => {
    // Forms are dynamic (D20). A cached schema is a schema that validates
    // against yesterday's form.
    const before = buildSubmissionSchema(
      form([field({ field_key: "notes", is_required: false })]),
    );
    const after = buildSubmissionSchema(form([field({ field_key: "notes", is_required: true })]));

    expect(before.safeParse({ ...core, field_values: {} }).success).toBe(true);
    expect(after.safeParse({ ...core, field_values: {} }).success).toBe(false);
  });
});

describe("suggestFieldKey", () => {
  it("derives a stable snake_case key", () => {
    expect(suggestFieldKey("Target Date")).toBe("target_date");
    expect(suggestFieldKey("Size / Format")).toBe("size_format");
  });

  it("never produces a key starting with a digit", () => {
    expect(suggestFieldKey("2nd approver")).toBe("f_2nd_approver");
  });

  it("falls back rather than returning an empty key", () => {
    expect(suggestFieldKey("!!!")).toBe("field");
  });
});
