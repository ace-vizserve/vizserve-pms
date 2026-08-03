import { z } from "zod";

/**
 * PHASE 1 CONTRACT.
 *
 * The handoff artefact between the two tracks (D3a, R11): agreed before either
 * side writes code, imported by both.
 *
 * The important one is `buildSubmissionSchema`. It generates a zod schema at
 * runtime from a form's fields, and the SAME schema validates in the browser
 * and on the server. That is how the completeness rule gets enforced twice
 * without being written twice — and the database function
 * `vizserve_pms_submit_request` is the third layer, because a `curl` never
 * loads either of these.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "date",
  "select",
  "multiselect",
  "file",
  "email",
  "number",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const fieldTypeSchema = z.enum(FIELD_TYPES);

/** A field as the public renderer receives it. */
export const publicFormFieldSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  field_key: z.string(),
  field_type: fieldTypeSchema,
  help_text: z.string().default(""),
  options: z.array(z.string()).default([]),
  is_required: z.boolean(),
});

export type PublicFormField = z.infer<typeof publicFormFieldSchema>;

/**
 * Upload limits, sent to the renderer so the picker can say "up to 10 MB each"
 * before someone waits for a 40 MB file to be rejected. Display only — the
 * server re-reads these against the actual bytes (P1-09).
 */
export const attachmentRulesSchema = z.object({
  max_bytes: z.number().int().positive().default(10 * 1024 * 1024),
  max_files: z.number().int().positive().default(10),
  allowed_mime_types: z.array(z.string()).default([]),
});

export type AttachmentRules = z.infer<typeof attachmentRulesSchema>;

export const publicFormSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().default(""),
  requires_attachment: z.boolean(),
  // Nullable so a form read before the P1-09 migration still parses rather than
  // rendering a not-found page.
  attachment_rules: attachmentRulesSchema.nullish(),
  fields: z.array(publicFormFieldSchema),
});

export type PublicForm = z.infer<typeof publicFormSchema>;

/**
 * Fields every client request carries regardless of what the form asks
 * (docs/01-updated-workflow.md §2.2). `requester_email` in particular is not
 * negotiable: it becomes the identity at the Phase 4 approval gate, and without
 * it "only the requestor may approve" is unenforceable.
 */
export const requestCoreSchema = z.object({
  requester_name: z.string().trim().min(1, "Your name is required."),
  requester_email: z.email("Enter a valid email address."),
  requester_org: z.string().trim().default("HFSE"),
  title: z.string().trim().min(1, "A short title is required."),
  description: z.string().trim().min(1, "A description is required."),
  target_date: z.string().min(1, "A target date is required."),
});

/**
 * A file the server has already accepted (P1-09).
 *
 * `id` is the whole security story. It is a receipt for an upload the server
 * measured itself, and it is the ONLY field `vizserve_pms_submit_request`
 * believes — filename, type and size are read back from the database, not from
 * this object.
 *
 * The rest of the fields are here so the picker can render "brief.pdf · 2.4 MB"
 * without a second round trip. Treat them as display data. An earlier version of
 * this schema carried a client-supplied `storage_path` and no id, which let a
 * submission attach any object in the bucket, including another request's.
 */
export const attachmentRefSchema = z.object({
  id: z.uuid(),
  field_key: z.string().nullable().optional(),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  size_bytes: z.number().int().positive(),
});

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/**
 * Builds the per-field half of the submission schema.
 *
 * Optional fields accept "" and undefined and normalise to undefined, so an
 * untouched input never lands in field_values as an empty string pretending to
 * be an answer.
 */
