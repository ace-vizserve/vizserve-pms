import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SendEmailInput } from "@/lib/email/send";

/**
 * P8-14 — every client-facing email carries a status chip.
 *
 * The chip is the app's own component rendered into a mail client, and the
 * thing it must never do is what a status pill in the app must never do:
 * convey state by colour alone, or show a state that is not true.
 *
 * WHY THE PORT IS MOCKED RATHER THAN THE TRANSPORT. These assertions are about
 * the BODY the sender builds, not about the HTML it renders into. Reading the
 * chip back out of rendered markup would pin this test to the markup, which is
 * the design and is expected to move; `lib/email/layout.ts` has already been
 * restyled once under these emails without changing a single one of them.
 */

const sent: SendEmailInput[] = [];

vi.mock("@/lib/email/send", () => ({
  sendEmail: (input: SendEmailInput) => {
    sent.push(input);
    return Promise.resolve({ status: "sent", id: "test" } as const);
  },
}));

const {
  sendApprovalReminderEmail,
  sendClientApprovalEmail,
  sendFeedbackRequestEmail,
  sendRequestApprovedEmail,
  sendRequestRejectedEmail,
  sendRequestReturnedEmail,
  sendRequestSubmittedEmail,
} = await import("@/lib/email/client-emails");

const WHO = {
  to: "maria@hfse.edu.sg",
  requesterName: "Maria Santos",
  referenceNo: "VB-2026-0042",
  title: "Quarterly newsletter layout",
};

const DECISION = { ...WHO, reason: "The page count does not match the outline." };

const APPROVAL = {
  ...WHO,
  resolution: "Reworked the masthead and rebuilt the spread.",
  outputLink: null,
  attachmentCount: 2,
  deadline: "7 Aug 2026",
  token: "token",
};

beforeEach(() => {
  sent.length = 0;
});

describe("the status chip on client-facing email", () => {
  it.each([
    ["submitted", () => sendRequestSubmittedEmail({ ...WHO }), "Awaiting review"],
    [
      "approved",
      () => sendRequestApprovedEmail({ ...WHO, approvedTargetDate: "7 Aug 2026" }),
      "Approved",
    ],
    ["returned", () => sendRequestReturnedEmail(DECISION), "Returned"],
    ["rejected", () => sendRequestRejectedEmail(DECISION), "Rejected"],
    ["gate 3", () => sendClientApprovalEmail(APPROVAL), "Awaiting your approval"],
    [
      "reminder 1",
      () => sendApprovalReminderEmail({ ...WHO, deadline: "7 Aug 2026", token: "t", reminderNumber: 1 }),
      "Awaiting your approval",
    ],
    [
      "reminder 2",
      () => sendApprovalReminderEmail({ ...WHO, deadline: "7 Aug 2026", token: "t", reminderNumber: 2 }),
      "Awaiting your approval",
    ],
    [
      "feedback",
      () => sendFeedbackRequestEmail({ ...WHO, token: "t", autoCompleted: false }),
      "Completed",
    ],
  ])("%s says %j", async (_name, send, label) => {
    await send();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.status?.label).toBe(label);
  });

  /**
   * Design system §4.1: `COMPLETED` and `COMPLETED_NO_RESPONSE` must render
   * differently. One means the client approved; the other means the clock ran
   * out and nobody looked — and this email is the one that reaches somebody who
   * may never have seen the approval request at all. A green "Completed" there
   * claims an approval they did not give.
   */
  it("does not show an auto-completed request as approved", async () => {
    await sendFeedbackRequestEmail({ ...WHO, token: "t", autoCompleted: false });
    await sendFeedbackRequestEmail({ ...WHO, token: "t", autoCompleted: true });

    const [approved, lapsed] = sent.map((input) => input.body.status);

    expect(approved).toEqual({ label: "Completed", tone: "success" });
    expect(lapsed?.label).not.toBe(approved?.label);
    expect(lapsed?.tone).not.toBe("success");
  });

  /**
   * The label is the second, non-colour carrier of the state — the same reason
   * the chip in the app has a dot beside its text. A mail client that strips
   * styles, a greyscale print, and the `text/plain` part are all the same case.
   */
  it("gives every chip a label, never a bare tone", async () => {
    await sendClientApprovalEmail(APPROVAL);

    const status = sent[0]!.body.status;
    expect(status?.label.trim()).not.toBe("");
    expect(status?.tone).toBeTruthy();
  });
});
