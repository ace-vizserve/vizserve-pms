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
  /**
   * P7-66 Phase 7 — A PAGE BREAK, NOT A QUESTION.
   *
   * ⚠️ IT IS IN THIS LIST BECAUSE IT IS A ROW IN `vizserve_pms_form_fields`,
   * and everything that reads that table reads this enum. It is LAST because
   * `ADDABLE_FIELD_TYPES` is this array and the order is the order of the
   * builder's rail — a layout tool belongs under the eight things that collect
   * an answer, not among them.
   *
   * ⚠️ EVERYTHING THAT TURNS A FIELD INTO A VALUE MUST SKIP IT. A section has
   * no input, so it never appears in `field_values`, and anything that assumes
   * one row means one answer will produce a phantom column, a phantom required
   * error, or a phantom CSV heading. The three places that matter:
   * `buildFieldSchema` (below), `sectionEntity`'s `shouldBeProcessed` in
   * `lib/form-builder/entities.ts`, and `responseColumns` in
   * `lib/form-builder/responses.ts`.
   *
   * The database says the same thing once, as
   * `vizserve_pms_form_fields_section_asks_nothing` — which is what lets
   * `vizserve_pms_submit_request` skip a section without a clause naming it.
   */
  "section",
  /**
   * P7-66 Phase 9 — SHOWN, NOT ASKED.
   *
   * An image and a YouTube video, both DISPLAY ONLY: the author gives a URL and
   * the respondent sees it. Neither collects an answer, so both belong with
   * `section` in `DISPLAY_ONLY_FIELD_TYPES` and in every filter that list drives.
   *
   * ⚠️ THE URL IS `options[0]`, NOT A COLUMN OF ITS OWN. A new column would not
   * round-trip: `vizserve_pms_save_form_schema` names the columns it projects,
   * so carrying one would mean replacing the only function permitted to DELETE a
   * field row. Phase 8 dodged that by giving grading its own writer, which works
   * because grading is an overlay — but a media URL is the field's whole
   * content and must save with the form, or the autosave says "saved" over a URL
   * it wrote nowhere. `20260902170000_p7_66_field_type_media.sql` has the full
   * reasoning.
   *
   * ⚠️ AND `label` IS THE ACCESSIBLE NAME. On an image it is the alt text; on a
   * video it is the iframe title. Both are required by WCAG 2.2 AA, and both are
   * delivered for free because `labelAttribute` already refuses an empty label
   * and `field_key` is derived from it.
   */
  "image",
  "youtube",
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
    /*
     * ⚠️ A SECTION VALIDATES NOTHING AND ACCEPTS ANYTHING, INCLUDING ABSENCE.
     *
     * It has no control, so nothing ever puts its key in `field_values` — and a
     * `z.object` shape whose key is missing from the input fails the parse
     * unless the entry is optional. Falling through to the `text` default would
     * therefore break every submission on every form that has a section, with
     * "Your details is required." pointing at a heading.
     *
     * `buildSubmissionSchema` still gives it a key rather than omitting it,
     * because the shape is built from the form's fields and a caller reading
     * that shape should find every field in it. `.optional()` on `unknown` is
     * what makes the key present and the value never demanded.
     */
    /*
     * ⚠️ EVERY DISPLAY-ONLY TYPE VALIDATES NOTHING AND ACCEPTS ABSENCE.
     *
     * None of these has a control, so nothing ever puts their key in
     * `field_values` — and a `z.object` shape whose key is missing fails the
     * parse unless the entry is optional. Falling through to the `text` default
     * would break every submission on every form carrying one, with
     * "Team photo is required." against a picture.
     */
    case "section":
    case "image":
    case "youtube":
      return z.unknown().optional();

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
// P7-66 Phase 4b — a STAFF answer to an internal form.
//
// A different thing from a client submission and typed separately, for the
// reason CLAUDE.md gives for keeping internal approvals and client forms apart:
// they look mergeable and their auth models are opposites. This one has a
// session and no reference number, no SLA, no Gate 1 and no attachments; it
// lands in `vizserve_pms_form_responses` and nothing routes it anywhere.
// ---------------------------------------------------------------------------

