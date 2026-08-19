"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assertDepartmentAccess, ForbiddenError, requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import {
  formCreateSchema,
  formFieldDraftSchema,
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

export async function saveField(formId: string, input: unknown): Promise<ActionResult> {
  const { supabase } = await assertCanEditForm(formId);
  const parsed = formFieldDraftSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const { id, ...values } = parsed.data;

  if (id) {
    // field_key is immutable once the form has submissions — the database
    // enforces that with a trigger (R5), so a stale client cannot slip past.
    const { error } = await supabase
      .from("vizserve_pms_form_fields")
      .update(values)
      .eq("id", id)
      .eq("form_id", formId);

    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase
      .from("vizserve_pms_form_fields")
      .insert({ ...values, form_id: formId });

    if (error) {
      if (isUniqueViolation(error)) {
        return {
          ok: false,
          error: "That field key is already used on this form.",
          fieldErrors: { field_key: ["Already in use on this form."] },
        };
      }
      return { ok: false, error: error.message };
    }
  }

  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}

/**
 * Archive, never delete.
 *
 * Historical requests hold `field_values` keyed to this field, and forms are
 * designed to evolve (D20) — so removing one would silently orphan data on
 * every request that answered it. The database blocks a hard delete outright;
 * this is the supported path (R5).
 */
export async function setFieldActive(
  formId: string,
  fieldId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const { supabase } = await assertCanEditForm(formId);

  const { error } = await supabase
    .from("vizserve_pms_form_fields")
    .update({ is_active: isActive })
    .eq("id", fieldId)
    .eq("form_id", formId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}

export async function moveField(
  formId: string,
  fieldId: string,
  direction: "up" | "down",
): Promise<ActionResult> {
  const { supabase } = await assertCanEditForm(formId);

  const { data: fields } = await supabase
    .from("vizserve_pms_form_fields")
    .select("id, sort_order")
    .eq("form_id", formId)
    .order("sort_order");

  if (!fields) return { ok: false, error: "Could not load fields." };

  const index = fields.findIndex((f) => f.id === fieldId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= fields.length) {
    return { ok: true, data: undefined };
  }

  // Rewrite both rows rather than swapping the stored values, because seeded
  // and hand-edited forms often share sort_order values.
  await supabase
    .from("vizserve_pms_form_fields")
    .update({ sort_order: (swapWith + 1) * 10 })
    .eq("id", fields[index]!.id);

  await supabase
    .from("vizserve_pms_form_fields")
    .update({ sort_order: (index + 1) * 10 })
    .eq("id", fields[swapWith]!.id);

  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}
