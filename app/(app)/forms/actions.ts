"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assertDepartmentAccess, ForbiddenError, requireRole } from "@/lib/auth/authorization";
import type { Json } from "@/lib/database.types";
import {
  FormSchemaError,
  parseFormSchema,
  type FormSchemaRejection,
} from "@/lib/form-builder/schema";
import { createClient } from "@/utils/supabase/server";
import {
  formCreateSchema,
  formSettingsSchema,
  nextCandidate,
  prefixFromName,
  slugFromName,
} from "@/lib/schemas/forms";

/**
 * P1-03 / P1-04 — form builder and settings mutations.
 *
 * Every action re-establishes authority through lib/auth/authorization.ts
 * rather than trusting the caller, and RLS re-checks underneath. A TL may only
 * touch forms for departments they actually lead — holding the role is not
 * enough (D15).
 */

export type ActionResult<T = void> =
  { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** Postgres unique_violation — surfaced as a field error, not a 500. */
function isUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505";
}

/**
 * Which unique constraint fired.
 *
 * Forms now have two: the slug and the reference prefix. Mapping every 23505 to
 * "that URL slug is taken" was fine when there was one, and became a confusing
 * lie the moment the prefix gained an index — the user would be told to change a
 * field that was not the problem.
 *
 * The prefix constraint matters more than it looks: it is what stops two forms
 * generating the same COL-2026-0001, which surfaced as a raw 500 on the PUBLIC
 * form rather than an error anyone here would see.
 */
function uniqueFieldError(error: { message?: string; details?: string } | null): {
  field: "slug" | "reference_prefix";
  message: string;
  error: string;
} {
  const haystack = `${error?.message ?? ""} ${error?.details ?? ""}`.toLowerCase();

  if (haystack.includes("reference_prefix")) {
    return {
      field: "reference_prefix",
      message: "Already used by another form.",
      error: "That reference prefix belongs to another form.",
    };
  }

  return { field: "slug", message: "Already in use.", error: "That URL slug is taken." };
}

async function assertCanEditForm(formId: string) {
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  const { data: form } = await supabase
    .from("vizserve_pms_forms")
    // `reference_prefix` so `updateFormSettings` can tell a change from a
    // resubmission of the same value — the lock below must not fire on a Save
    // that touched something else entirely.
    .select("id, department_id, created_by, reference_prefix")
    .eq("id", formId)
    .maybeSingle();

  if (!form) throw new ForbiddenError("That form does not exist, or is outside your scope.");

  // An unrouted draft belongs to its author until a department is chosen.
  if (form.department_id === null && form.created_by === context.userId) {
    return { context, supabase, form };
  }

  assertDepartmentAccess(context, form.department_id);
  return { context, supabase, form };
}

/**
 * P7-29 — the slug and the reference prefix are DERIVED when left blank.
 *
 * Both are globally unique and both were empty boxes somebody had to invent a
 * value for. That is how the live form ended up called "Test Client Request"
 * while issuing references reading `COL-`.
 *
 * DE-DUPLICATION IS A RETRY, NOT A LOOKUP, and that is the important part. RLS
 * scopes `vizserve_pms_forms` to the departments somebody leads, so a
 * "is this slug taken" query would be blind to exactly the clashes that matter
 * — another department's form, which is invisible here and unique-indexed all
 * the same. So the insert is attempted, and Postgres is the thing that answers.
 *
 * ⚠️ ONLY A DERIVED VALUE IS EVER BUMPED. If somebody TYPED `collateral` and it
 * is taken, they are told so. Quietly saving `collateral-2` would hand them an
 * address one character away from another department's form, which they are
 * about to paste into an email.
 */
