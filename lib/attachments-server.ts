import "server-only";

import { headers } from "next/headers";

import { safeStorageName, sniffMatchesDeclaredType } from "@/lib/attachments";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P1-09 — the upload half of the two-step handshake.
 *
 * Step 1 of the design in 20260803100000_p1_09_attachments.sql: this is the only
 * code that ever sees the real bytes, so it is the only code that can honestly
 * measure them. It writes a receipt; the submission redeems the receipt and
 * believes nothing the payload says about the file.
 *
 * Runs with the SERVICE ROLE, because `anon` holds no storage privilege — the
 * public form is session-less by design. Everything below is therefore checked
 * here or it is not checked at all.
 */

export const ATTACHMENT_BUCKET = "request-attachments";

export type UploadResult =
  | {
      ok: true;
      attachment: {
        id: string;
        filename: string;
        mime_type: string;
        size_bytes: number;
      };
    }
  | { ok: false; error: string };

export type AttachmentRules = {
  max_bytes: number;
  max_files_per_form: number;
  allowed_mime_types: string[];
};

export async function readAttachmentRules(): Promise<AttachmentRules> {
  const { data } = await createAdminClient()
    .from("vizserve_pms_attachment_rules")
    .select("max_bytes, max_files_per_form, allowed_mime_types")
    .eq("id", true)
    .maybeSingle();

  // Defaults matching the migration, so a missing row degrades to restrictive
  // rather than to unlimited.
  return (
    data ?? {
      max_bytes: 10 * 1024 * 1024,
      max_files_per_form: 10,
      allowed_mime_types: ["image/png", "image/jpeg", "application/pdf"],
    }
  );
}

function clientIp(headerList: Headers): string | null {
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headerList.get("x-real-ip");
}

/**
 * The per-IP ceiling on uploads.
 *
 * Separate from the submission rate limit and necessarily so: uploading is what
 * costs storage, and a bot that never submits never touches the submission
 * limiter at all. Counted over the pending table, which is exactly the set of
 * files someone has parked without committing to.
 */
const UPLOADS_PER_IP_PER_HOUR = 30;

export async function uploadPendingAttachment(input: {
  formId: string;
  fieldKey: string | null;
  file: File;
  /** Set for staff uploads; null for the public form, which has no session. */
  uploadedBy?: string | null;
}): Promise<UploadResult> {
  const { formId, fieldKey, file } = input;
  const admin = createAdminClient();
  const rules = await readAttachmentRules();

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "That file is empty." };
  }

  // Size first — it is the cheapest check and the one that stops the rest of
  // this function reading 400 MB into memory to reject it.
  if (file.size > rules.max_bytes) {
    return {
      ok: false,
      error: `That file is larger than the ${Math.round(rules.max_bytes / 1024 / 1024)} MB limit.`,
    };
  }

  const declaredMime = (file.type || "application/octet-stream").toLowerCase();

  if (!rules.allowed_mime_types.includes(declaredMime)) {
    return { ok: false, error: `${declaredMime} files are not accepted.` };
  }

  // The form must exist and be open. Without this, a receipt could be minted
  // against a draft or deleted form and redeemed later.
  const { data: form } = await admin
    .from("vizserve_pms_forms")
    .select("id, is_active, is_public")
    .eq("id", formId)
    .maybeSingle();

  if (!form?.is_active || !form.is_public) {
    return { ok: false, error: "This form is no longer accepting submissions." };
  }

  const headerList = await headers();
  const ip = clientIp(headerList);

  if (ip) {
    const { count } = await admin
      .from("vizserve_pms_pending_attachments")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .gte("created_at", new Date(Date.now() - 3_600_000).toISOString());

    if ((count ?? 0) >= UPLOADS_PER_IP_PER_HOUR) {
      return { ok: false, error: "Too many uploads from here in the last hour." };
    }
  }

  // Read only the head. Enough for every signature in the table, and it avoids
  // pulling the whole file into memory twice.
  const buffer = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const sniff = sniffMatchesDeclaredType(buffer, declaredMime);

  if (!sniff.ok) {
    return { ok: false, error: sniff.reason };
  }

  // A UUID directory, not a UUID filename: the original name survives for the
  // download, and two clients sending "brief.pdf" cannot collide.
  const storagePath = `pending/${formId}/${crypto.randomUUID()}/${safeStorageName(file.name)}`;

  const { error: uploadError } = await admin.storage
    .from(ATTACHMENT_BUCKET)
    .upload(storagePath, file, {
      contentType: declaredMime,
      // Never overwrite. A collision here would mean the UUID repeated, which
      // is worth failing loudly over rather than silently replacing a file.
      upsert: false,
    });

  if (uploadError) {
    return { ok: false, error: "The upload did not complete. Please try again." };
  }

  const { data: pending, error: receiptError } = await admin
    .from("vizserve_pms_pending_attachments")
    .insert({
      form_id: formId,
      field_key: fieldKey,
      storage_path: storagePath,
      // file.size, not a client-supplied number.
      filename: file.name.slice(0, 200),
      mime_type: declaredMime,
      size_bytes: file.size,
      uploaded_by: input.uploadedBy ?? null,
      ip,
    })
    .select("id, filename, mime_type, size_bytes")
    .single();

  if (receiptError || !pending) {
    // No receipt means the object is unreachable — nothing can redeem it. Remove
    // it now rather than leaving the sweeper to find it in a day.
    await admin.storage.from(ATTACHMENT_BUCKET).remove([storagePath]);
    return { ok: false, error: "The upload could not be recorded. Please try again." };
  }

  return { ok: true, attachment: pending };
}

