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

/**
 * P7-47 — the acknowledgement. Sent the moment a public form is submitted.
 *
 * THE ONLY EMAIL THE REQUESTER GETS THAT IS NOT A DECISION, and the one that
 * was missing. Until now a client filled in the form and heard nothing until a
 * Team Leader got round to it: no reference number, no proof it arrived, no way
 * to chase it. The predictable result is a second submission of the same job a
 * day later, which is a duplicate somebody then has to spot and close.
 *
 * ⚠️ THE REFERENCE NUMBER IS THE POINT OF THIS EMAIL, not the pleasantry. It is
 * the only handle the client has on the request — the approval gate quotes it,
 * the return email quotes it, and support asks for it. Everything else here is
 * framing for that one string.
 *
 * DELIBERATELY NO LINK. There is nothing for them to open: the request is not
 * visible to a client, and the Phase 4 approval page is tokenised and does not
 * exist yet at submission time. A button going nowhere useful would train them
 * to ignore the one in the approval email, which is the email Phase 4 rests on.
 *
 * NO PROMISE OF A DATE either. Gate 1 may negotiate `target_date` down, and an
 * acknowledgement that quoted the requested date as though it were agreed would
 * be the app making a commitment no human has made.
 */
export function sendRequestSubmittedEmail(input: {
  to: string;
  requesterName: string;
  referenceNo: string;
  title: string;
}): Promise<SendOutcome> {
  return sendEmail({
    to: input.to,
    subject: `${input.referenceNo} — we have got your request`,
    body: {
      preheader: `${input.title} — received, and with the team now.`,
      heading: "Request received",
      paragraphs: [
        `Hi ${firstName(input.requesterName)},`,
        `Thanks for sending through "${input.title}". It has reached the team and somebody will review it shortly.`,
        "You do not need to do anything else for now. We will email you if we need more detail, and again once it is under way.",
      ],
      facts: [
        { label: "Reference", value: input.referenceNo },
        { label: "Request", value: input.title },
      ],
      footnote: "Keep this reference number — quote it if you need to ask us about this request.",
    },
  });
}
/**
 * P7-48 — approved, and the work has started.
 *
 * THE GAP THIS FILLS WAS THE LOUDEST ONE. A client who was returned or rejected
 * heard from us; a client whose request was ACCEPTED heard nothing at all. From
 * their side the silence after approval is indistinguishable from the silence
 * of a form that never arrived, so the good outcome looked exactly like the
 * broken one.
 *
 * ⚠️ THE AGREED DATE IS THE POINT OF THIS EMAIL. Gate 1 exists to negotiate
 * `target_date` into `approved_target_date` — that delta is the metric proving
 * the gate is doing something (D-note on the requests table). This is the only
 * moment the client is ever told what was actually agreed, and if it differs
 * from what they asked for they need to know now rather than on the day.
 *
 * NULL IS NOT "today" AND NOT THE REQUESTED DATE. An approval can be recorded
 * without a date, and inventing one here would be the app committing on behalf
 * of a team that deliberately did not. It says a date is coming instead.
 */
export function sendRequestApprovedEmail(input: {
  to: string;
  requesterName: string;
  referenceNo: string;
  title: string;
  /** The NEGOTIATED date, not the requested one. Null when none was set. */
  approvedTargetDate: string | null;
}): Promise<SendOutcome> {
  const dated = Boolean(input.approvedTargetDate);

  return sendEmail({
    to: input.to,
    subject: `${input.referenceNo} — approved, we have started`,
    body: {
      preheader: `${input.title} — accepted and under way.`,
      heading: "Your request is under way",
      paragraphs: [
        `Hi ${firstName(input.requesterName)},`,
        `Good news — "${input.title}" has been approved and somebody is now working on it.`,
        dated
          ? "The date below is what the team has committed to. If that does not work for you, reply and tell us now rather than closer to the day."
          : "We have not fixed a delivery date yet. We will confirm one with you shortly.",
      ],
      facts: dated
        ? [
            { label: "Reference", value: input.referenceNo },
            { label: "Agreed delivery", value: input.approvedTargetDate! },
          ]
        : [{ label: "Reference", value: input.referenceNo }],
      footnote: "You will hear from us again when there is something for you to review.",
    },
  });
}
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

// ---------------------------------------------------------------------------
// Phase 4 — Gate 3
// ---------------------------------------------------------------------------

type ApprovalEmailInput = {
  to: string;
  requesterName: string;
  referenceNo: string;
  title: string;
  resolution: string;
  outputLink: string | null;
  attachmentCount: number;
  /** Human date the request closes itself, e.g. "7 Aug 2026". */
  deadline: string;
  token: string;
};

