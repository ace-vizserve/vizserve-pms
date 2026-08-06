"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assertDepartmentAccess, ForbiddenError, requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { formFieldDraftSchema, formSettingsSchema } from "@/lib/schemas/forms";

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
    .select("id, department_id, created_by")
    .eq("id", formId)
    .maybeSingle();

  if (!form) throw new ForbiddenError("That form does not exist, or is outside your scope.");

  // An unrouted draft belongs to its author until a department is chosen.
  if (form.department_id === null && form.created_by === context.userId) {
    return { context, supabase };
  }

  assertDepartmentAccess(context, form.department_id);
  return { context, supabase };
}

export async function createForm(input: unknown): Promise<ActionResult<{ id: string }>> {
  const context = await requireRole("team_leader");
  const parsed = formSettingsSchema.safeParse(input);

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
  const { data, error } = await supabase
    .from("vizserve_pms_forms")
    .insert({ ...parsed.data, created_by: context.userId })
    .select("id")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const clash = uniqueFieldError(error);
      return { ok: false, error: clash.error, fieldErrors: { [clash.field]: [clash.message] } };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/forms");
  return { ok: true, data: { id: data.id } };
}

export async function updateFormSettings(formId: string, input: unknown): Promise<ActionResult> {
  const { context, supabase } = await assertCanEditForm(formId);
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
