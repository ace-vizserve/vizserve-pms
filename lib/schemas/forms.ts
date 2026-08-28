import { z } from "zod";

import {
  MAX_SLA_MINUTES,
  MIN_SLA_MINUTES,
  parseSlaDuration,
} from "@/lib/schemas/duration";

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
    /**
     * P7-51. The tracking page URL, added by the server action AFTER the
     * database function returns — the raw token exists for one instant and is
     * never stored, so it cannot come out of `vizserve_pms_submit_request`.
     *
     * Optional because the token issue is best-effort: if it fails, the
     * request is still submitted and the email simply carries no link. A
     * missing tracking page must never fail a submission.
     */
    status_url: z.string().optional(),
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

/**
 * P7-31 — the SLA as a duration, not a count of days.
 *
 * Accepts `5d`, `8h`, `2d 4h`; stores MINUTES, where a day is 480 of them (a
 * working day — see lib/schemas/duration.ts). A number is accepted unchanged
 * so a caller already holding minutes can re-validate without formatting them
 * back into a string first.
 *
 * The transform is why the form binds to `FormSettingsValues` below: what the
 * input holds is a string, what the database gets is a number.
 */
const SLA_MESSAGE = "Use a duration like 5d, 8h or 2d 4h — up to 365d.";

const slaMinutesField = z.union([z.string(), z.number()]).transform((raw, ctx) => {
  const minutes = typeof raw === "number" ? raw : parseSlaDuration(raw);

  if (
    minutes === null ||
    !Number.isInteger(minutes) ||
    minutes < MIN_SLA_MINUTES ||
    minutes > MAX_SLA_MINUTES
  ) {
    ctx.addIssue({ code: "custom", message: SLA_MESSAGE });
    return z.NEVER;
  }

  return minutes;
});

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
  sla_minutes: slaMinutesField,
  /**
   * Where approved requests from this form land (P2-06 / Q18).
   *
   * Null is a real answer — a department that has not organised itself into
   * lists yet should not be forced to invent one.
   */
  default_list_id: z.uuid().nullable().default(null),
  /** Business days the client gets at Gate 3 before auto-completion (Q6). */
  client_approval_days: z.coerce
    .number()
    .int()
    .min(1, "At least one working day.")
    .max(30)
    .default(3),
});

export type FormSettingsInput = z.infer<typeof formSettingsSchema>;

/**
 * The same settings AS TYPED, before parsing.
 *
 * `sla_minutes` is a string in the form and a number in the database, so the
 * component binds to this and the server action reads `FormSettingsInput` out
 * the other side of `safeParse`.
 */
export type FormSettingsValues = z.input<typeof formSettingsSchema>;

/**
 * P7-29 — the same settings, on a form that does not exist yet.
 *
 * The ONLY difference is that the slug and the reference prefix may arrive
 * blank, meaning "derive one from the name". `formSettingsSchema` requires
 * both, and it has to: on an existing form a blank slug would take a URL
 * somebody has shared away.
 *
 * Two schemas rather than one loose one, so an UPDATE cannot accidentally
 * accept the blank an INSERT is allowed to.
 */
export const formCreateSchema = formSettingsSchema.extend({
  slug: z.union([z.literal(""), formSettingsSchema.shape.slug]).default(""),
  reference_prefix: z
    .union([z.literal(""), formSettingsSchema.shape.reference_prefix])
    .default(""),
});

export type FormCreateInput = z.infer<typeof formCreateSchema>;

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

// ---------------------------------------------------------------------------
// P7-29 — the two identifiers, derived from the name
// ---------------------------------------------------------------------------

