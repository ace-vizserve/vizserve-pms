"use server";

import { revalidatePath } from "next/cache";

import { canPostAnnouncements, requireAuthContext } from "@/lib/auth/authorization";
import { flattenIssues, readableError, type ActionResult } from "@/lib/action-result";
import { archiveAnnouncementSchema, createAnnouncementSchema } from "@/lib/schemas/announcements";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

/**
 * P17-04 — post and take down home-page announcements.
 *
 * ⚠️ THE USER'S OWN CLIENT, NOT THE SERVICE ROLE. The policies on
 * `vizserve_pms_announcements` are the enforcement — Team Leader and above to
 * post, author or Manager and above to take down. The `canPostAnnouncements`
 * check here only turns a refusal into a sentence instead of an RLS error.
 *
 * The audit row goes through the admin client, as every other audit write does.
 */

export async function postAnnouncement(input: unknown): Promise<ActionResult> {
  const context = await requireAuthContext();
  if (!canPostAnnouncements(context)) {
    return { ok: false, error: "Only Team Leaders and above can post announcements." };
  }

  const parsed = createAnnouncementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { data: created, error } = await supabase
    .from("vizserve_pms_announcements")
    .insert({ ...parsed.data, created_by: context.userId })
    .select("id")
    .single();

  if (error) return { ok: false, error: readableError(error) };

  await createAdminClient().rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "announcement",
    p_entity_id: created.id,
    p_action: "created",
    p_actor_id: context.userId,
    p_before: null,
    p_after: parsed.data,
  });

  revalidatePath("/");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function takeDownAnnouncement(input: unknown): Promise<ActionResult> {
  const context = await requireAuthContext();

  const parsed = archiveAnnouncementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That is not a valid announcement." };

  const supabase = await createClient();
  const { data: archived, error } = await supabase
    .from("vizserve_pms_announcements")
    .update({ archived_at: new Date().toISOString(), archived_by: context.userId })
    .eq("id", parsed.data.id)
    .is("archived_at", null)
    .select("id, title, body, expires_on, created_by")
    .maybeSingle();

  if (error) return { ok: false, error: readableError(error) };
  // An UPDATE the policy filtered out matches zero rows and reports success.
  if (!archived) {
    return { ok: false, error: "That announcement is already down, or it is not yours to take down." };
  }

  await createAdminClient().rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "announcement",
    p_entity_id: archived.id,
    p_action: "archived",
    p_actor_id: context.userId,
    p_before: archived,
    p_after: null,
  });

  revalidatePath("/");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}
