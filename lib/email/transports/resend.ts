import "server-only";

import { Resend } from "resend";

import { emailFrom, emailReplyTo, resendConfig } from "../config";
import { renderEmail } from "../layout";

import type { SendOutcome, TransportInput } from "./types";

/**
 * P8-10 — the Resend adapter. LIFTED OUT OF `send.ts` UNCHANGED.
 *
 * Every line of this was already working in P0-11 and none of its behaviour has
 * been altered: same client, same `renderEmail`, same error mapping, same
 * outcome. It moved so that `send.ts` could stop being one transport's
 * implementation and start being the port that chooses between two.
 *
 * NOT DEAD CODE, and worth saying plainly because it currently sends nothing.
 * VizServe is on EmailJS today; Resend is where this goes when the volume or the
 * deliverability reporting justifies a real ESP, and D16/Q12 already picked the
 * sending domain. Keeping the adapter alive means that move is
 * `EMAIL_TRANSPORT=resend` plus a key, verified by the same tests, rather than a
 * rewrite under time pressure. The cost is one dependency and one file.
 *
 * WHAT THIS ADAPTER HAS THAT THE OTHER DOES NOT: a real `text/plain` alternative
 * (`renderEmail` builds both parts), a message id to log, and a sender address
 * on a domain VizServe controls. Those are the reasons to come back to it.
 */

let client: Resend | null = null;

function resend(apiKey: string): Resend {
  // Cached across calls because the SDK holds a connection pool, and rebuilt
  // never — a key that changes mid-process is not a case that happens outside a
  // test, and a test can reach for a fresh module.
  client ??= new Resend(apiKey);
  return client;
}

export async function sendViaResend({ to, subject, body }: TransportInput): Promise<SendOutcome> {
  const config = resendConfig();

  // Unreachable through the port, which only selects a configured transport.
  // Kept because an adapter that assumes its own configuration is the one that
  // constructs `new Resend(undefined!)` and fails with a stack trace pointing at
  // the SDK instead of at the missing variable.
  if (!config) {
    return { status: "skipped", reason: "Resend is not configured" };
  }

  const { html, text } = renderEmail(body);

  try {
    const { data, error } = await resend(config.apiKey).emails.send({
      from: emailFrom(),
      to,
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