/**
 * BOTH ARE PURE, AND BOTH ARE SUGGESTIONS.
 *
 * A form has three names: what it is called, the URL a client visits, and the
 * prefix on every reference number it issues. Two of the three were blank
 * fields somebody had to invent a value for, and inventing a globally-unique
 * value by hand is a job for a machine — which is why the live form is called
 * "Test Client Request" and reaches the internet at `/request/test-client-form`
 * with references reading `COL-2026-0001`.
 *
 * DERIVED ON CREATE ONLY, and only when the field was left blank. Both stay
 * editable afterwards, because a URL somebody has already shared is worth more
 * than a tidy derivation — with one exception, below.
 *
 * ⚠️ THE PREFIX LOCKS ONCE THE FORM HAS SUBMISSIONS. `COL-2026-0001` is what
 * the client quotes back in an email; changing `COL` orphans it from its own
 * series and there is no record anywhere of what the old prefix was. Same shape
 * as `field_key` immutability (D20/R5), and enforced in `updateFormSettings`
 * rather than only in the disabled input — the front end will be bypassed.
 */

/**
 * `Collateral Request` → `collateral-request`.
 *
 * Matches `formSettingsSchema.slug`'s own regex by construction, so a derived
 * value can never be one the form would then refuse.
 */
export function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    // Anything that is not a slug character becomes a separator — including
    // accented letters, which would otherwise survive `\W` and fail the regex.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    // The slice can leave a trailing hyphen behind, which the regex refuses.
    .replace(/-+$/, "");

  // A name made entirely of characters a URL cannot carry — "字体設計" — still
  // has to produce a working form rather than a validation error on a field
  // the person never filled in.
  return slug || "form";
}

/**
 * `Collateral Request` → `COL`. `IT Support` → `IS`. `2026 Planning` → `PLA`.
 *
 * The first word where it is long enough to abbreviate on its own, initials
 * where it is not — "COL" reads as collateral, where "CR" reads as nothing.
 * Two to eight characters, first one a letter, per the schema's regex.
 */
export function prefixFromName(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  /*
   * A prefix must START with a letter — `PREFIX-YYYY-NNNN` is read by segment
   * and a leading digit makes the first one ambiguous.
   *
   * So words that begin with a digit are SKIPPED rather than stripped. "2026
   * Planning" and "3D Modelling" both lead with one, and stripping would derive
   * "202" → "" and throw away a perfectly good word standing right behind it.
   */
  const usable = words.filter((word) => /^[A-Z]/.test(word));

  const candidate =
    usable.length === 0
      ? ""
      : usable[0].length >= 3
        ? usable[0].slice(0, 3)
        : usable.map((word) => word[0]).join("");

  const cleaned = candidate.slice(0, 8);

  // Anything that cannot make a legal prefix falls back rather than failing:
  // this runs on a field the person deliberately left blank, so an error here
  // would be the app refusing to do the work it offered to do.
  return /^[A-Z][A-Z0-9]{1,7}$/.test(cleaned) ? cleaned : "REQ";
}

/**
 * The next candidate after one that is already taken — `col` → `col-2`, and
 * `COL` → `COL2`.
 *
 * Both identifiers are GLOBALLY UNIQUE (single-tenant, D-single-tenant), and a
 * lead cannot necessarily SEE the form they would clash with: RLS scopes forms
 * to the departments somebody leads, so a uniqueness check in a query would
 * miss exactly the clashes that matter. The create path therefore derives,
 * attempts the insert, and asks this for the next candidate when Postgres says
 * the value is taken.
 *
 * ONLY EVER APPLIED TO A DERIVED VALUE. A slug somebody typed and a slug this
 * function invented are different things: silently saving `collateral-2` to a
 * lead who asked for `collateral` would put an address they are about to share
 * one character away from another department's form.
 */
export function nextCandidate(value: string, attempt: number, separator: "-" | "" = "-"): string {
  const suffix = `${separator}${attempt}`;
  // The prefix has a hard eight-character ceiling, so the suffix eats into the
  // stem rather than pushing the value past the regex it has to satisfy.
  const ceiling = separator === "" ? 8 : 60;
  return `${value.slice(0, ceiling - suffix.length)}${suffix}`;
}
