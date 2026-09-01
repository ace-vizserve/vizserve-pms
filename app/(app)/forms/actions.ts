"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assertDepartmentAccess, ForbiddenError, requireRole } from "@/lib/auth/authorization";
import { planFieldReorder } from "@/lib/form-builder/schema";
import { createClient } from "@/utils/supabase/server";
import { syncFormSchemaBlob } from "./form-schema-sync";
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
 * ⚠️ P7-66 Phase 1 — `saveField`, `setFieldActive` and `moveField` DUAL-WRITE,
 * and all three are THROWAWAY: Phase 2 replaces them with one `saveSchema`
 * calling `vizserve_pms_save_form_schema`, and deletes ./form-schema-sync.ts
 * with them.
 *
 * The row write below is unchanged and stays the source of truth for the whole
 * of Phase 1. `syncFormSchemaBlob` runs AFTER it, re-derives
 * `vizserve_pms_forms.schema` from the rows and stores it, so the blob the
 * migration backfilled cannot go stale under the current builder — which is what
 * makes Phase 2 safe to trust it on its first save. It reports nothing on
 * purpose; see its own note.
 */
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

  await syncFormSchemaBlob(supabase, formId);

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

  // P7-66 Phase 1 dual-write. Archiving is the one edit that MUST reach the
  // blob: the entity has to survive as `archived: true`, because dropping it
  // would have Phase 2's projection delete a row holding historical answers.
  await syncFormSchemaBlob(supabase, formId);

  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}

/**
 * Nudges one field one place up or down.
 *
 * ⚠️ THE ORDER IS DECIDED BY `planFieldReorder`, WHICH IS PURE AND TESTED.
 * Everything this function adds is the round trips — read the ordering columns,
 * write the rows the plan names, re-derive the blob. The three bugs it used to
 * carry were all decisions taken inline here, where nothing could reach them:
 * it renumbered only the two swapped rows (wrong on any form whose rows share a
 * `sort_order`, which is every form the builder has ever created — fields are
 * inserted at 999), it picked the neighbour by `sort_order` alone while the blob
 * and the SQL both order by three columns, and it ignored both `update` errors
 * so a half-applied swap still returned `{ ok: true }` and was then baked into
 * the schema blob. See the helper's own note for the shape of the first.
 */
export async function moveField(
  formId: string,
  fieldId: string,
  direction: "up" | "down",
): Promise<ActionResult> {
  const { supabase } = await assertCanEditForm(formId);

  // `order by` matches the projection's three columns for readability and for
  // anyone reading the query log; `planFieldReorder` re-sorts regardless, so
  // the ordering is a property of the plan rather than of this clause.
  const { data: fields, error: readError } = await supabase
    .from("vizserve_pms_form_fields")
    .select("id, sort_order, created_at, is_active")
    .eq("form_id", formId)
    .order("sort_order")
    .order("created_at")
    .order("id");

  if (readError || !fields) {
    return { ok: false, error: readError?.message ?? "Could not load fields." };
  }

  const updates = planFieldReorder(fields, fieldId, direction);

  // Already at the end it was asked to move towards, or not on this form.
  if (updates.length === 0) return { ok: true, data: undefined };

  /*
   * ⚠️ SEVERAL ROUND TRIPS, NOT ONE, AND NOT A TRANSACTION. `sort_order` is the
   * only column being written, and PostgREST can only write different values to
   * different rows in one statement through `upsert` — which builds an INSERT,
   * so it would have to carry `form_id`, `label`, `field_key` and the rest to
   * clear their NOT NULLs, i.e. write back every column from a read taken
   * moments earlier. That turns a reorder into a lost-update window against a
   * concurrent `saveField`: a move landing after a label edit would revert the
   * label. Narrow writes, several of them, is the lesser evil here; Phase 2
   * gets the atomicity for free because `vizserve_pms_save_form_schema` is one
   * function call and therefore one transaction.
   *
   * So a failure partway leaves a partial renumbering — but it CANNOT be
   * reported as success, and the blob is not touched, so the rows stay the
   * source of truth and the next successful move renumbers the lot again. A
   * partial renumbering only ever mis-orders fields; it cannot lose one.
   */
  for (const update of updates) {
    const { error } = await supabase
      .from("vizserve_pms_form_fields")
      .update({ sort_order: update.sort_order })
      .eq("id", update.id)
      .eq("form_id", formId);

    if (error) {
      // Revalidate anyway: whatever did land is what the builder must now show.
      revalidatePath(`/forms/${formId}`);
      return { ok: false, error: error.message };
    }
  }

  // P7-66 Phase 1 dual-write, and only now that every row write is known to
  // have succeeded. Reordering is the edit the blob's `root` array records, so
  // skipping it here would leave the schema claiming the old order.
  await syncFormSchemaBlob(supabase, formId);

  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}
