import { describe, expect, it } from "vitest";

import {
  sendApprovalReminderEmail,
  sendClientApprovalEmail,
  sendFeedbackRequestEmail,
  sendRequestApprovedEmail,
  sendRequestRejectedEmail,
  sendRequestReturnedEmail,
  sendRequestSubmittedEmail,
} from "@/lib/email/client-emails";
import { emailMode } from "@/lib/email/config";
import type { RequestDetails } from "@/lib/email/request-details";
import { sendEmail } from "@/lib/email/send";

/**
 * Every email this system sends, to one address, for a human to look at.
 *
 *   EMAIL_SEND_ALL_RECIPIENT=you@yourdomain.com npm run test -- tests/email/send-all.test.ts
 *
 * ⚠️ IT SENDS ELEVEN REAL MESSAGES. Opt-in by design, and it must never run as a
 * side effect of `npm run verify` on somebody's laptop.
 *
 * ⚠️ IT TOUCHES NO DATABASE, and that is deliberate rather than incidental. The
 * internal notifications below go through `sendEmail` with a hand-built body
 * rather than through `dispatchPendingEmails`, because the drain reads and
 * WRITES `vizserve_pms_notifications` — and the project this repo is pointed at
 * is live. A preview run must not leave rows behind in it.
 *
 * ⚠️ THE FIXTURES MIRROR THE REAL PATH, THEY DO NOT FLATTER IT. An earlier
 * version gave the internal emails a "Reference" row and a line of test copy,
 * neither of which the outbox sends — so what landed in an inbox was reviewed,
 * approved, and different from what ships. A preview that invents furniture is
 * worse than no preview.
 *
 * What it proves that a browser preview cannot: how each one renders in a real
 * client, whether it lands in the inbox or in spam, and that all four senders on
 * the verified domain actually deliver.
 */

const recipient = process.env.EMAIL_SEND_ALL_RECIPIENT;

if (!recipient) {
  console.warn(
    "\n  send-all.test.ts — SKIPPED. Set EMAIL_SEND_ALL_RECIPIENT to send every" +
      " email to one address.\n",
  );
}

/**
 * A stand-in for what `loadRequestDetails` returns. Hand-built rather than read
 * from the database, because this harness must not touch the live project — and
 * because a preview wants every row filled, which a real request rarely is.
 *
 * The rail is deliberately mid-journey: it shows three of the four marker states
 * at once, which is the thing worth checking in a real mail client.
 */
const DETAILS: RequestDetails = {
  formName: "Design Request",
  requesterOrg: "HFSE",
  submittedAt: "28 Jul 2026, 09:14",
  targetDate: "1 Aug 2026",
  approvedTargetDate: "5 Aug 2026",
  description:
    "Eight pages, same grid as the last issue. The cover photograph should be the one from the Tuesday shoot, and the masthead needs to move to the new palette.",
  handledBy: "Creative · Ryza Santos",
  timeline: [
    { label: "Received", state: "done", meta: "28 Jul 2026, 09:14" },
    { label: "Approved", state: "done", meta: "28 Jul 2026, 14:02" },
    { label: "Work under way", state: "done", meta: "29 Jul 2026, 08:30" },
    { label: "Checked by us", state: "done" },
    { label: "Your approval", state: "current" },
    { label: "Completed", state: "pending" },
  ],
};

const WHO = {
  requesterName: "Ace Guevarra",
  referenceNo: "COL-2026-0142",
  title: "Quarterly newsletter layout",
  details: DETAILS,
};

describe.skipIf(!recipient)("every email, to one address", () => {
  const to = recipient!;

  it("is in live mode", () => {
    // Fail loudly rather than reporting eleven cheerful dry-runs. Without a key
    // every send below is a logged no-op and nothing arrives.
    expect(emailMode(), "RESEND_API_KEY is not set, so nothing would be sent").toBe("live");
  });

  it("sends the eight client-facing emails", async () => {
    const outcomes = [
      await sendRequestSubmittedEmail({ ...WHO, to, statusUrl: "/status/sample-token" }),
      await sendRequestApprovedEmail({ ...WHO, to, approvedTargetDate: "7 Aug 2026" }),
      await sendRequestReturnedEmail({
        ...WHO,
        to,
        reason:
          "Could you confirm the final page count? The brief says 8 pages, the outline lists 12.",
        formPath: "/request/design-request",
      }),
      await sendRequestRejectedEmail({
        ...WHO,
        to,
        reason: "This one needs a print vendor rather than the in-house team.",
      }),
      await sendClientApprovalEmail({
        ...WHO,
        to,
        resolution:
          "Reworked the masthead to the new palette and rebuilt the two-column spread so it holds at A4.\nSwapped the cover photograph for the one you sent on Tuesday.",
        outputLink: null,
        attachmentCount: 3,
        deadline: "7 Aug 2026",
        token: "sample-token",
      }),
      await sendApprovalReminderEmail({
        ...WHO,
        to,
        deadline: "7 Aug 2026",
        token: "sample-token",
        reminderNumber: 1,
      }),
      await sendApprovalReminderEmail({
        ...WHO,
        to,
        deadline: "7 Aug 2026",
        token: "sample-token",
        reminderNumber: 2,
      }),
      await sendFeedbackRequestEmail({
        ...WHO,
        to,
        token: "sample-token",
        autoCompleted: false,
      }),
    ];

    for (const outcome of outcomes) {
      expect(outcome.status, JSON.stringify(outcome)).toBe("sent");
    }
  });

  /**
   * The three notification types that carry a chip.
   *
   * Shaped exactly as `dispatchPendingEmails` shapes them: the heading is the
   * notification's own title — which since migration `20260921090000` is the job
   * followed by its reference — one line of body, and a button. No detail block
   * and no rail, because a notification row carries neither.
   */
  it("sends the internal notifications", async () => {
    const internal = [
      {
        sender: "approvals" as const,
        subject: `Approval needed — ${WHO.title}`,
        status: { label: "Awaiting your approval", tone: "warning" as const },
        body: "From Maria Santos",
        action: "Review the request",
      },
      {
        sender: "notifications" as const,
        subject: `Assigned to you — ${WHO.title}`,
        status: { label: "Assigned to you", tone: "brand" as const },
        body: "You are the PIC. It is open and the clock is running.",
        action: "Open the task",
      },
      {
        sender: "approvals" as const,
        subject: `Ready for your QA — ${WHO.title}`,
        status: { label: "Ready for QA", tone: "warning" as const },
        body: "The work is done and waiting for your second pair of eyes.",
        action: "Open QA",
      },
    ];

    for (const one of internal) {
      const outcome = await sendEmail({
        to,
        sender: one.sender,
        subject: one.subject,
        body: {
          preheader: one.body,
          heading: `${WHO.title} (${WHO.referenceNo})`,
          status: one.status,
          paragraphs: ["Hi Ace,", one.body],
          button: { label: one.action, path: "/tasks/sample" },
        },
      });

      expect(outcome.status, JSON.stringify(outcome)).toBe("sent");
    }

    console.info(`\n  ✓ Eleven emails sent to ${to}. They must be in the INBOX, not spam.\n`);
  });
});