/**
 * P4-03 — the email the whole build rests on.
 *
 * If this lands in spam, Phase 4 does not work: the client never sees it, three
 * days pass, and a ticket closes itself with nobody having looked. That is why
 * P4-14 deliverability testing starts at the beginning of this phase rather than
 * the end, and why the plain-text part in the shared layout is not decoration.
 *
 * THE DEADLINE IS IN THE BODY, PROMINENTLY — Amier at 54:00, and the first of
 * the three mitigations in docs/08 for the auto-complete rule. Not a footer. A
 * client who is told plainly has no grounds to be surprised; one who has to find
 * it in small print does.
 */
export function sendClientApprovalEmail(input: ApprovalEmailInput): Promise<SendOutcome> {
  const outputs: string[] = [];
  if (input.outputLink) outputs.push(input.outputLink);
  if (input.attachmentCount > 0) {
    outputs.push(
      `${input.attachmentCount} file${input.attachmentCount === 1 ? "" : "s"} on the approval page`,
    );
  }

  return sendEmail({
    to: input.to,
    subject: `${input.referenceNo} — ready for your approval`,
    body: {
      preheader: `${input.title} — please review by ${input.deadline}.`,
      heading: "Your request is ready for approval",
      paragraphs: [
        `Hi ${firstName(input.requesterName)},`,
        `"${input.title}" is done and waiting for you to look at it. The page below shows what was produced alongside what you originally asked for, so you can check it against your own brief.`,
      ],
      facts: [
        { label: "Reference", value: input.referenceNo },
        { label: "Please respond by", value: input.deadline },
        ...(outputs.length > 0 ? [{ label: "Output", value: outputs.join(" · ") }] : []),
      ],
      quote: input.resolution ? { label: "What was done", text: input.resolution } : undefined,
      button: { label: "Review and approve", path: `/approve/${input.token}` },
      // Stated a second time, in the sentence right under the button, because
      // this is the line a dispute turns on.
      footnote: `If we do not hear from you by ${input.deadline}, this request will be closed as completed without a response. You can approve or ask for changes any time before then.`,
    },
  });
}

/**
 * P4-08 — the reminders. NOT OPTIONAL.
 *
 * "A single email that lands in spam should not silently close a ticket."
 * Two of them, restating the deadline, before anything closes itself.
 */
export function sendApprovalReminderEmail(
  input: Omit<ApprovalEmailInput, "resolution" | "outputLink" | "attachmentCount"> & {
    reminderNumber: number;
  },
): Promise<SendOutcome> {
  const last = input.reminderNumber >= 2;

  return sendEmail({
    to: input.to,
    subject: last
      ? `${input.referenceNo} — closing soon, last reminder`
      : `${input.referenceNo} — still waiting for your approval`,
    body: {
      preheader: `${input.title} — closes ${input.deadline}.`,
      heading: last ? "Last reminder before this closes" : "Still waiting for your approval",
      paragraphs: [
        `Hi ${firstName(input.requesterName)},`,
        `We sent "${input.title}" for your approval and have not heard back yet.`,
        last
          ? "This is the last reminder we will send. If we do not hear from you, it will be closed as completed."
          : "If it is fine as it is, one click approves it. If something needs changing, tell us on the same page.",
      ],
      facts: [
        { label: "Reference", value: input.referenceNo },
        { label: "Closes on", value: input.deadline },
      ],
      button: { label: "Review and approve", path: `/approve/${input.token}` },
      footnote: `If we do not hear from you by ${input.deadline}, this request will be closed as completed without a response.`,
    },
  });
}

/**
 * P4-10 — the feedback request.
 *
 * Sent on EVERY completion, including an auto-completed one. A client who never
 * answered is exactly the client worth hearing from — silence is data, and this
 * is the cheapest way to find out whether it meant "fine" or "I never saw it".
 */
export function sendFeedbackRequestEmail(input: {
  to: string;
  requesterName: string;
  referenceNo: string;
  title: string;
  token: string;
  autoCompleted: boolean;
}): Promise<SendOutcome> {
  return sendEmail({
    to: input.to,
    subject: `${input.referenceNo} — how did we do?`,
    body: {
      preheader: "One question, takes a few seconds.",
      heading: "How did we do?",
      paragraphs: [
        `Hi ${firstName(input.requesterName)},`,
        input.autoCompleted
          ? `"${input.title}" was closed as completed after the approval window passed. If that was not what you expected, please say so below — it is the fastest way to reach us.`
          : `"${input.title}" is complete. If you have a moment, tell us how it went.`,
      ],
      facts: [{ label: "Reference", value: input.referenceNo }],
      button: { label: "Leave feedback", path: `/feedback/${input.token}` },
      footnote: "One rating and an optional comment. Nothing else.",
    },
  });
}