/**
 * What the browser posts to `submitFormResponse`.
 *
 * ⚠️ THE FORM IS NAMED BY ITS SLUG, NOT BY AN ID THE PAGE WAS HANDED. The
 * action re-reads the form from the slug and re-checks that it is a published
 * internal form, so the payload cannot nominate a form the person is not
 * looking at — including a CLIENT_REQUEST form, whose answers belong in
 * `vizserve_pms_requests` with a reference number the client is waiting for.
 *
 * `field_values` is keyed by `field_key` (§1), never by entity id: the entity
 * ids stay inside `lib/form-builder/`, and the stored shape matches
 * `vizserve_pms_requests.field_values` exactly.
 */
export const formResponseSubmissionSchema = z.object({
  slug: z.string().trim().min(1),
  field_values: z.record(z.string(), z.unknown()),
  /**
   * P7-66 — ⚠️ WHAT THE SCREEN PROMISED, ECHOED BACK. NOT A SETTING.
   *
   * This is the one field on this payload the action does NOT act on. It never
   * decides what is written: `submitted_by` comes from
   * `vizserve_pms_forms.is_anonymous` on the row the action re-reads, and the
   * INSERT policy re-checks that against the same row. A caller who could
   * choose here could strip their own name off a named survey, or attach a name
   * to an anonymous one.
   *
   * It exists to catch a RACE that nothing else can see. The flag locks on the
   * FIRST answer, so until then it can legitimately move — and /respond/<slug>
   * states which kind of form it is at RENDER time. Someone opens an anonymous
   * survey, reads "your name is not recorded", starts typing; the owner flips
   * the switch on a form that still has no answers; the answer is submitted and
   * their name is written under a page that promised it would not be. The
   * window is small and the promise is the entire feature.
   *
   * So the page sends back the sentence it displayed, and the action REFUSES if
   * the form no longer agrees with it. A mismatch can only ever cause a refusal,
   * never a permission — which is why a value the caller controls is safe here.
   */
  promised_anonymous: z.boolean(),
});

export type FormResponseSubmission = z.infer<typeof formResponseSubmissionSchema>;

/**
 * What `submitFormResponse` answers with.
 *
 * `field_errors` is keyed by `field_key` for the same reason
 * `submissionResultSchema`'s is — it is what `routeFieldErrors` and the
 * interpreter store already speak, so the page needs no reshaping.
 *
 * There is no `response_id`: the SELECT policy is admin-or-lead, so the author
 * cannot read their own row back and the action does not ask for it.
 */
export type FormResponseResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      field_errors?: Record<string, string>;
    };

// ---------------------------------------------------------------------------
// Staff-side: form settings (P1-04) and the builder (P1-03).
// ---------------------------------------------------------------------------

/**
 * P7-66 — WHAT THE FORM IS FOR.
 *
 * Two lifecycles behind one builder. A client request is public, mints a
 * reference number, carries an SLA and a client approval window, and routes
 * through Gate 1 to a task. An internal form is filled in by signed-in staff
 * and its answers are collected — there is no client, nothing to approve, and
 * four of the settings on the card are meaningless on it.
 *
 * `is_public` predates this and is NOT a second way to say the same thing: it
 * is the consequence. The database ties them with a CHECK
 * (`is_public = (purpose = 'CLIENT_REQUEST')`, 20260902100000_p7_66_form_
 * purpose.sql) and the server derives one from the other, which is why
 * `is_public` is absent from both schemas below — a client that cannot send it
 * cannot send a contradiction for the constraint to reject.
 */
export const FORM_PURPOSES = ["CLIENT_REQUEST", "INTERNAL"] as const;

export type FormPurpose = (typeof FORM_PURPOSES)[number];

/**
 * How each purpose reads, and what it commits you to.
 *
 * The hint is not decoration. The choice is made once, before the form exists,
 * and it decides whether the thing ends up on the open internet — so the picker
 * has to say that in the picker, not in a doc.
 *
 * `short` is here rather than inline in the forms table because a chip cannot
 * hold "Internal form" without breaking the row rhythm, and a label
 * written at the call site is the second copy of a map that then drifts — which
 * has happened five times in this repo already. One map, three registers.
 */
