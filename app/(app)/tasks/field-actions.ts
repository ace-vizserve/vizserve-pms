"use server";

import { revalidatePath } from "next/cache";

import { flattenIssues, type ActionResult } from "@/lib/action-result";
import { requireAuthContextOrThrow } from "@/lib/auth/authorization";
import type { Json } from "@/lib/database.types";
import {
  checkDefinition,
  createListFieldSchema,
  taskFieldValueSchema,
  toListField,
  updateListFieldSchema,
  type ListField,
} from "@/lib/schemas/list-fields";
import { createClient } from "@/utils/supabase/server";

/**
 * P7-73 — managing a list's custom fields, and setting a task's values.
 *
 * ⚠️ EVERY WRITE RUNS AS THE CALLER. Who may manage a list's fields is
 * `vizserve_pms_can_manage_list` behind the INSERT and UPDATE policies; who may
 * set a value is the task UPDATE policy (P11-03) behind
 * `vizserve_pms_set_task_field`. Nothing here restates either — the zod checks
 * are for a readable message before the round trip, and the database is what
 * says no.
 *
 * ⚠️ A POLICY-REFUSED UPDATE IS SUCCESS WITH ZERO ROWS through PostgREST. So
 * every definition update asks for the row back and treats "no row" as the
 * refusal it is — a green toast over a write that changed nothing is how
 * `renameForm` once lied (see `assertCanEditForm`).
 */

const FIELD_COLUMNS = "id, list_id, name, field_type, options, decimals, sort_order, is_active";

const NOT_YOURS = "That field does not exist, or you cannot change this list's fields.";

function revalidateFields(): void {
  revalidatePath("/tasks");
  revalidatePath("/tasks/[id]", "page");
}

async function readField(fieldId: string): Promise<ListField | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vizserve_pms_list_fields")
    .select(FIELD_COLUMNS)
    .eq("id", fieldId)
    .maybeSingle();
  return data ? toListField(data) : null;
}

/** `23505` is the one-active-name-per-list index — the refusal a person can fix. */
function duplicateName(): ActionResult<never> {
  return {
    ok: false,
    error: "This list already has a field with that name.",
    fieldErrors: { name: ["Another field on this list is called that."] },
  };
}

export async function createListField(input: unknown): Promise<ActionResult<{ id: string }>> {
  const context = await requireAuthContextOrThrow();

  const parsed = createListFieldSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();

  // Appended: a new field lands at the end, where the person adding it is looking.
  const { data: last } = await supabase
    .from("vizserve_pms_list_fields")
    .select("sort_order")
    .eq("list_id", parsed.data.list_id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from("vizserve_pms_list_fields")
    .insert({
      list_id: parsed.data.list_id,
      name: parsed.data.name,
      field_type: parsed.data.field_type,
      options: parsed.data.options as unknown as Json,
      decimals: parsed.data.decimals,
      sort_order: (last?.sort_order ?? -1) + 1,
      created_by: context.userId,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return duplicateName();
    // `42501` is the INSERT policy: not somebody who manages this list.
    if (error.code === "42501") {
      return { ok: false, error: "Only members of this list's department can add fields to it." };
    }
    return { ok: false, error: error.message };
  }

  revalidateFields();
  return { ok: true, data: { id: data.id } };
}

/** Rename, options and decimals. The type is never changed from here. */
export async function updateListField(input: unknown): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = updateListFieldSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const field = await readField(parsed.data.id);
  if (!field) return { ok: false, error: NOT_YOURS };

  const issues = checkDefinition(field.field_type, parsed.data.options, parsed.data.decimals);
  if (issues) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(issues) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vizserve_pms_list_fields")
    .update({
      name: parsed.data.name,
      options: parsed.data.options as unknown as Json,
      decimals: parsed.data.decimals,
    })
    .eq("id", field.id)
    .select("id");

  if (error) {
    if (error.code === "23505") return duplicateName();
    // The guard's refusals — an option removed rather than archived — are
    // sentences already.
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) return { ok: false, error: NOT_YOURS };

  revalidateFields();
  return { ok: true, data: undefined };
}

/**
 * Archive or restore. Archiving hides the field from the columns, the filters
 * and the task page; every value stays on its task and comes back with it.
 */
export async function setListFieldArchived(fieldId: string, archived: boolean): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vizserve_pms_list_fields")
    .update({ is_active: !archived })
    .eq("id", fieldId)
    .select("id");

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        error: "An active field on this list already has that name. Rename one of them first.",
      };
    }
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) return { ok: false, error: NOT_YOURS };

  revalidateFields();
  return { ok: true, data: undefined };
}

/**
 * Up or down one place among the list's fields, archived ones included — the
 * P1-03 reorder, which renumbers the whole list so two fields can never share a
 * position and a move is never a silent no-op.
 */
export async function moveListField(fieldId: string, direction: "up" | "down"): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const field = await readField(fieldId);
  if (!field) return { ok: false, error: NOT_YOURS };

  const supabase = await createClient();
  const { data: siblings, error: readError } = await supabase
    .from("vizserve_pms_list_fields")
    .select("id, sort_order")
    .eq("list_id", field.list_id)
    .order("sort_order")
    .order("created_at");

  if (readError) return { ok: false, error: readError.message };

  const ids = (siblings ?? []).map((row) => row.id);
  const from = ids.indexOf(field.id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from === -1 || to < 0 || to >= ids.length) return { ok: true, data: undefined };

  [ids[from], ids[to]] = [ids[to], ids[from]];

  for (const [index, id] of ids.entries()) {
    if (siblings?.find((row) => row.id === id)?.sort_order === index) continue;

    const { data, error } = await supabase
      .from("vizserve_pms_list_fields")
      .update({ sort_order: index })
      .eq("id", id)
      .select("id");

    if (error) return { ok: false, error: error.message };
    if (!data || data.length === 0) return { ok: false, error: NOT_YOURS };
  }

  revalidateFields();
  return { ok: true, data: undefined };
}

/**
 * One value on one task. `null` — or an empty string, no labels, or an unticked
 * box — clears it; `vizserve_pms_set_task_field` treats them all as "no value",
 * so filters and sorts only ever see one kind of empty.
 */
export async function setTaskFieldValue(
  taskId: string,
  fieldId: string,
  value: unknown,
): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const field = await readField(fieldId);
  if (!field || !field.is_active) {
    return { ok: false, error: "That field no longer exists on this list." };
  }

  const parsed = taskFieldValueSchema(field).safeParse(value ?? null);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That value does not fit this field." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("vizserve_pms_set_task_field", {
    p_task_id: taskId,
    p_field_id: field.id,
    p_value: parsed.data as Json,
  });

  if (error) return { ok: false, error: error.message };

  revalidateFields();
  return { ok: true, data: undefined };
}
