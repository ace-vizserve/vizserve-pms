"use server";

import { headers } from "next/headers";

import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { sendRequestSubmittedEmail } from "@/lib/email/client-emails";
import { uploadPendingAttachment, type UploadResult } from "@/lib/attachments-server";
import {
  attachmentRefSchema,
  submissionResultSchema,
  type SubmissionResult,
} from "@/lib/schemas/forms";
import { z } from "zod";

/**
 * P1-07 — submission.
 *
 * This action is a courier, not a validator. The authority is the database
 * function: it re-derives the required-field list from `form_fields` and
 * rejects a partial submission whatever the caller believes. Duplicating the
 * rules here would create a second place for them to drift.
 *
 * The honeypot is the one check that belongs here — it is a property of the
 * rendered HTML, not of the data model.
 */

const submitInputSchema = z.object({
  slug: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  attachments: z.array(attachmentRefSchema).default([]),
  honeypot: z.string().optional(),
});

function clientIp(headerList: Headers): string | null {
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headerList.get("x-real-ip");
}

export async function submitPublicRequest(input: unknown): Promise<SubmissionResult> {
  const parsed = submitInputSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: "validation_failed" };
  }

  // Honeypot: a hidden field no human fills. Report success to a bot rather
  // than an error — a bot that learns it was detected just adapts.
  if (parsed.data.honeypot && parsed.data.honeypot.trim() !== "") {
    return { ok: true, request_id: crypto.randomUUID(), reference_no: "PENDING" };
  }

  const headerList = await headers();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("vizserve_pms_submit_request", {
    p_slug: parsed.data.slug,
    p_payload: parsed.data.payload as never,
    p_attachments: parsed.data.attachments as never,
    p_ip: clientIp(headerList),
  });

  if (error) {
    return { ok: false, error: "validation_failed" };
  }

  const result = submissionResultSchema.safeParse(data);
  if (!result.success) return { ok: false, error: "validation_failed" };
  if (!result.data.ok) return result.data;

  await acknowledge(result.data.request_id, result.data.reference_no);

  return result.data;
}

/**
 * P7-47 — tell the requester their request arrived.
 *
 * WHY THIS READS THE ROW BACK rather than using what was posted: the payload is
 * dynamic (D20), so the field carrying the email is named differently on every
 * form. `vizserve_pms_submit_request` is what resolves it into the typed
 * `requester_email` column, so the database is the only place that knows the
 * answer for certain.
 *
 * SERVICE ROLE, and it is safe precisely because of what is being read: the row
 * this call just created, by the id the function just returned. `anon` holds no
 * table privileges at all (CLAUDE.md), so the caller's own client cannot read
 * it back — and giving `anon` a policy that could would open every request to
 * anybody who could guess a uuid.
 *
 * NOT SENT THROUGH THE OUTBOX, for the structural reason the templates file
 * gives: the outbox joins notifications to `vizserve_pms_users` for an address,
 * and a client has no user row. Same direct-send path the Gate 1 decision
 * emails use.
 *
 * ⚠️ EVERY FAILURE HERE IS SWALLOWED, deliberately. The request is COMMITTED by
 * the time this runs. Reporting an email failure to the submitter would tell
 * them their request did not go through when it did, and they would send it
 * again — turning a missing email into a duplicate job somebody has to find and
 * close. It is logged for whoever is on support instead.
 */
async function acknowledge(requestId: string, referenceNo: string): Promise<void> {
  try {
    const admin = createAdminClient();

    const { data: request } = await admin
      .from("vizserve_pms_requests")
      .select("requester_name, requester_email, title")
      .eq("id", requestId)
      .maybeSingle();

    if (!request) {
      console.error(`[submit] ${referenceNo}: acknowledgement skipped — request not readable`);
      return;
    }

    const outcome = await sendRequestSubmittedEmail({
      to: request.requester_email,
      requesterName: request.requester_name,
      referenceNo,
      title: request.title,
    });

    if (outcome.status === "failed") {
      console.error(`[submit] ${referenceNo}: acknowledgement failed — ${outcome.error}`);
    }
  } catch (error) {
    // A throw here — a missing service key, a network fault — must not surface
    // as a failed submission. See the header.
    console.error(`[submit] ${referenceNo}: acknowledgement threw —`, error);
  }
}

/**
 * P1-09 — one file, uploaded before the form is submitted.
 *
 * Public and unauthenticated, like the form it serves. Everything that makes
 * that safe — the size ceiling, the MIME allowlist, the magic-number check, the
 * per-IP throttle — lives in `uploadPendingAttachment`, because this is the last
 * point at which the real bytes exist.
 *
 * Takes FormData rather than a plain object: a File does not survive being
 * spread into one.
 */
export async function uploadPublicAttachment(formData: FormData): Promise<UploadResult> {
  const formId = formData.get("form_id");
  const fieldKey = formData.get("field_key");
  const file = formData.get("file");

  if (typeof formId !== "string" || !(file instanceof File)) {
    return { ok: false, error: "Nothing was uploaded." };
  }

  return uploadPendingAttachment({
    formId,
    fieldKey: typeof fieldKey === "string" && fieldKey !== "" ? fieldKey : null,
    file,
    uploadedBy: null,
  });
}