export const FORM_PURPOSE_LABELS: Record<
  FormPurpose,
  { label: string; short: string; hint: string }
> = {
  CLIENT_REQUEST: {
    label: "Client request",
    short: "Client",
    hint: "Public link, no login. Goes to a Team Leader for approval.",
  },
  INTERNAL: {
    /*
     * ⚠️ "INTERNAL FORM", NOT "EMPLOYEE ENGAGEMENT" — renamed with the enum
     * value on 2 Sep 2026 (20260902135000). The old label named a TOPIC while
     * its sibling names an AUDIENCE, and an internal form is not always about
     * engagement: an IT request, a facilities booking, a training feedback form
     * and an HR intake are all this kind of form.
     */
    label: "Internal form",
    short: "Internal",
    hint: "Colleagues fill it in signed in. Answers are collected, not approved.",
  },
};

export const formPurposeSchema = z.enum(FORM_PURPOSES, {
  message: "Choose what this form is for.",
});

/**
 * THE DERIVATION, IN ONE PLACE, MIRRORING THE CHECK CONSTRAINT.
 *
 * `vizserve_pms_forms_purpose_matches_public` is `is_public = (purpose =
 * 'CLIENT_REQUEST')`. This is that expression in TypeScript, and every server
 * action that writes a form calls it rather than re-typing the comparison — the
 * second copy of a rule like this is the one that drifts, and drifting here
 * means an internal form answering at /request/<slug> to anybody with the URL.
 */
export function isPublicForPurpose(purpose: FormPurpose): boolean {
  return purpose === "CLIENT_REQUEST";
}

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

/**
 * Five working days, the same figure `vizserve_pms_forms.sla_minutes` defaults
 * to. Named because three files were about to hard-code `2400` and one of them
 * would have been the odd one out.
 */
export const DEFAULT_SLA_MINUTES = 2400;

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

/**
 * P7-66 Phase 5 — WHICH COLLEAGUES AN INTERNAL FORM IS FOR.
 *
 * ⚠️ TWO FIELDS FOR ONE FACT, AND THE BOOLEAN IS NOT REDUNDANT. "Everyone" could
 * be encoded as an empty list, and that is exactly the encoding this avoids: the
 * stored form is delete-then-insert, so an empty list as a synonym for the whole
 * company turns any half-finished NARROWING into a silent WIDENING. Carrying the
 * intent explicitly means a list that arrives empty by accident is a refusal
 * rather than a company-wide survey nobody meant to send.
 *
 * The same shape as the column and the table underneath it — see
 * `vizserve_pms_forms.audience_is_all_departments`.
 *
 * ⚠️ THE DEPARTMENT IDS ARE NOT CHECKED FOR EXISTENCE HERE, and must not be
 * mistaken for having been. This is a shape check; the foreign key on
 * `vizserve_pms_form_audience_departments` is what refuses an id that names no
 * department, and the audience policy is what refuses a caller who may not set
 * one at all.
 */
export const formAudienceSchema = z
  .object({
    /** True: every active staff member. False: `department_ids`, and only those. */
    is_all_departments: z.boolean(),
    department_ids: z.array(z.uuid("Choose real departments.")),
  })
  .refine((value) => value.is_all_departments || value.department_ids.length > 0, {
    /*
     * ⚠️ "SPECIFIC DEPARTMENTS: NONE" IS A PUBLISHED FORM NOBODY CAN ANSWER.
     * Reachable by accident — a department deleted out from under the rows
     * cascades away — and the read side treats that state correctly as nobody.
     * It must not be reachable by REQUEST, because nothing on the screen would
     * explain why a live survey rejects every colleague who opens it.
     */
    message: "Choose at least one department, or open the form to everyone.",
    path: ["department_ids"],
  });

/** The audience as the settings card holds it. */
export type FormAudience = z.infer<typeof formAudienceSchema>;

