"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/authorization";
import type { VizservePmsNotificationType } from "@/lib/database.types";
import { appSettingsSchema, notificationEmailSettingsSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/utils/supabase/admin";
import { flattenIssues } from "@/lib/action-result";

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

// Re-exported because components import the type from the action file they
// call, and moving the definition should not move 40 import statements.
import type { ActionResult } from "@/lib/action-result";
export type { ActionResult };

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

/**
 * P8-19 — flipping a notification type's email switch.
 *
 * ⚠️ WHAT THIS DOES NOT DO, AND THE SENTENCE THE FORM HAS TO CARRY BECAUSE OF
 * IT: turning a type on does not email the backlog. `vizserve_pms_notifications`
 * denormalises `send_email` at write time — "flipping the switch later must not
 * rewrite what already happened" (P0-10) — so this decides what future
 * notifications are owed an email and nothing else. The rows already sitting in
 * people's inboxes stay as they were written.
 *
 * Service-role client with `requireRole("owner")` above it, exactly as
 * `updateAppSettings` does. The table's own RLS says the same thing
 * (`vizserve_pms_is_admin()` on `for all`), and the service role bypasses it, so
 * the check here is the one actually doing the work.
 */
const NOTIFICATION_SETTINGS_AUDIT_ID = "00000000-0000-0000-0000-000000000000";

export async function updateNotificationEmailSettings(input: unknown): Promise<ActionResult> {
  const context = await requireRole("owner");

  const parsed = notificationEmailSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Could not read those settings.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const admin = createAdminClient();

  /*
   * READ FIRST, AND THE READ IS ALSO THE ALLOWLIST. Every `type` from the form
   * is checked against the rows that are actually in the table, so a
   * hand-crafted payload cannot insert a type the enum does not have and a
   * stale tab cannot resurrect one that was removed. It is what lets the schema
   * take `type` as a plain string — the database, not a hand-maintained mirror
   * of the enum, decides what is real.
   */
  const { data: before, error: readError } = await admin
    .from("vizserve_pms_notification_type_settings")
    .select("type, send_email");

  if (readError) return { ok: false, error: readError.message };
  if (!before || before.length === 0) {
    return { ok: false, error: "The notification types are not set up in this database." };
  }

  const current = new Map(before.map((row) => [row.type as string, row.send_email]));

  const changes = parsed.data.types.filter(
    (row) => current.has(row.type) && current.get(row.type) !== row.send_email,
  );

  // Nothing moved. Not an error, and not worth an audit row either — a log full
  // of no-op saves is a log nobody reads (see `updateAppSettings` above).
  if (changes.length === 0) return { ok: true, data: undefined };

  /*
   * ⚠️ ONE UPDATE PER TYPE, AND `.select()` ON EACH. There is no single
   * statement for "set these eight booleans to these eight values", and an
   * upsert would need `description` — which this form does not own and would
   * therefore blank. `.select()` because a policy-refused or key-missed UPDATE
   * is success with zero rows, not an error.
   *
   * A failure part-way through leaves the earlier types changed. That is
   * reported rather than hidden: the audit row records what DID land, the toast
   * names the type that did not, and the page revalidates so the switches
   * redraw from the database instead of from what the form hoped.
   */
  const applied: { type: string; send_email: boolean }[] = [];
  let failure: string | null = null;

  for (const change of changes) {
    const { data, error } = await admin
      .from("vizserve_pms_notification_type_settings")
      .update({ send_email: change.send_email, updated_at: new Date().toISOString() })
      /*
       * Cast because the schema carries `type` as a plain string and the column
       * is the Postgres enum. It is not a hole: `changes` was filtered against
       * `current`, which came out of this very table a few lines up, so every
       * value reaching here is one the enum already had.
       */
      .eq("type", change.type as VizservePmsNotificationType)
      .select("type");

    if (error) {
      failure = error.message;
      break;
    }

    if (!data || data.length === 0) {
      failure = `"${change.type}" is no longer a notification type.`;
      break;
    }

    applied.push(change);
  }

  if (applied.length > 0) {
    /*
     * ONE ROW FOR THE SAVE, NOT ONE PER TYPE. `entity_id` is `uuid NOT NULL`
     * and a notification type's key is an enum label, so there is no uuid to
     * give it — the nil UUID stands for the singleton set, exactly as
     * `SETTINGS_AUDIT_ID` does above. The before/after payloads carry the type
     * names, which is where the answer to "who turned client approvals off"
     * actually lives.
     */
    await admin.rpc("vizserve_pms_write_audit_log", {
      p_entity_type: "notification_type_settings",
      p_entity_id: NOTIFICATION_SETTINGS_AUDIT_ID,
      p_action: "updated",
      p_actor_id: context.userId,
      p_before: Object.fromEntries(applied.map((row) => [row.type, current.get(row.type)])),
      p_after: Object.fromEntries(applied.map((row) => [row.type, row.send_email])),
    });
  }

  revalidatePath("/admin/settings");

  if (failure) return { ok: false, error: failure };

  return { ok: true, data: undefined };
}
