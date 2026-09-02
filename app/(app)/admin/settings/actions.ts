"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/authorization";
import { appSettingsSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P7-37 — the company-wide settings.
 *
 * Admin-only, re-established before anything reads a parameter, exactly as
 * `admin/holidays/actions.ts` does. The RLS on `vizserve_pms_app_settings` says
 * the same thing — insert and update gated on `vizserve_pms_is_admin()` — but
 * this uses the service-role client, which bypasses policies entirely, so
 * `requireRole("owner")` here is the belt rather than the braces.
 *
 * ⚠️ WHAT THIS CHANGES, BEYOND ONE NUMBER. The grace period is read on every
 * punch and on every row of every DTR view, for everybody with work hours set.
 * Lowering it makes days that read as fine yesterday read as late today —
 * nothing is rewritten, because a deviation is computed on read and never
 * stored, but the same punches will be described differently. That is why this
 * writes an audit row with the before and after: the question "why did the DTR
 * start flagging everybody" has to be answerable.
 */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * The audit log's `entity_id` is `uuid NOT NULL`, and the settings row's key is
 * a boolean — there is no uuid to give it. The nil UUID stands for "the
 * singleton", paired with `entity_type = 'app_settings'`, which is unambiguous
 * because there is exactly one such row and there always will be.
 *
 * Written as a named constant rather than inline so a search for it finds both
 * the writer and anybody later reading the log back.
 */
const SETTINGS_AUDIT_ID = "00000000-0000-0000-0000-000000000000";

function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

export async function updateAppSettings(input: unknown): Promise<ActionResult> {
  const context = await requireRole("owner");

  const parsed = appSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("vizserve_pms_app_settings")
    .select("grace_minutes, break_minutes")
    .maybeSingle();

  /**
   * UPSERT, NOT UPDATE, and the reason is the same one `createUser` gives: an
   * update matching zero rows reports success. The migration seeds the singleton,
   * so the row is normally there — but if a database ever came up without it, an
   * admin saving this form would be told it worked while the app carried on
   * reading the fallback.
   *
   * `id: true` is the singleton key. There is no other row it could conflict
   * with, which is the whole point of the boolean primary key.
   */
  const { error } = await admin
    .from("vizserve_pms_app_settings")
    .upsert(
      {
        id: true,
        grace_minutes: parsed.data.grace_minutes,
        break_minutes: parsed.data.break_minutes,
        updated_at: new Date().toISOString(),
        updated_by: context.userId,
      },
      { onConflict: "id" },
    );

  if (error) return { ok: false, error: error.message };

  // Only record a change that actually changed something. An audit trail full of
  // no-op saves is an audit trail nobody reads.
  //
  // P8-05 adds the break to the comparison AND to the `after` payload. It has a
  // stronger claim on the log than the grace period does: it decides what a
  // timesheet week must reach before it can be submitted at all, so "why did
  // everybody's week start being refused" is a question the log has to answer,
  // and it can only answer it if the before and after are both in there.
  const changed =
    (before?.grace_minutes ?? null) !== parsed.data.grace_minutes ||
    (before?.break_minutes ?? null) !== parsed.data.break_minutes;

  if (changed) {
    await admin.rpc("vizserve_pms_write_audit_log", {
      p_entity_type: "app_settings",
      p_entity_id: SETTINGS_AUDIT_ID,
      p_action: "updated",
      p_actor_id: context.userId,
      p_before: before ?? null,
      p_after: {
        grace_minutes: parsed.data.grace_minutes,
        break_minutes: parsed.data.break_minutes,
      },
    });
  }

  /**
   * Every screen that judges a punch. `/dtr` is the obvious one; `/` and
   * `/dashboard` render the punch panel, which carries the grace period into the
   * browser and would otherwise go on prompting against the old number until
   * their caches expired.
   */
  revalidatePath("/admin/settings");
  revalidatePath("/dtr");
  revalidatePath("/dashboard");
  revalidatePath("/");
  // P8-05. The week status bar computes the scheduled week from the break, and
  // it is the one screen where a stale figure would say "you are 30m short"
  // against a threshold the database no longer applies.
  revalidatePath("/timesheet");

  return { ok: true, data: undefined };
}
