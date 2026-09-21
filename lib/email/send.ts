import "server-only";

import { emailMode, isDeliverable, type EmailSender } from "./config";
import type { EmailBody } from "./layout";
import { sendViaResend } from "./transports/resend";
import type { EmailTransportAdapter, SendOutcome } from "./transports/types";

/**
 * P0-11 / P8-16 — THE PORT. One function, every email in the system.
 *
 * It talks to `lib/email/transports/resend.ts`, and after P8-16 that is the
 * only adapter there is. The port stays anyway, and the distinction is the
 * whole point of this file: everything that must be true of EVERY send lives
 * HERE, above the transport, where no adapter can bypass it and no replacement
 * adapter can forget it.
 *
 * The two-transport era earned its keep on the way out. P8-13 moved the entire
 * system from EmailJS back to Resend by changing one environment variable, and
 * P8-16 deleted EmailJS without touching a single one of the ten call sites.
 * That is what the seam buys. It costs one indirection.
 *
 * ⚠️ THE SIGNATURE AND THE OUTCOME UNION ARE FROZEN. Seven senders in
 * `client-emails.ts`, the notification outbox and the Gate 3 module call this
 * and branch on what comes back. Keeping both fixed is what made the transport
 * swap a change to two files instead of twenty — twice over, and then the
 * removal for free — and it is the property that has to survive, because the
 * next transport decision will be made by somebody who has not read this
 * comment.
 *
 * WHAT LIVES HERE RATHER THAN IN AN ADAPTER: everything that must be true of
 * EVERY transport. The address check and the reserved-domain gate run BEFORE
 * the adapter is reached, so no adapter can bypass them and no replacement can
 * forget them. That is not theoretical — the browser EmailJS send this replaced
 * had its own hand-copied version of the reserved-domain list, which is a second
 * place for it to drift and a second place to get it wrong.
 *
 * WHAT DOES NOT LIVE HERE: rendering. The adapter decides what its transport
 * wants — Resend takes HTML plus a text alternative, both built by
 * `renderEmail`. What crosses this boundary is `EmailBody`, the structured
 * content model in `layout.ts`, and NOT a rendered string. That is what let two
 * transports with completely unalike payload shapes sit behind one port, and it
 * is why a third could.
 */

export type { SendOutcome };

export type SendEmailInput = {
  to: string;
  /**
   * P8-15 — which of the four mailboxes this comes from. REQUIRED, and
   * deliberately not defaulted.
   *
   * A default would mean a new sender silently inherits somebody else's
   * reputation and somebody else's mute rule, which is the exact failure the
   * split exists to prevent. Making it required costs one line at each of ten
   * call sites and makes the compiler ask the question every time an eleventh
   * appears.
   */
  sender: EmailSender;
  subject: string;
  body: EmailBody;
};

/**
 * The transport. Annotated with the contract rather than left inferred, so the
 * adapter is checked against `EmailTransportAdapter` HERE — at the port, which
 * is the only place that contract means anything.
 */
const deliver: EmailTransportAdapter = sendViaResend;

/**
 * Sends one email, or convincingly explains why it did not.
 *
 * NEVER THROWS. A mailer that throws takes the surrounding transaction with it,
 * and "the approval failed because the notification email bounced" is a much
 * worse outcome than a missing email. Callers get a discriminated outcome and
 * decide what to record.
 */
export async function sendEmail({
  to,
  sender,
  subject,
  body,
}: SendEmailInput): Promise<SendOutcome> {
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

  if (emailMode() === "dry-run") {
    /*
     * No `RESEND_API_KEY`. Render nothing, send nothing, say so.
     *
     * ⚠️ NOT A SUCCESS. Counting this as sent is precisely how the Gate 3 flow
     * reported clean for months while delivering nothing — see `reportOutcome`
     * in `lib/client-approval-server.ts`.
     *
     * Sender, subject and recipient only. The body can carry a client's brief,
     * and in the Gate 3 emails a live approval token; neither belongs in a log
     * that something else ships elsewhere.
     */
    console.info(`[email:dry-run] RESEND_API_KEY unset — ${sender}@ → ${recipient} — ${subject}`);
    return { status: "dry-run" };
  }

  try {
    return await deliver({ to: recipient, sender, subject, body });
  } catch (cause) {
    // A backstop, not the plan. The adapter maps its own failures, because only
    // it can put the transport's own error text into the outcome. This catches
    // the case it did not think of, so that a mail bug can never reach a caller
    // as a thrown error.
    return { status: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  }
}
