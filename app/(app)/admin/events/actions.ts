"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/authorization";
import {
  createEventSchema,
  deleteEventSchema,
  updateEventSchema,
} from "@/lib/schemas/events";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P7-46 — calendar events.
 *
 * Admin-only, re-established on every call before anything reads a parameter,
 * exactly as the holidays and users actions do. The RLS on
 * `vizserve_pms_events` says the same thing, but these use the service-role
 * client — which bypasses policies entirely — so `requireRole("admin")` here is
 * the belt rather than the braces.
 *
 * WHY THESE ARE SAFER THAN THE HOLIDAY ONES, and it is worth saying because the
 * two screens look identical: nothing in this table feeds working-day
 * arithmetic. Deleting a holiday from a closed year silently rewrites everyone's
 * leave figures for it (D32); deleting an event removes a thing from a calendar
 * and changes no number anywhere. That is why there is no closed-year warning
 * here and why the delete confirmation is a plain one.
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
 * Both screens this touches.
 *
 * `/` is the point of the whole feature — the shared calendar every employee
 * reads lives there. Revalidating only the admin screen would leave the
 * staff-facing calendar showing yesterday's events until its cache expired,
 * which reads as "my change did not save". Same reasoning as the holiday
 * actions.
 */
function revalidateEventScreens(): void {
  revalidatePath("/admin/events");
  revalidatePath("/");
}

/**
 * DEPARTMENT is the only category that carries one. The schema refuses a
 * mismatch and the CHECK constraint refuses it again, but coercing here means a
 * stale form that still holds a department after switching to Company-wide gets
 * a saved event rather than a validation error about a field it is no longer
 * showing.
 */
function departmentFor(values: { category: string; department_id: string | null }): string | null {
  return values.category === "DEPARTMENT" ? values.department_id : null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createEvent(input: unknown): Promise<ActionResult> {
  const context = await requireRole("admin");

  const parsed = createEventSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const values = parsed.data;
  const admin = createAdminClient();

  const { data: created, error } = await admin
    .from("vizserve_pms_events")
    .insert({
      title: values.title,
      description: values.description,
      category: values.category,
      department_id: departmentFor(values),
      start_date: values.start_date,
      end_date: values.end_date,
      created_by: context.userId,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "event",
    p_entity_id: created.id,
    p_action: "created",
    p_actor_id: context.userId,
    p_before: null,
    p_after: values,
  });

  revalidateEventScreens();
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Unlike a holiday, an event CAN be moved.
 *
 * A holiday's date is its identity — two functions look it up by date — so
 * changing one is a delete and an add. An event is identified by its `id` and
 * nothing joins on its dates, so "the party moved to the 19th" is an ordinary
 * edit and should not cost the admin a delete-and-retype.
 */
export async function updateEvent(input: unknown): Promise<ActionResult> {
  const context = await requireRole("admin");

  const parsed = updateEventSchema.safeParse(input);
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
    .from("vizserve_pms_events")
    .select("title, description, category, department_id, start_date, end_date")
    .eq("id", values.id)
    .maybeSingle();

  // An UPDATE matching zero rows reports success, so a deleted event would look
  // like a save. The same trap `renameHoliday` guards.
  if (!before) return { ok: false, error: "That event no longer exists." };

  const after = {
    title: values.title,
    description: values.description,
    category: values.category,
    department_id: departmentFor(values),
    start_date: values.start_date,
    end_date: values.end_date,
  };

  const { error } = await admin.from("vizserve_pms_events").update(after).eq("id", values.id);
  if (error) return { ok: false, error: error.message };

  // Only log a change that changed something — an audit trail full of no-op
  // saves is one nobody reads.
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await admin.rpc("vizserve_pms_write_audit_log", {
      p_entity_type: "event",
      p_entity_id: values.id,
      p_action: "updated",
      p_actor_id: context.userId,
      p_before: before,
      p_after: after,
    });
  }

  revalidateEventScreens();
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteEvent(input: unknown): Promise<ActionResult> {
  const context = await requireRole("admin");

  const parsed = deleteEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That is not a valid event." };

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("vizserve_pms_events")
    .select("title, description, category, department_id, start_date, end_date")
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (!before) return { ok: false, error: "That event no longer exists." };

  const { error } = await admin.from("vizserve_pms_events").delete().eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };

  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "event",
    p_entity_id: parsed.data.id,
    p_action: "deleted",
    p_actor_id: context.userId,
    // The full row, because this payload is the only remaining record of what
    // was removed and is what somebody would read to put it back.
    p_before: before,
    p_after: null,
  });

  revalidateEventScreens();
  return { ok: true, data: undefined };
}