export async function createForm(input: unknown): Promise<ActionResult<{ id: string }>> {
  const context = await requireRole("team_leader");
  const parsed = formCreateSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  if (parsed.data.department_id) {
    assertDepartmentAccess(context, parsed.data.department_id);
  }

  const supabase = await createClient();

  // Blank means "derive it". Remembered as a fact about the REQUEST, because it
  // is what decides whether a clash may be resolved silently or has to be
  // reported to the person who typed the value.
  const derivedSlug = parsed.data.slug === "";
  const derivedPrefix = parsed.data.reference_prefix === "";

  const slugStem = slugFromName(parsed.data.name);
  const prefixStem = prefixFromName(parsed.data.name);

  let slug = derivedSlug ? slugStem : parsed.data.slug;
  let reference_prefix = derivedPrefix ? prefixStem : parsed.data.reference_prefix;

  // P7-66 — no dual-write here, deliberately, and for one reason only: a new
  // form has no field rows, so the blob to derive is the empty one, and the
  // `schema` column's default `{"entities": {}, "root": []}` IS what
  // `schemaFromFields([])` produces. There is nothing for a sync to write that
  // the insert has not already written.
  //
  // Bounded. An unbounded retry against a unique index is a way to hold a
  // connection open for a very long time; twenty distinct names for one form is
  // already past the point where the person should be choosing one themselves.
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const { data, error } = await supabase
      .from("vizserve_pms_forms")
      .insert({ ...parsed.data, slug, reference_prefix, created_by: context.userId })
      .select("id")
      .single();

    if (!error) {
      revalidatePath("/forms");
      return { ok: true, data: { id: data.id } };
    }

    if (!isUniqueViolation(error)) return { ok: false, error: error.message };

    const clash = uniqueFieldError(error);

    if (clash.field === "slug" && derivedSlug) {
      slug = nextCandidate(slugStem, attempt + 1);
      continue;
    }

    if (clash.field === "reference_prefix" && derivedPrefix) {
      reference_prefix = nextCandidate(prefixStem, attempt + 1, "");
      continue;
    }

    // A value somebody typed. Theirs to change.
    return { ok: false, error: clash.error, fieldErrors: { [clash.field]: [clash.message] } };
  }

  return {
    ok: false,
    error: "Could not find a free URL slug or reference prefix for that name. Set them by hand.",
  };
}