/**
 * P3-13 — a staff upload against a task.
 *
 * Deliberately NOT the two-step receipt handshake the public form uses. That
 * exists because a session-less caller has to be told which file their earlier
 * upload produced, and anything they are told can be forged. Here the caller is
 * authenticated, the task is known, and the upload IS the commit — there is no
 * gap for a fabricated path to live in, so a pending row would be ceremony
 * rather than security.
 *
 * What does carry over is the part that matters: the size, the type and the
 * magic number are all read from the real File. Nothing the browser claimed is
 * believed.
 *
 * THE CALLER MUST HAVE ESTABLISHED SCOPE ALREADY. This runs as service role and
 * checks only that the task is open — see `uploadTaskOutput` in the tasks
 * actions, which reads the task through the user's own client first.
 */
export async function uploadTaskAttachment(input: {
  taskId: string;
  file: File;
  uploadedBy: string;
  kind?: "output" | "reference";
}): Promise<
  | { ok: true; attachment: { id: string; filename: string; mime_type: string; size_bytes: number } }
  | { ok: false; error: string }
> {
  const { taskId, file, uploadedBy } = input;
  const admin = createAdminClient();
  const rules = await readAttachmentRules();

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "That file is empty." };
  }

  if (file.size > rules.max_bytes) {
    return {
      ok: false,
      error: `That file is larger than the ${Math.round(rules.max_bytes / 1024 / 1024)} MB limit.`,
    };
  }

  const declaredMime = (file.type || "application/octet-stream").toLowerCase();

  if (!rules.allowed_mime_types.includes(declaredMime)) {
    return { ok: false, error: `${declaredMime} files are not accepted.` };
  }

  const buffer = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const sniff = sniffMatchesDeclaredType(buffer, declaredMime);

  if (!sniff.ok) return { ok: false, error: sniff.reason };

  const storagePath = `tasks/${taskId}/${crypto.randomUUID()}/${safeStorageName(file.name)}`;

  const { error: uploadError } = await admin.storage
    .from(ATTACHMENT_BUCKET)
    .upload(storagePath, file, { contentType: declaredMime, upsert: false });

  if (uploadError) {
    return { ok: false, error: "The upload did not complete. Please try again." };
  }

  const { data: row, error: rowError } = await admin
    .from("vizserve_pms_task_attachments")
    .insert({
      task_id: taskId,
      storage_path: storagePath,
      filename: file.name.slice(0, 200),
      mime_type: declaredMime,
      // The real byte count, not a number the client sent.
      size_bytes: file.size,
      kind: input.kind ?? "output",
      uploaded_by: uploadedBy,
    })
    .select("id, filename, mime_type, size_bytes")
    .single();

  if (rowError || !row) {
    // An object with no row is unreachable. Remove it now rather than leaving it
    // to accumulate silently — nothing sweeps this prefix.
    await admin.storage.from(ATTACHMENT_BUCKET).remove([storagePath]);
    return { ok: false, error: "The upload could not be recorded. Please try again." };
  }

  return { ok: true, attachment: row };
}

/**
 * A short-lived signed URL for a stored attachment.
 *
 * The bucket is private and `authenticated` holds no storage policy, so this is
 * the only way staff reach a file — and the scope check happens at the call
 * site, before this is reached.
 */
export async function signAttachmentUrl(
  storagePath: string,
  expiresInSeconds = 60,
): Promise<string | null> {
  const { data } = await createAdminClient()
    .storage.from(ATTACHMENT_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);

  return data?.signedUrl ?? null;
}

/**
 * Deletes stored objects.
 *
 * Always called AFTER the owning database row has gone, so a failure here leaves
 * an orphaned object rather than a row pointing at nothing. Of the two, only the
 * second is a bug anyone sees.
 */
export async function removeStoredAttachments(paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  const { error } = await createAdminClient()
    .storage.from(ATTACHMENT_BUCKET)
    .remove(paths);

  if (error) {
    console.error(`[attachments] ${paths.length} objects left behind: ${error.message}`);
  }
}
