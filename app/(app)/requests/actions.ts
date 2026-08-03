"use server";

import { requireRole } from "@/lib/auth/authorization";
import { signAttachmentUrl } from "@/lib/attachments-server";
import { createClient } from "@/utils/supabase/server";

/**
 * P1-09 — downloading an attachment.
 *
 * The bucket is private and `authenticated` holds no storage policy, so this is
 * the only route to a file. The scope check is the whole point of the function:
 *
 *   1. Read the attachment through the USER'S client. RLS joins it back to its
 *      request and that request's form department, so a TL outside the
 *      department gets zero rows — indistinguishable from the file not
 *      existing, which is the correct thing for them to learn.
 *   2. Only then mint a signed URL with the service role.
 *
 * Doing it the other way round — sign first, check later — is how a scope bug
 * becomes a data leak, because the URL exists by then.
 */
export async function getAttachmentDownloadUrl(
  attachmentId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requireRole("team_leader");
  const supabase = await createClient();

  const { data: attachment } = await supabase
    .from("vizserve_pms_request_attachments")
    .select("storage_path, filename")
    .eq("id", attachmentId)
    .maybeSingle();

  if (!attachment) {
    return { ok: false, error: "That file is not available." };
  }

  // Sixty seconds. Long enough to click, short enough that a URL pasted into a
  // chat is dead before anyone opens it.
  const url = await signAttachmentUrl(attachment.storage_path, 60);

  if (!url) return { ok: false, error: "That file could not be opened." };

  return { ok: true, url };
}
