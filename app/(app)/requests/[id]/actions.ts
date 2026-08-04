"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/authorization";
import { dispatchPendingEmailsInBackground } from "@/lib/email/dispatch";
import {
  sendRequestRejectedEmail,
  sendRequestReturnedEmail,
} from "@/lib/email/client-emails";
import {
  approveResultSchema,
  decideResultSchema,
  decisionPayloadSchema,
} from "@/lib/schemas/approvals";
import { createClient } from "@/utils/supabase/server";

/**
 * Gate 1 — the Team Leader decision (P2-07 / P2-08 / P2-09).
 *
 * These actions are thin on purpose. Every rule that matters lives in the
 * Postgres functions:
 *
 *   - may this person decide          → vizserve_pms_record_decision
 *   - is the request still pending    → row lock + status check
 *   - is the assignee in this team    → checked in SQL
 *   - is a reason present             → engine, plus a table constraint
 *   - is any of it atomic             → one function body, one transaction
 *
 * Restating any of that here would create a second place for it to drift, and
 * the database is the copy that a direct API call cannot skip.
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
 * Postgres raises a sentence; PostgREST wraps it. Unwrap it rather than showing
 * "Edge Function returned a non-2xx" to a Team Leader.
 */
function readableError(error: { message?: string; details?: string } | null): string {
  const raw = error?.message ?? "";
  if (!raw) return "That did not go through. Try again.";

  // Our own raises are already written for a human; Postgres prefixes are not.
  return raw
    .replace(/^.*?(?:ERROR|error):\s*/i, "")
    .replace(/\s*CONTEXT:[\s\S]*$/, "")
    .trim() || "That did not go through. Try again.";
}

export async function decideOnRequest(
  requestId: string,
  input: unknown,
): Promise<ActionResult<{ taskId?: string; status: string }>> {
  // team_leader is the floor; the DEPARTMENT check is the real gate and it
  // happens in SQL, where a TL of VizAssists is refused a VizBytes request even
  // though they clear this line.
  await requireRole("team_leader");

  const parsed = decisionPayloadSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const supabase = await createClient();
  const payload = parsed.data;

  // -------------------------------------------------------------------------
  // Approve — the atomic transaction (P2-07)
  // -------------------------------------------------------------------------
  if (payload.decision === "approved") {
    const { data, error } = await supabase.rpc("vizserve_pms_approve_request", {
      p_request_id: requestId,
      p_assignee_id: payload.assignee_id,
      p_qa_assignee_id: payload.qa_assignee_id,
      p_approved_target_date: payload.approved_target_date,
      p_title: payload.title,
      p_description: payload.description,
      p_list_id: payload.list_id,
    });

    if (error) return { ok: false, error: readableError(error) };

    const result = approveResultSchema.safeParse(data);
    if (!result.success) return { ok: false, error: "The approval did not complete." };

    // The PIC and QA notification rows were written inside the transaction.
    // Draining them is deliberately OUTSIDE it — an email failure must not roll
    // back an approval.
    dispatchPendingEmailsInBackground();

    revalidatePath("/requests");
    revalidatePath(`/requests/${requestId}`);
    revalidatePath("/dashboard");

    return { ok: true, data: { taskId: result.data.task_id, status: "APPROVED" } };
  }

  // -------------------------------------------------------------------------
  // Return / reject (P2-08 / P2-09)
  // -------------------------------------------------------------------------
  const { data, error } = await supabase.rpc("vizserve_pms_decide_request", {
    p_request_id: requestId,
    p_decision: payload.decision,
    p_reason: payload.reason,
  });

  if (error) return { ok: false, error: readableError(error) };

  const result = decideResultSchema.safeParse(data);
  if (!result.success) return { ok: false, error: "The decision did not complete." };

  const decided = result.data;

  // The requester is a client with no account, so there is no inbox row and no
  // outbox to queue this in — it is sent here, directly.
  //
  // Awaited but not fatal. The decision is already committed; a failed email is
  // recoverable with a phone call, and unwinding a committed decision because
  // the mail server was slow is not a trade worth making.
  const formPath = await resolveResubmitPath(supabase, requestId);

  const send =
    decided.status === "RETURNED"
      ? sendRequestReturnedEmail({
          to: decided.requester_email,
          requesterName: decided.requester_name,
          referenceNo: decided.reference_no,
          title: decided.title,
          reason: payload.reason,
          formPath,
        })
      : sendRequestRejectedEmail({
          to: decided.requester_email,
          requesterName: decided.requester_name,
          referenceNo: decided.reference_no,
          title: decided.title,
          reason: payload.reason,
        });

  const outcome = await send;
  if (outcome.status === "failed") {
    console.error(`[gate1] ${decided.reference_no}: decision email failed — ${outcome.error}`);
  }

  revalidatePath("/requests");
  revalidatePath(`/requests/${requestId}`);
  revalidatePath("/dashboard");

  return { ok: true, data: { status: decided.status } };
}

/** The public URL to resubmit against. Only sent on a return. */
async function resolveResubmitPath(
  supabase: Awaited<ReturnType<typeof createClient>>,
  requestId: string,
): Promise<string | undefined> {
  const { data } = await supabase
    .from("vizserve_pms_requests")
    .select("vizserve_pms_forms!inner(slug, is_active, is_public)")
    .eq("id", requestId)
    .maybeSingle();

  const form = (data as unknown as { vizserve_pms_forms?: { slug: string; is_active: boolean; is_public: boolean } } | null)
    ?.vizserve_pms_forms;

  // A link to a form that has since been unpublished is worse than no link.
  if (!form?.is_active || !form.is_public) return undefined;
  return `/f/${form.slug}`;
}