/**
 * ⚠️ P7-66 — THIS SCHEMA HAS NO DEFAULTS, AND THAT IS THE WHOLE POINT.
 *
 * It validates an UPDATE to a form that already exists and already holds a
 * configuration somebody chose. A `.default()` here does not mean "a sensible
 * starting value"; it means "if the payload leaves this out, OVERWRITE what is
 * stored with this" — because every key that parses is then handed straight to
 * `.update()`.
 *
 * The one that made it a security bug rather than an annoyance was `purpose`.
 * It was `.default("CLIENT_REQUEST")`, so an `updateFormSettings` payload that
 * simply omitted it flipped an INTERNAL form to CLIENT_REQUEST; the
 * live CHECK `is_public = (purpose = 'CLIENT_REQUEST')` then set `is_public`
 * true, and a published STAFF form became answerable at /request/<slug> with no
 * session. The purpose lock could not stop it — it counts
 * `vizserve_pms_requests`, and an internal form never produces one.
 *
 * A SECURITY-RELEVANT FIELD MUST NEVER DEFAULT TO THE MORE PUBLIC VALUE ON AN
 * UPDATE. The other five defaults that were here did not widen access, but each
 * silently DISCARDED configuration when omitted — a blanked description, an
 * unpublished form, a dropped attachment requirement, lost routing, a reset
 * Gate 3 window. All six moved to `formCreateSchema`, which is the schema for a
 * form that has no configuration to lose.
 */
