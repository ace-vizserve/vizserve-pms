import "server-only";

import { sendEmail, type SendOutcome } from "./send";

/**
 * P2-08 / P2-09 — mail to the requester.
 *
 * These do NOT go through the notification outbox, and the reason is structural
 * rather than an oversight: the outbox joins `vizserve_pms_notifications` to
 * `vizserve_pms_users` to find an address. A client has no user row — that is
 * the whole design of the public form and of the Phase 4 approval gate — so
 * there is no row to write and nobody to join to.
 *
 * The consequence to keep in mind: these are sent directly from a server action
 * and are therefore NOT retried. A failure is logged and the decision still
 * stands, because a returned request that failed to email is recoverable by a
 * phone call and a rolled-back approval is not.
 *
 * Client email is a separate budget from internal email (docs/12 §3 rule 4). A
 * client who gets four emails about one request stops reading them, and Phase 4
 * rests entirely on them reading one.
 */

type DecisionEmailInput = {
  to: string;
  requesterName: string;
  referenceNo: string;
  title: string;
  reason: string;
  /** Where they resubmit. Only meaningful for a return. */
  formPath?: string;
};

/**
 * Returned — "we need more from you before we can start".
 *
 * Amier, 37:00: *"Dapat di tayo nagre-reject, eh, di ba?"* Returning is
 * negotiation, and the copy says so — this must not read like a rejection with
 * softer wording, or the client treats it as one and gives up.
 */
export function sendRequestReturnedEmail(input: DecisionEmailInput): Promise<SendOutcome> {
  return sendEmail({
    to: input.to,
    subject: `${input.referenceNo} — we need a little more before we start`,
    body: {
      preheader: `${input.title} — one thing to sort out first.`,
      heading: "We need a bit more information",
      paragraphs: [
        `Hi ${firstName(input.requesterName)},`,
        `Thanks for sending through "${input.title}". Before we can start, there is something we need from you — the details are below.`,
        "Nothing is lost. Send it back with that added and it goes straight into the queue.",
      ],
      facts: [{ label: "Reference", value: input.referenceNo }],
      quote: { label: "What we need", text: input.reason },
      button: input.formPath ? { label: "Submit the updated request", path: input.formPath } : undefined,
      footnote: "Quote the reference number if you reply to this email.",
    },
  });
}

/**
 * Rejected — terminal.
 *
 * Says so plainly. A rejection worded to sound like a return leaves the client
 * waiting for a next step that is not coming.
 */
export function sendRequestRejectedEmail(input: DecisionEmailInput): Promise<SendOutcome> {
  return sendEmail({
    to: input.to,
    subject: `${input.referenceNo} — we are not able to take this on`,
    body: {
      preheader: `${input.title} — not proceeding.`,
      heading: "We are not able to take this on",
      paragraphs: [
        `Hi ${firstName(input.requesterName)},`,
        `We have reviewed "${input.title}" and we are not able to proceed with it. The reason is below.`,
        "If circumstances change, or if you think this was the wrong call, reply to this email and we will look again.",
      ],
      facts: [{ label: "Reference", value: input.referenceNo }],
      quote: { label: "Reason", text: input.reason },
      footnote: "This request is closed. A new submission would start a new reference number.",
    },
  });
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || "there";
}
