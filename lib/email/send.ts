import "server-only";

import { Resend } from "resend";

import { emailFrom, emailMode, emailReplyTo, isDeliverable } from "./config";
import { renderEmail, type EmailBody } from "./layout";

/**
 * P0-11 — the one function that actually talks to Resend.
 *
 * Every send in the system goes through here so that the safety gate, the
 * dry-run mode and the error handling exist once rather than at each call site.
 */

export type SendOutcome =
  | { status: "sent"; id: string }
  | { status: "dry-run" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

let client: Resend | null = null;

function resend(): Resend {
  client ??= new Resend(process.env.RESEND_API_KEY!);
  return client;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  body: EmailBody;
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

  // The seed safety rule, enforced rather than remembered. Every test account is
  // @example.com and a QA run must not be one typo away from mailing a client.
  if (!isDeliverable(recipient)) {
    return { status: "skipped", reason: `reserved domain, never delivered: ${recipient}` };
  }

  const { html, text } = renderEmail(body);

  if (emailMode() === "dry-run") {
    // Subject and recipient only. The body can contain a client's brief.
    console.info(`[email:dry-run] → ${recipient} — ${subject}`);
    return { status: "dry-run" };
  }

  try {
    const { data, error } = await resend().emails.send({
      from: emailFrom(),
      to: recipient,
      replyTo: emailReplyTo(),
      subject,
      html,
      text,
    });

    if (error) return { status: "failed", error: error.message };
    if (!data?.id) return { status: "failed", error: "Resend returned no message id." };

    return { status: "sent", id: data.id };
  } catch (cause) {
    return { status: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  }
}