export function buildFieldSchema(field: PublicFormField): z.ZodTypeAny {
  const required = field.is_required;
  const requiredMessage = `${field.label} is required.`;

  const optionalise = <T extends z.ZodTypeAny>(schema: T) =>
    required ? schema : schema.optional();

  switch (field.field_type) {
    case "email": {
      const base = z.email(`${field.label} must be a valid email.`);
      return required ? base : z.union([z.literal(""), base]).optional();
    }

    case "number": {
      const base = z.coerce.number({ message: `${field.label} must be a number.` });
      return required ? base : z.union([z.literal(""), base]).optional();
    }

    case "date": {
      const base = z.string().min(1, requiredMessage);
      return required ? base : z.union([z.literal(""), base]).optional();
    }

    case "select": {
      if (field.options.length === 0) return z.any().optional();
      const base = z.enum(field.options as [string, ...string[]], {
        message: "Choose one of the listed options.",
      });
      return required ? base : z.union([z.literal(""), base]).optional();
    }

    case "multiselect": {
      const base = z.array(z.enum(field.options as [string, ...string[]]));
      return required ? base.min(1, requiredMessage) : base.default([]);
    }

    case "file":
      // Files are uploaded before submit and referenced by receipt id, so the
      // form value is the reference, not the blob.
      return optionalise(z.array(attachmentRefSchema).min(required ? 1 : 0, requiredMessage));

    case "textarea":
    case "text":
    default: {
      const base = z.string().trim().min(1, requiredMessage);
      return required ? base : z.string().trim().optional();
    }
  }
}

/**
 * The whole submission schema for one form — core fields plus the dynamic ones.
 *
 * Regenerated from `form_fields` on every render rather than cached, because
 * forms are dynamic (D20): a cached schema is a schema that validates against
 * yesterday's form.
 */
export function buildSubmissionSchema(form: PublicForm) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of form.fields) {
    shape[field.field_key] = buildFieldSchema(field);
  }

  return requestCoreSchema.extend({
    field_values: z.object(shape),
  });
}

export type SubmissionValues = z.infer<ReturnType<typeof buildSubmissionSchema>>;

/** What `vizserve_pms_submit_request` returns. */
export const submissionResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    request_id: z.uuid(),
    reference_no: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(["form_not_found", "rate_limited", "validation_failed"]),
    field_errors: z.record(z.string(), z.string()).optional(),
  }),
]);

export type SubmissionResult = z.infer<typeof submissionResultSchema>;

// ---------------------------------------------------------------------------
// Staff-side: form settings (P1-04) and the builder (P1-03).
// ---------------------------------------------------------------------------

export const formSettingsSchema = z.object({
  name: z.string().trim().min(1, "Give the form a name."),
  slug: z
    .string()
    .trim()
    .min(1, "A URL slug is required.")
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lower-case letters, numbers and hyphens."),
  description: z.string().trim().default(""),
  department_id: z.uuid("Choose the department that owns this form.").nullable(),
  reference_prefix: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]{1,7}$/, "2–8 upper-case letters or digits, e.g. COL."),
  is_public: z.boolean().default(true),
  is_active: z.boolean().default(false),
  requires_attachment: z.boolean().default(false),
  sla_days: z.coerce.number().int().min(1, "At least one day.").max(365),
});

export type FormSettingsInput = z.infer<typeof formSettingsSchema>;

export const formFieldDraftSchema = z
  .object({
    id: z.uuid().optional(),
    label: z.string().trim().min(1, "Give the field a label."),
    field_key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*$/, "Lower-case letters, numbers and underscores."),
    field_type: fieldTypeSchema,
    help_text: z.string().trim().default(""),
    options: z.array(z.string().trim().min(1)).default([]),
    is_required: z.boolean().default(true),
    is_active: z.boolean().default(true),
    sort_order: z.number().int().default(0),
  })
  .refine(
    (field) =>
      !["select", "multiselect"].includes(field.field_type) || field.options.length > 0,
    { message: "Add at least one option.", path: ["options"] },
  );

export type FormFieldDraft = z.infer<typeof formFieldDraftSchema>;

/** Derives a stable field_key from a label. Suggestion only — never automatic
 *  on an existing field, whose key is immutable once it has data (D20/R5). */
export function suggestFieldKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "f_$1")
      .slice(0, 48) || "field"
  );
}