export const formSettingsSchema = z.object({
  /**
   * P7-66 — FIRST, because it changes what the rest of the card means.
   *
   * REQUIRED, never defaulted. See the block above: this is the field whose
   * default put a staff form on the public internet.
   */
  purpose: formPurposeSchema,
  name: z.string().trim().min(1, "Give the form a name."),
  slug: z
    .string()
    .trim()
    .min(1, "A URL slug is required.")
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lower-case letters, numbers and hyphens."),
  /** May be empty — but the payload has to SAY it is empty. */
  description: z.string().trim(),
  department_id: z.uuid("Choose the department that owns this form.").nullable(),
  reference_prefix: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]{1,7}$/, "2–8 upper-case letters or digits, e.g. COL."),
  /*
   * ⚠️ `is_public` IS DELIBERATELY NOT HERE. P7-66 makes it a consequence of
   * `purpose`, tied by a CHECK the database will not let anybody past — so the
   * server derives it with `isPublicForPurpose` and the browser never sends it.
   * A field the client cannot fill in is a contradiction the client cannot
   * cause. Restoring it here would put the two back in a race whose loser is a
   * staff form on the public internet.
   */
  /**
   * P7-66 — WHETHER AN ANSWER IS RECORDED AGAINST A NAME.
   *
   * UNDEFAULTED, like every other key on this schema, and here the omitted
   * value would be a lie in whichever direction it fell. `false` on a form
   * running as anonymous silently promises attribution to the next person who
   * answers; `true` on a named one would claim anonymity over rows that already
   * carry names. Neither is a state a forgetful payload should be able to reach.
   *
   * ⚠️ THE SCHEMA IS NOT THE ENFORCEMENT AND CANNOT BE. Two database rules stand
   * behind this field, and both of them refuse things this schema happily
   * parses:
   *
   *   `vizserve_pms_forms_anonymous_is_internal` — anonymity is meaningless on
   *   a CLIENT_REQUEST form, where the client TYPES their own name into an
   *   ordinary answer and there is nothing to withhold.
   *
   *   `vizserve_pms_forms_anonymity_lock` — the flag settles before the first
   *   answer and never afterwards, in EITHER direction.
   *
   * Not a `.refine` for the first of the two, deliberately: `formCreateSchema`
   * `.extend()`s this object, and a refinement turns it into a ZodEffects that
   * cannot be extended. `updateFormSettings` states both rules in a sentence a
   * person can act on, in front of Postgres saying them in a SQLSTATE.
   */
  is_anonymous: z.boolean(),
  /**
   * P7-66 Phase 8 — is this form marked?
   *
   * UNDEFAULTED, like every other flag on this schema and for the same reason
   * the six before it were: `false` here is not a fallback, it is TURNING THE
   * MARKING OFF on a form that was relying on it, sent by a payload that merely
   * forgot to mention it. The Responses tab would quietly stop showing scores
   * and nobody would know which save did it.
   *
   * ⚠️ TURNING IT OFF DOES NOT ERASE ANYTHING. Scores already written stay:
   * they are stored on the response at INSERT, not computed on read. It stops
   * FUTURE answers being marked, which is why it is a decision and not a view
   * setting.
   *
   * `vizserve_pms_forms_quiz_is_internal` refuses it on a client form. Not a
   * `.refine`, deliberately, for the reason stated on `is_anonymous`:
   * `formCreateSchema` `.extend()`s this object and a refinement makes it a
   * ZodEffects that cannot be extended. `ClientFormSettings` sends a constant
   * `false`, exactly as it does for `purpose` and `is_anonymous`.
   */
  is_quiz: z.boolean(),
  /**
   * Published or not. Undefaulted because `false` is not a safe fallback, it is
   * an UNPUBLISH — a live form taken off the air by a payload that merely
   * forgot to mention it.
   */
  is_active: z.boolean(),
  /** Undefaulted: `false` DROPS a rule the form was relying on. */
  requires_attachment: z.boolean(),
  sla_minutes: slaMinutesField,
  /**
   * Where approved requests from this form land (P2-06 / Q18).
   *
   * Null is a real answer — a department that has not organised itself into
   * lists yet should not be forced to invent one. Which is exactly why it is
   * not a DEFAULT: "route nowhere" has to be stated, not fallen into.
   */
  default_list_id: z.uuid().nullable(),
  /** Business days the client gets at Gate 3 before auto-completion (Q6). */
  client_approval_days: z.coerce
    .number()
    .int()
    .min(1, "At least one working day.")
    .max(30),
  /**
   * P7-66 Phase 5 — WHO SHOULD ANSWER. Internal forms only.
   *
   * ⚠️ THE ONE OPTIONAL KEY ON A SCHEMA WHOSE WHOLE POINT IS THAT NOTHING IS
   * OPTIONAL, so the exemption has to earn itself.
   *
   * The no-defaults rule exists because every key that parses is handed
   * STRAIGHT TO `.update()` — an omitted `is_active` defaulting to false is an
   * unpublish, an omitted `purpose` was a staff form on the public internet.
   * That argument does not reach here, because THIS KEY IS NOT A COLUMN. It
   * gates a separate, atomic write (`vizserve_pms_set_form_audience`), and
   * absent means the audience write is not made at all — the stored audience
   * stands untouched. There is no value to overwrite it with.
   *
   * Which is also why it is not `.nullable()`: null would be a VALUE, and a
   * caller would immediately have to decide whether it meant "everyone" or
   * "leave it". Absent means leave it, and that is the only reading available.
   *
   * `ClientFormSettings` never sends it. `updateFormSettings` refuses it beside
   * a CLIENT_REQUEST purpose, and `vizserve_pms_set_form_audience` refuses it
   * again — a client is answering from an inbox, with no account and no
   * department for an audience to name.
   */
  audience: formAudienceSchema.optional(),
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
 * The difference is that this schema is allowed to FILL THINGS IN and
 * `formSettingsSchema` is not. A blank slug or prefix here means "derive one
 * from the name"; on an existing form it would mean "take away a URL somebody
 * has shared". Two schemas rather than one loose one, so an UPDATE cannot
 * accidentally accept the blank an INSERT is allowed to.
 *
 * P7-66 WIDENS THAT ARGUMENT TO THE SETTINGS NOBODY SHOULD BE ASKED FOR.
 * An internal form has no reference number, no turnaround standard and no
 * queue to file into, so /forms/new asks it for a NAME and nothing else — which
 * only works if this schema can accept `{ name, purpose }` and fill the rest
 * in:
 *
 *   - `sla_minutes` falls to the column's own five working days. Meaningless on
 *     an internal form, and the value the settings card has always started a
 *     client form on.
 *   - `department_id` falls to null — an UNROUTED DRAFT, which the RLS policy
 *     "forms readable by author while unrouted" exists to keep visible to the
 *     person who just made it. It cannot be published in that state
 *     (`vizserve_pms_forms_active_requires_department`), which is the correct
 *     place for that argument to be had.
 *   - `purpose`, `description`, `is_active`, `requires_attachment`,
 *     `default_list_id` and `client_approval_days` are the six that USED to be
 *     defaulted on both schemas. Read the block on `formSettingsSchema` for
 *     why exactly one of them was a security hole and the other five were
 *     silent configuration loss.
 *
 * `formSettingsSchema` demands every one of them, so an UPDATE still cannot
 * quietly blank a form's routing — or republish a staff form.
 */
