"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireHr } from "@/lib/auth/authorization";
import { createLeaveTypeSchema, updateLeaveTypeSchema } from "@/lib/schemas/leave-types";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P7-52 — leave types, editable at last.
 *
 * HR-gated, re-established on every call before anything reads a parameter. The
 * RLS on `vizserve_pms_leave_types` says the same thing since P7-52 — writable
 * by `vizserve_pms_is_hr()` — but these use the service-role client, which
 * bypasses policies entirely, so `requireHr()` here is the belt.
 *
 * Service role for the same reason `/admin/holidays` uses it: the audit write.
 * `vizserve_pms_write_audit_log` takes an explicit `p_actor_id`, and doing the
 * change on one client and its log entry on another is how you end up with a
 * change that landed and a log that did not.
 *
 * ⚠️ NOTHING HERE DELETES. A type with history cannot be removed — the foreign
 * key from `vizserve_pms_internal_requests` is `on delete restrict`, and a
 * request from 2026 must keep pointing at the type it was actually filed under
 * (R5, and the same soft-archive rule form fields follow). Retiring is
 * `is_active = false`, which drops it from the pickers and keeps it on the
 * reports.
 */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/**
 * Every screen a leave type is read on.
 *
 * `/approvals` carries the filing picker, `/` the shared calendar whose labels
 * `calendar_visibility` decides, and `/hr/balances` a column per type. Missing
 * one of these reads as "my change did not save".
 */
function revalidateLeaveTypeScreens(): void {
  revalidatePath("/hr/leave-types");
  revalidatePath("/hr/balances");
  revalidatePath("/approvals");
  revalidatePath("/");
}

const SELECT = "id, code, label, is_active, sort_order, applies_to_gender, calendar_visibility";

export async function updateLeaveType(input: unknown): Promise<ActionResult> {
  const context = await requireHr();

  const parsed = updateLeaveTypeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const values = parsed.data;
  const admin = createAdminClient();

  const { data: before } = await admin
    .from("vizserve_pms_leave_types")
    .select(SELECT)
    .eq("id", values.id)
    .maybeSingle();

  if (!before) return { ok: false, error: "That leave type no longer exists." };

  const { error } = await admin
    .from("vizserve_pms_leave_types")
    .update({
      label: values.label,
      sort_order: values.sort_order,
      is_active: values.is_active,
      applies_to_gender: values.applies_to_gender,
      calendar_visibility: values.calendar_visibility,
    })
    .eq("id", values.id);

  if (error) return { ok: false, error: error.message };

  const { data: after } = await admin
    .from("vizserve_pms_leave_types")
    .select(SELECT)
    .eq("id", values.id)
    .maybeSingle();

  // Only when something actually moved. An audit trail that records a save with
  // no change is one people stop reading.
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await admin.rpc("vizserve_pms_write_audit_log", {
      p_entity_type: "leave_type",
      p_entity_id: values.id,
      // Named args, never positional: calling this with
      // `(unknown, uuid, unknown, jsonb)` raises 42883 because `p_actor_id`
      // cannot be skipped by position. Recorded at p7_16a:33.
      p_action: before.is_active && !after?.is_active ? "retired" : "updated",
      p_actor_id: context.userId,
      p_before: before,
      p_after: after,
    });
  }

  revalidateLeaveTypeScreens();
  return { ok: true, data: undefined };
}

export async function createLeaveType(input: unknown): Promise<ActionResult<{ id: string }>> {
  const context = await requireHr();

  const parsed = createLeaveTypeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const values = parsed.data;
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("vizserve_pms_leave_types")
    .insert({
      code: values.code,
      label: values.label,
      sort_order: values.sort_order,
      is_active: values.is_active,
      applies_to_gender: values.applies_to_gender,
      calendar_visibility: values.calendar_visibility,
    })
    .select("id")
    .single();

  if (error) {
    // `code` is uniquely constrained, and a duplicate is the one failure a
    // person can actually fix — so it gets a sentence rather than a Postgres
    // string, and it points at the field.
    if (error.code === "23505") {
      return {
        ok: false,
        error: "That code is already in use.",
        fieldErrors: { code: ["Another leave type already uses this code."] },
      };
    }
    return { ok: false, error: error.message };
  }

  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "leave_type",
    p_entity_id: data.id,
    p_action: "created",
    p_actor_id: context.userId,
    p_before: null,
    p_after: values,
  });

  revalidateLeaveTypeScreens();
  return { ok: true, data: { id: data.id } };
}
