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
 * THE RAW APPROVAL TOKEN NEVER LEAVES THIS MODULE. It is minted by Postgres,
 * returned once, put into an email, and dropped. Nothing here returns it to a
 * caller, logs it, or stores it — a token in a server log is a token in
 * whatever ships those logs somewhere else.
 *
 * P8-04 carves out ONE exception: the *feedback* token is handed back to the
 * caller so the approve page can render the rating form inline instead of
 * making the client wait for a second email. That is safe where the approval
 * token is not — a feedback token can only leave a rating on work that is
 * already complete, and it goes to the same browser that just approved it. It
 * is still never logged.
 *
 * Issuance is service-role and deliberately NOT granted to `authenticated`: a
 * staff member who could mint a token could approve their own work as the
 * client, which is the entire gate defeated in one call.
 */

type IssueOutcome =
  | { ok: true; sent: boolean }
  | { ok: false; error: string };

/**
 * Same shape, plus the raw token — present only when this call actually minted
 * one. A task that already has feedback returns `ok: true` with NO token, so
 * every caller has to handle its absence rather than assume a success carries
 * one.
 */
type FeedbackIssueOutcome =
  | { ok: true; sent: boolean; token?: string }
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

  /*
   * ⚠️ `dry-run` IS NOT SENT, AND COUNTING IT AS SENT IS WHY THIS FAILURE HID
   * FOR MONTHS.
   *
   * The transport had no keys, every send returned `dry-run`, this line called
   * it a success, and QA saw a clean "moved to For client approval" while the
   * client was never written to. Three days later the cron closed the task as
   * COMPLETED_NO_RESPONSE — a client who was never asked, recorded as one who
   * did not answer.
   *
   * `ok: true` still, because the task HAS moved and unwinding a committed QA
   * pass over a mail problem is the worse trade. But `sent` now means sent.
   */
  return { ok: true, sent: outcome.status === "sent" };
}

/**
 * Everything the feedback email needs, gathered while the token is minted.
 *
 * It carries the raw token, so it is as sensitive as the token is — pass it to
 * the sender and drop it. Nothing here is worth a second round of queries later.
 */
export type FeedbackEmailPayload = {
  to: string;
  requesterName: string;
  referenceNo: string;
  title: string;
  token: string;
};

/**
 * `issued: false` is a SUCCESS, not a failure: the task already has feedback,
 * so there is nothing to mint and nothing to send. Split from the error case
 * because a caller must not log "feedback failed" for a task that simply
 * answered already.
 */
type FeedbackTokenOutcome =
  | { ok: true; issued: true; token: string; email: FeedbackEmailPayload }
  | { ok: true; issued: false }
  | { ok: false; error: string };

/**
 * P4-10, first half — mint the token and gather what the email will say.
 *
 * SEPARATED FROM THE SEND (P8-04) because the two have different urgencies.
 * This half is database-only and fast, and the approve page cannot render the
 * inline rating form without its result, so it is awaited. The mail transport
 * is a third party over HTTP and must not be — see the callers.
 */
export async function issueFeedbackToken(taskId: string): Promise<FeedbackTokenOutcome> {
  const admin = createAdminClient();

  // Nothing to ask about twice.
  const { data: existing } = await admin
    .from("vizserve_pms_feedback")
    .select("id")
    .eq("task_id", taskId)
    .maybeSingle();

  if (existing) return { ok: true, issued: false };

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

  return {
    ok: true,
    issued: true,
    token: token.token,
    email: {
      to: token.requester_email,
      requesterName: request?.requester_name ?? "there",
      referenceNo: request?.reference_no ?? "your request",
      title: task?.title ?? "your request",
      token: token.token,
    },
  };
}

/**
 * P4-10, second half — the send, and nothing else.
 *
 * `autoCompleted` only changes the wording, so it belongs here rather than with
 * the token: the same token reads differently depending on whether a human
 * approved or the window closed.
 */
export async function sendFeedbackRequestEmailFor(
  payload: FeedbackEmailPayload,
  options: { autoCompleted: boolean },
): Promise<boolean> {
  const outcome = await sendFeedbackRequestEmail({
    ...payload,
    autoCompleted: options.autoCompleted,
  });

  // Same rule as `issueAndSendApproval` above: dry-run is not a delivery.
  return outcome.status === "sent";
}

/**
 * P4-10 — the feedback request, on any completion.
 *
 * Including an auto-completed one. A client who never answered is exactly the
 * client worth hearing from: silence is data, and this is the cheapest way to
 * find out whether it meant "fine" or "I never saw the email" — which is also
 * the early warning that P4-14 deliverability has regressed.
 *
 * Both halves, awaited, for callers with nobody waiting on them — the cron run
 * counts what it sent and has a whole invocation to do it in. A caller that is
 * holding an HTTP response open should compose the two itself and let go of the
 * email.
 */
export async function issueAndSendFeedbackRequest(
  taskId: string,
  options: { autoCompleted: boolean },
): Promise<FeedbackIssueOutcome> {
  const issued = await issueFeedbackToken(taskId);

  if (!issued.ok) return { ok: false, error: issued.error };
  if (!issued.issued) return { ok: true, sent: false };

  const sent = await sendFeedbackRequestEmailFor(issued.email, options);

  // P8-04 — the token goes back to the caller as well as into the email. The
  // email stays: it is the fallback for a client who closes the tab, and
  // answering twice is impossible because the RPC consumes the token.
  return { ok: true, sent, token: issued.token };
}
