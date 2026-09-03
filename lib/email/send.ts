import "server-only";

import { emailMode, emailTransport, isDeliverable, type EmailTransport } from "./config";
import type { EmailBody } from "./layout";
import { sendViaEmailJs } from "./transports/emailjs";
import { sendViaResend } from "./transports/resend";
import type { EmailTransportAdapter, SendOutcome } from "./transports/types";

/**
 * P0-11 / P8-10 — THE PORT. One function, every email in the system.
 *
 * It used to be one function that talked to Resend. It is now one function that
 * talks to whichever transport is selected, and that is the whole of this
 * change: `lib/email/transports/emailjs.ts` is today's implementation,
 * `lib/email/transports/resend.ts` is where this goes later, and moving between
 * them is `EMAIL_TRANSPORT` in the environment. Nothing above this line knows
 * which one is in play.
 *
 * ⚠️ THE SIGNATURE AND THE OUTCOME UNION ARE FROZEN. Seven senders in
 * `client-emails.ts`, the notification outbox and the Gate 3 module call this
 * and branch on what comes back. Keeping both fixed is what made the transport
 * swap a change to two files instead of twenty — and it is the property that has
 * to survive, because the next transport decision will be made by somebody who
 * has not read this comment.
 *
 * WHAT LIVES HERE RATHER THAN IN AN ADAPTER: everything that must be true of
 * EVERY transport. The address check and the reserved-domain gate run BEFORE a
 * transport is even chosen, so no adapter can bypass them and no new adapter can
 * forget them. That is not theoretical — the browser EmailJS send this replaced
 * had its own hand-copied version of the reserved-domain list, which is a second
 * place for it to drift and a second place to get it wrong.
 *
 * WHAT DOES NOT LIVE HERE: rendering. Resend needs HTML and a text alternative;
 * EmailJS needs a bag of variables for a template stored in their dashboard. The
 * one thing both agree on is `EmailBody` — the structured content model in
 * `layout.ts` — which is why that, and not a rendered string, is what crosses
 * this boundary.
 */

export type { SendOutcome };

export type SendEmailInput = {
  to: string;
  subject: string;
  body: EmailBody;
};

const ADAPTERS: Record<EmailTransport, EmailTransportAdapter> = {
  emailjs: sendViaEmailJs,
  resend: sendViaResend,
};

/**
 * Sends one email, or convincingly explains why it did not.
 *
 * NEVER THROWS. A mailer that throws takes the surrounding transaction with it,
 * and "the approval failed because the notification email bounced" is a much
 * worse outcome than a missing email. Callers get a discriminated outcome and
 * decide what to record.
 */
export async function sendEmail({ to, subject, body }: SendEmailInput): Promise<SendOutcome> {
  const recipient = to.trim();

  if (!recipient.includes("@")) {
    return { status: "skipped", reason: `not an email address: ${recipient}` };
  }

  /*
   * The seed safety rule, enforced rather than remembered — and enforced HERE,
   * above the transport, so that adding an adapter cannot lose it.
   *
   * Every test account is @example.com and a QA run must not be one typo away
   * from mailing a client. This is the check that stands between the seeded data
   * and a real inbox, and it is the reason it runs before anything reads a key,
   * builds a payload or opens a socket.
   */
  if (!isDeliverable(recipient)) {
    return { status: "skipped", reason: `reserved domain, never delivered: ${recipient}` };
  }

  const transport = emailTransport();

  if (emailMode() === "dry-run") {
    /*
     * The selected transport has no keys. Render nothing, send nothing, say so.
     *
     * ⚠️ NOT A SUCCESS, and the log line names the transport it would have used
     * so that "nothing is arriving" and "EMAIL_TRANSPORT points at the one I did
     * not configure" are distinguishable from the console alone. Counting this
     * as sent is precisely how the Gate 3 flow reported clean for months while
     * delivering nothing — see `reportOutcome` in `lib/client-approval-server.ts`.
     *
     * Subject and recipient only. The body can contain a client's brief, and in
     * the Gate 3 emails a live approval token; neither belongs in a log that
     * something else ships elsewhere.
     */
    console.info(`[email:dry-run] (${transport} not configured) → ${recipient} — ${subject}`);
    return { status: "dry-run" };
  }

  try {
    return await ADAPTERS[transport]({ to: recipient, subject, body });
  } catch (cause) {
    // A backstop, not the plan. Each adapter maps its own failures, because only
    // it can put the transport's own error text into the outcome. This catches
    // the case an adapter did not think of, so that a mail bug can never reach a
    // caller as a thrown error.
    return { status: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  }
}
