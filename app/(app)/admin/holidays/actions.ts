"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireHr } from "@/lib/auth/authorization";
import {
  createHolidaySchema,
  deleteHolidaySchema,
  updateHolidaySchema,
} from "@/lib/schemas/holidays";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P7-35 — the holiday calendar.
 *
 * ⚠️ HR-GATED SINCE P7-52, NOT ADMIN-GATED. The route is still `/admin/holidays`
 * — an admin has it bookmarked and audit rows point at it — but the capability
 * that opens it moved, because D31 made this table the only authority on which
 * days the company is shut and D32 recorded that editing a past one rewrites
 * reported leave. That consequence is entitlement, which is HR's job. Admins
 * keep the screen, since `canDoHr` is true for them.
 *
 * Re-established on every call before anything reads a parameter, exactly as
 * `admin/users/actions.ts` does. The RLS on `vizserve_pms_holidays` says the
 * same thing — writable by `vizserve_pms_is_hr()` since P7-52 — but these use
 * the service-role client, which bypasses policies entirely, so `requireHr()`
 * here is the belt rather than the braces.
 *
 * WHY SERVICE ROLE AT ALL, given the policy would allow an admin's own client
 * through: the audit write. `vizserve_pms_write_audit_log` is called with an
 * explicit `p_actor_id`, and every other admin action in this app reaches it the
 * same way. Using one client for the change and another for its audit row is how
 * you end up with a change that landed and a log entry that did not.
 *
 * ⚠️ WHAT THESE CHANGE, BEYOND THE CALENDAR. `vizserve_pms_leave_days` counts
 * working days by consulting this table on EVERY read (D27 — nothing about leave
 * usage is stored). So adding or removing a holiday moves how many days a leave
 * request consumes, including requests already approved. For a future date that
 * is the point. For a year that has closed it silently rewrites a figure that
 * has already been reported, and possibly paid as a bonus — which is why the
 * screen warns and why every one of these writes an audit row.
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
 * Both screens this touches, invalidated together.
 *
 * `/` is not an afterthought: the shared calendar every employee reads lives
 * there, and it is the whole reason an admin is on this screen. Revalidating
 * only `/admin/holidays` would leave the staff-facing calendar showing last
 * week's holidays until its cache expired, which reads as "my change did not
 * save".
 */
function revalidateHolidayScreens(): void {
  revalidatePath("/admin/holidays");
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createHoliday(input: unknown): Promise<ActionResult> {
  const context = await requireHr();

  const parsed = createHolidaySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const { holiday_date: holidayDate, name } = parsed.data;
  const admin = createAdminClient();

  // INSERT, not upsert. The date is the primary key, so an upsert would silently
  // rename whatever was already on that day — and "Add" quietly overwriting an
  // existing entry is how a holiday somebody else entered disappears. The
  // conflict is reported so the admin can go and edit the real one.
  const { error } = await admin
    .from("vizserve_pms_holidays")
    .insert({ holiday_date: holidayDate, name });

  if (error) {
    if (/duplicate key|already exists/i.test(error.message)) {
      return {
        ok: false,
        error: "That date is already a holiday. Edit the existing entry instead.",
        fieldErrors: { holiday_date: ["Already on the calendar."] },
      };
    }
    return { ok: false, error: error.message };
  }

  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "holiday",
    // No uuid to key on — the date IS the identity. `p_entity_id` is a uuid
    // column, so the date travels in the payload instead of being coerced into
    // something it is not.
    p_entity_id: null,
    p_action: "created",
    p_actor_id: context.userId,
    p_before: null,
    p_after: { holiday_date: holidayDate, name },
  });

  revalidateHolidayScreens();
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

/**
 * Renames the holiday on a date. It cannot MOVE one — see
 * `updateHolidaySchema`. Moving a wrongly-entered date is a delete and an add,
 * because that is what it actually is, and an audit row saying "renamed" about
 * a date that changed would be a lie.
 */
export async function renameHoliday(input: unknown): Promise<ActionResult> {
  const context = await requireHr();

  const parsed = updateHolidaySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const { holiday_date: holidayDate, name } = parsed.data;
  const admin = createAdminClient();

  const { data: before } = await admin
    .from("vizserve_pms_holidays")
    .select("holiday_date, name")
    .eq("holiday_date", holidayDate)
    .maybeSingle();

  // An UPDATE matching nothing reports success, so a missing row would look
  // like a save. The same trap `createUser` guards with an upsert.
  if (!before) return { ok: false, error: "That date is no longer on the calendar." };

  if (before.name === name) {
    // Nothing changed. Reported as success and NOT audited — a log full of
    // no-op saves is a log nobody reads, which is the rule `updateUser` follows.
    return { ok: true, data: undefined };
  }

  const { error } = await admin
    .from("vizserve_pms_holidays")
    .update({ name })
    .eq("holiday_date", holidayDate);

  if (error) return { ok: false, error: error.message };

  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "holiday",
    p_entity_id: null,
    p_action: "renamed",
    p_actor_id: context.userId,
    p_before: before,
    p_after: { holiday_date: holidayDate, name },
  });

  revalidateHolidayScreens();
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * A HARD DELETE, and the exception is deliberate.
 *
 * This project's rule is soft-archive, never delete — but that rule exists to
 * protect rows OTHER rows point at (`R5`: a form field cannot be deleted because
 * historical `field_values` are keyed to it). Nothing references a holiday. It
 * is consulted by date, by two functions, and a retired one would have to be
 * excluded from both — at which point `is_active = false` and a deleted row are
 * the same thing with more moving parts.
 *
 * What a delete DOES change is arithmetic: every leave request spanning that
 * date now consumes one more working day, including approved ones, because
 * usage is computed rather than stored. The `before` payload in the audit row is
 * what makes that recoverable — it holds the date and name needed to put it back.
 */
export async function deleteHoliday(input: unknown): Promise<ActionResult> {
  const context = await requireHr();

  const parsed = deleteHolidaySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That is not a valid date." };

  const { holiday_date: holidayDate } = parsed.data;
  const admin = createAdminClient();

  const { data: before } = await admin
    .from("vizserve_pms_holidays")
    .select("holiday_date, name")
    .eq("holiday_date", holidayDate)
    .maybeSingle();

  if (!before) return { ok: false, error: "That date is no longer on the calendar." };

  const { error } = await admin
    .from("vizserve_pms_holidays")
    .delete()
    .eq("holiday_date", holidayDate);

  if (error) return { ok: false, error: error.message };

  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "holiday",
    p_entity_id: null,
    p_action: "deleted",
    p_actor_id: context.userId,
    // Recorded in full rather than as a bare date: this payload is the only
    // remaining record of what was removed, and it is what somebody would read
    // to put it back.
    p_before: before,
    p_after: null,
  });

  revalidateHolidayScreens();
  return { ok: true, data: undefined };
}
