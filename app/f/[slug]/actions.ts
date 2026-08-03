"use server";

import { headers } from "next/headers";

import { createClient } from "@/utils/supabase/server";
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
  return result.success ? result.data : { ok: false, error: "validation_failed" };
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