export const formCreateSchema = formSettingsSchema.extend({
  slug: z.union([z.literal(""), formSettingsSchema.shape.slug]).default(""),
  reference_prefix: z
    .union([z.literal(""), formSettingsSchema.shape.reference_prefix])
    .default(""),
  sla_minutes: formSettingsSchema.shape.sla_minutes.default(DEFAULT_SLA_MINUTES),
  department_id: formSettingsSchema.shape.department_id.default(null),
  /*
   * ⚠️ EVERY DEFAULT IN THE PAIR LIVES HERE, AND ONLY HERE.
   *
   * These four moved down from `formSettingsSchema` along with `purpose` when
   * that one's default turned out to be a way to publish a staff form. On an
   * INSERT a default is a starting value and there is nothing to lose; on an
   * UPDATE the same line overwrites a choice somebody made. The rule this
   * encodes: a default belongs on the schema for the row that does not exist
   * yet, never on the schema for the row that does.
   *
   * `purpose` is the exception to its own rule and stays CLIENT_REQUEST here,
   * because that is what `vizserve_pms_forms.purpose` defaults to and what all
   * four live forms are — but note this is the SAFE direction on a create: a
   * form that does not exist yet has no staff answers behind it, and the
   * creator is looking at the Purpose control while they do it.
   */
  purpose: formSettingsSchema.shape.purpose.default("CLIENT_REQUEST"),
  description: formSettingsSchema.shape.description.default(""),
  /*
   * The safe default, and the same one the column carries: a form is ATTRIBUTED
   * unless somebody deliberately says otherwise. An unintended anonymous form
   * loses information nobody can recover; an unintended named one is a mistake
   * that can at least be seen and corrected before anybody answers.
   */
  is_anonymous: formSettingsSchema.shape.is_anonymous.default(false),
  /* A new form is not a quiz until somebody says so — and on a CREATE there is
     nothing to lose by defaulting, per the note above. */
  is_quiz: formSettingsSchema.shape.is_quiz.default(false),
  is_active: formSettingsSchema.shape.is_active.default(false),
  requires_attachment: formSettingsSchema.shape.requires_attachment.default(false),
  default_list_id: formSettingsSchema.shape.default_list_id.default(null),
  client_approval_days: formSettingsSchema.shape.client_approval_days.default(3),
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

/**
 * P7-66 Phase 8 — ONE QUESTION'S ANSWER KEY, as the editor sends it.
 *
 * ⚠️ `correct_answer` IS ALWAYS AN ARRAY HERE, INCLUDING WHEN IT IS EMPTY, and
 * the action turns an empty one into a NULL on the way to Postgres. Two things
 * are being kept apart: "this question is not marked" (no key) and "this
 * question is marked, but nothing is right" (an empty key), which the database
 * refuses. Unticking the last option is the first of those, not the second — so
 * the shape the browser sends is uniform and the meaning is decided in one
 * place rather than by whether a field was omitted.
 *
 * A `select` sends an array of one. The column holds the same shape for both
 * types so the marking trigger has one rule to apply, and so an answer key that
 * accepts either of two options needs no schema change to become possible.
 *
 * ⚠️ NO CHECK HERE THAT THE OPTIONS EXIST. That is
 * `vizserve_pms_set_field_grading`'s, against the question's own `options` row —
 * a zod schema in a browser cannot see them, and a second copy of the rule in a
 * place that cannot enforce it is worse than none.
 */
export const fieldGradingSchema = z.object({
  field_id: z.uuid(),
  correct_answer: z.array(z.string()),
  /**
   * At least one. A question worth nothing is not a question the quiz is asking,
   * and `vizserve_pms_form_fields_points_positive` refuses it under this.
   */
  points: z.coerce.number().int().min(1, "A question must be worth at least one point.").max(100),
});

export type FieldGradingInput = z.infer<typeof fieldGradingSchema>;
