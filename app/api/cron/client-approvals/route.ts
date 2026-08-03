import { NextResponse } from "next/server";

import { issueAndSendFeedbackRequest } from "@/lib/client-approval-server";
import { formatDate } from "@/lib/dates";
import { sendApprovalReminderEmail } from "@/lib/email/client-emails";
import { dispatchPendingEmails } from "@/lib/email/dispatch";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P4-08 / P4-09 — reminders, then auto-completion.
 *
 * THE ORDER IS THE POINT. Reminders are claimed and sent BEFORE anything is
 * auto-completed, in the same run, so a token can never be closed by the same
 * pass that was supposed to nudge it. The claim function only returns tokens
 * whose deadline is still in the future, which is the other half of that
 * guarantee.
 *
 * docs/08 pushes back on the auto-complete rule for good reason: "we never
 * approved that" is easy for a client to say and hard to disprove. Three
 * mitigations, all of them here or in the email templates:
 *
 *   1. the deadline is stated prominently in the email and on the page
 *   2. TWO reminders, because one email landing in spam must not silently
 *      close a ticket
 *   3. it is never called "approved" — COMPLETED_NO_RESPONSE is a distinct
 *      state, distinctly labelled
 *
 * Hourly is deliberate. Daily would mean a task whose window closes at 9am is
 * not actually closed until the following midnight, and the email promised
 * otherwise.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const admin = createAdminClient();
  const summary = { reminded: 0, autoCompleted: 0, feedbackSent: 0, failed: 0 };

  // --- P4-08, first -------------------------------------------------------
  const { data: reminders, error: reminderError } = await admin.rpc(
    "vizserve_pms_claim_approval_reminders",
    { p_max: 50 },
  );

  if (reminderError) {
    console.error(`[gate3:cron] reminders: ${reminderError.message}`);
  }

  for (const reminder of reminders ?? []) {
    // The claim stamped the token before we got here, so a send failure costs
    // that one reminder rather than risking a second on the next pass. The
    // other reminder still goes out tomorrow.
    if (!reminder.requester_email) continue;

    // A reminder needs the raw token, which by design exists only in the
    // original email — so a fresh one is minted for the link. The old token
    // stays valid; both point at the same task and the first decision consumes
    // whichever was used.
    const { data: issued, error } = await admin.rpc("vizserve_pms_issue_approval_token", {
      p_task_id: reminder.task_id,
      p_purpose: "approval",
    });

    if (error || !issued) {
      summary.failed += 1;
      continue;
    }

    const outcome = await sendApprovalReminderEmail({
      to: reminder.requester_email,
      requesterName: reminder.requester_name ?? "there",
      referenceNo: reminder.reference_no ?? "your request",
      title: reminder.title,
      deadline: formatDate(reminder.auto_complete_at.slice(0, 10)),
      token: (issued as { token: string }).token,
      reminderNumber: reminder.reminder_number,
    });

    if (outcome.status === "failed") summary.failed += 1;
    else summary.reminded += 1;
  }

  // --- P4-09, second ------------------------------------------------------
  const { data: closed, error: closeError } = await admin.rpc(
    "vizserve_pms_auto_complete_approvals",
  );

  if (closeError) {
    console.error(`[gate3:cron] auto-complete: ${closeError.message}`);
  }

  for (const task of closed ?? []) {
    summary.autoCompleted += 1;

    // Feedback goes out even here — especially here. A client who never
    // answered is the one worth hearing from, and their reply is the early
    // warning that deliverability has regressed.
    const sent = await issueAndSendFeedbackRequest(task.task_id, { autoCompleted: true });
    if (sent.ok && sent.sent) summary.feedbackSent += 1;
  }

  // The internal notifications written by both functions above.
  const emails = await dispatchPendingEmails();

  return NextResponse.json({ ok: true, ...summary, internalEmails: emails.sent });
}