export async function updateFormSettings(formId: string, input: unknown): Promise<ActionResult> {
  const { context, supabase, form } = await assertCanEditForm(formId);
  // NOT `formCreateSchema`. A blank slug means "derive one" on a form that does
  // not exist yet; on this one it would take away a URL somebody has shared.
  const parsed = formSettingsSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  // Moving a form into a department you do not lead would hand your queue to
  // someone else, so the destination is checked as well as the origin.
  if (parsed.data.department_id) {
    assertDepartmentAccess(context, parsed.data.department_id);
  }

  /*
   * ⚠️ P7-29 — THE PREFIX LOCKS ONCE THE FORM HAS ISSUED A REFERENCE.
   *
   * `COL-2026-0001` is in the client's inbox and is what they quote back.
   * Changing `COL` orphans it from its own series, and nothing anywhere records
   * what the prefix used to be — the reference is reconstructed from the form,
   * so the old ones simply stop matching. Same shape as `field_key`
   * immutability (D20/R5), and the same reason it is a rule rather than a
   * disabled input: the front end will be bypassed.
   *
   * The count is exact for everyone who reaches this line. The requests SELECT
   * policy is `manages_department(form.department_id)` — the identical test
   * `assertCanEditForm` just applied — so anybody allowed to edit this form can
   * see every request on it. There is no viewer for whom this under-reports.
   */
  if (parsed.data.reference_prefix !== form.reference_prefix) {
    const { count } = await supabase
      .from("vizserve_pms_requests")
      .select("id", { count: "exact", head: true })
      .eq("form_id", formId);

    if ((count ?? 0) > 0) {
      return {
        ok: false,
        error: "The reference prefix cannot change once requests are using it.",
        fieldErrors: {
          reference_prefix: [
            `Locked at ${form.reference_prefix} — ${count} request${count === 1 ? "" : "s"} already quote it.`,
          ],
        },
      };
    }
  }

  const { error } = await supabase.from("vizserve_pms_forms").update(parsed.data).eq("id", formId);

  if (error) {
    if (isUniqueViolation(error)) {
      const clash = uniqueFieldError(error);
      return { ok: false, error: clash.error, fieldErrors: { [clash.field]: [clash.message] } };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/forms");
  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}

/**
 * P7-66 Phase 2 — THE ONE WRITE THE BUILDER MAKES.
 *
 * `saveField`, `setFieldActive` and `moveField` are gone, and so is
 * ./form-schema-sync.ts, which existed only to keep the blob in step behind
 * them. All four are replaced by this: the builder edits a schema in the
 * browser and posts the whole document, and
 * `vizserve_pms_save_form_schema` stores it AND projects it back into
 * `vizserve_pms_form_fields` in ONE function call, therefore one transaction.
 *
 * That transaction is the point. The three actions were three unsynchronised
 * round trips with no transaction around them, which is why `moveField` could
 * leave a half-applied renumbering and why the dual-write could leave a blob
 * that never landed. Here a failure — including the R5 trigger refusing a
 * rename or a delete — rolls the whole save back, blob included, and the form
 * is exactly as it was.
 *
 * ⚠️ THE SCHEMA IS RE-VALIDATED HERE, not trusted. The builder store runs the
 * same rules before it calls, but this is a server action: the front end will be
 * bypassed. `parseFormSchema` IS `formBuilder.validateSchema` (lib/form-builder/
 * schema.ts), so there is one rule set rather than a server copy free to drift.
 *
 * ⚠️ AND THE NORMALISED SCHEMA IS WHAT IS SENT. `parseFormSchema` returns the
 * schema with every attribute validator's output written back — `options ?? []`,
 * `required ?? true` — so what lands in the column is the document the next
 * `parseFormSchema` will read back unchanged. Posting the raw one would store a
 * blob whose round trip is only usually the identity.
 *
 * Authorization is `assertCanEditForm` here and RLS underneath: the function is
 * SECURITY INVOKER precisely so `forms updatable in scope` and `form fields
 * follow their form` are the enforcement, exactly as they were when these
 * actions wrote the rows directly.
 */
export async function saveSchema(formId: string, input: unknown): Promise<ActionResult> {
  const { supabase } = await assertCanEditForm(formId);

  let schema;

  try {
    schema = await parseFormSchema(input);
  } catch (cause) {
    if (!(cause instanceof FormSchemaError)) throw cause;

    // The reason CODE, never the payload: it can carry a raw thrown value, and
    // this is a staff screen but the same helper shape guards the public one.
    console.error("[P7-66] refused a form schema", { formId, reason: cause.reason.code });
    return { ok: false, error: schemaRejectionMessage(cause.reason) };
  }

  const { error } = await supabase.rpc("vizserve_pms_save_form_schema", {
    p_form_id: formId,
    // The brand is a phantom type; the value is plain records, strings, booleans
    // and arrays, so it serialises to jsonb unchanged.
    p_schema: schema as unknown as Json,
  });

  // Surfaced verbatim. The messages that matter here are Postgres's own R5
  // refusals — `field_key "x" is immutable once the form has submissions` and
  // `Field "x" has data on existing requests and cannot be deleted` — which say
  // exactly what happened and what to do instead. Replacing them with a house
  // sentence would lose the field name.
  if (error) return { ok: false, error: error.message };

  revalidatePath("/forms");
  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}

/**
 * A library rejection → one sentence for whoever is building the form.
 *
 * `InvalidSchema` is the branch that matters: it wraps whatever
 * `formBuilder.validateSchema` threw, and those messages were written to be read
 * ("Two fields share the key …", "Priority needs at least one option"). Every
 * other code is a malformed document rather than a rule somebody broke — the
 * builder store cannot produce one — so it gets a general sentence instead of a
 * code nobody can act on.
 */
function schemaRejectionMessage(reason: FormSchemaRejection): string {
  if (reason.code === "InvalidSchema" && reason.payload.schemaError instanceof Error) {
    return reason.payload.schemaError.message;
  }

  return (
    "This form could not be saved. Check that every field has a label and a key, " +
    "and that each choice field has at least one option."
  );
}
