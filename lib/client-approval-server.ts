import "server-only";

import { formatDate } from "@/lib/dates";
import {
  sendClientApprovalEmail,
  sendFeedbackRequestEmail,
} from "@/lib/email/client-emails";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P4-02 — issuing a token and sending the email it lives in.
 *
 * THE RAW TOKEN NEVER LEAVES THIS MODULE. It is minted by Postgres, returned
 * once, put into an email, and dropped. Nothing here returns it to a caller,
 * logs it, or stores it — a token in a server log is a token in whatever ships
 * those logs somewhere else.
 *
 * Issuance is service-role and deliberately NOT granted to `authenticated`: a
 * staff member who could mint a token could approve their own work as the
 * client, which is the entire gate defeated in one call.
 */

type IssueOutcome =
  | { ok: true; sent: boolean }
  | { ok: false; error: string };

/**
 * Called when a task reaches FOR_CLIENT_APPROVAL.
 *
 * Never throws. The task has already moved by the time this runs, and unwinding
 * a committed QA pass because the mail server was slow is not a trade worth
 * making — the failure is logged, and the task sits in FOR_CLIENT_APPROVAL where
 * a TL can see it has no token and re-send.
 */
export async function issueAndSendApproval(taskId: string): Promise<IssueOutcome> {
  const admin = createAdminClient();

  const { data: issued, error } = await admin.rpc("vizserve_pms_issue_approval_token", {
    p_task_id: taskId,
    p_purpose: "approval",
  });

  if (error) {
    console.error(`[gate3] ${taskId}: could not issue a token — ${error.message}`);
    return { ok: false, error: error.message };
  }

  const token = issued as {
    token: string;
    requester_email: string;
    auto_complete_at: string | null;
  };

  const { data: task } = await admin
    .from("vizserve_pms_tasks")
    .select("title, resolution, output_link, request_id")
    .eq("id", taskId)
    .maybeSingle();

  const { data: request } = task?.request_id
    ? await admin
        .from("vizserve_pms_requests")
        .select("reference_no, requester_name")
        .eq("id", task.request_id)
        .maybeSingle()
    : { data: null };

  const { count: attachmentCount } = await admin
    .from("vizserve_pms_task_attachments")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId)
    .eq("kind", "output");

  const outcome = await sendClientApprovalEmail({
    to: token.requester_email,
    requesterName: request?.requester_name ?? "there",
    referenceNo: request?.reference_no ?? "your request",
    title: task?.title ?? "Your request",
    resolution: task?.resolution ?? "",
    outputLink: task?.output_link ?? null,
    attachmentCount: attachmentCount ?? 0,
    // The deadline the email promises. Formatted from the value the DATABASE
    // computed, not recomputed here — two implementations of "three business
    // days" is two answers, and the client is held to the one in the email.
    deadline: formatDate(token.auto_complete_at?.slice(0, 10) ?? null),
    token: token.token,
  });

  if (outcome.status === "failed") {
    console.error(`[gate3] ${taskId}: approval email failed — ${outcome.error}`);
    return { ok: true, sent: false };
  }

  return { ok: true, sent: outcome.status === "sent" || outcome.status === "dry-run" };
}

/**
 * P4-10 — the feedback request, on any completion.
 *
 * Including an auto-completed one. A client who never answered is exactly the
 * client worth hearing from: silence is data, and this is the cheapest way to
 * find out whether it meant "fine" or "I never saw the email" — which is also
 * the early warning that P4-14 deliverability has regressed.
 */
export async function issueAndSendFeedbackRequest(
  taskId: string,
  options: { autoCompleted: boolean },
): Promise<IssueOutcome> {
  const admin = createAdminClient();

  // Nothing to ask about twice.
  const { data: existing } = await admin
    .from("vizserve_pms_feedback")
    .select("id")
    .eq("task_id", taskId)
    .maybeSingle();

  if (existing) return { ok: true, sent: false };

  const { data: issued, error } = await admin.rpc("vizserve_pms_issue_approval_token", {
    p_task_id: taskId,
    p_purpose: "feedback",
  });

  if (error) {
    // A manual task has no client, so this is a normal outcome rather than a
    // failure — most tasks that complete this way were never client work.
    return { ok: false, error: error.message };
  }

  const token = issued as { token: string; requester_email: string };

  const { data: task } = await admin
    .from("vizserve_pms_tasks")
    .select("title, request_id")
    .eq("id", taskId)
    .maybeSingle();

  const { data: request } = task?.request_id
    ? await admin
        .from("vizserve_pms_requests")
        .select("reference_no, requester_name")
        .eq("id", task.request_id)
        .maybeSingle()
    : { data: null };

  const outcome = await sendFeedbackRequestEmail({
    to: token.requester_email,
    requesterName: request?.requester_name ?? "there",
    referenceNo: request?.reference_no ?? "your request",
    title: task?.title ?? "your request",
    token: token.token,
    autoCompleted: options.autoCompleted,
  });

  return { ok: true, sent: outcome.status === "sent" || outcome.status === "dry-run" };
}
