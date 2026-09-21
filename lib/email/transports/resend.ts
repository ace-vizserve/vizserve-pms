import "server-only";

import { Resend } from "resend";

import { emailFrom, emailReplyTo, resendConfig } from "../config";
import { renderEmail } from "../layout";

import { createPacer, withTimeout } from "./pacing";
import type { SendOutcome, TransportInput } from "./types";

/**
 * P8-13 / P8-16 — the Resend adapter. THE TRANSPORT — there is no other.
 *
 * Written in P0-11, shelved in P8-10 because `RESEND_API_KEY` was never set —
 * which put the whole system in dry-run and is why a client never received a
 * Gate 3 approval email — and switched on in P8-13 when the key finally
 * arrived. EmailJS carried the traffic in between.
 *
 * WHAT COMING BACK HERE BUYS, and it is the reason D16/Q12 picked a sending
 * domain in the first place:
 *
 *   - a real `text/plain` alternative. `renderEmail` builds both parts; the
 *     EmailJS template is one HTML body. A message with no text part scores
 *     worse with spam filters, and Phase 4 rests entirely on one email reaching
 *     one client's INBOX.
 *   - a message id. EmailJS answers a success with the literal string "OK", so
 *     `sent` carried the transport name and there was nothing to trace. An id
 *     here can be pasted into the Resend dashboard to see whether a message
 *     bounced.
 *   - a sender on a domain VizServe controls, with SPF/DKIM that VizServe set.
 *   - no dashboard-hosted template. The body is built from `EmailBody` in this
 *     repo, reviewed in this repo, and cannot be edited out from under the code
 *     by somebody in a web UI.
 *
 * ⚠️ `EMAIL_FROM` MUST BE ON A DOMAIN VERIFIED IN RESEND. Resend rejects an
 * unverified sender outright, so this is the one setting whose failure mode is
 * "every email fails with a 403 that reads like a permissions bug". The default
 * in `config.ts` is `onboarding@resend.dev`, which Resend will only deliver to
 * the account owner's own address — fine for a first smoke test, useless for
 * anything else.
 *
 * ⚠️ NOTHING HERE ESCAPES ANYTHING, and it must not start: `renderEmail`
 * escapes every value it interpolates, because it builds the HTML itself.
 * Escaping twice is what shows a client `&amp;` where they wrote `&`.
 */

/**
 * The minimum gap between two Resend calls, in milliseconds.
 *
 * Resend's default is TWO REQUESTS PER SECOND per account. 550 rather than 500
 * because the limiter runs on their clock, not ours, and a request that leaves
 * at exactly 500ms arrives inside the previous window often enough to matter.
 *
 * ⚠️ NOT DECORATION. `dispatchPendingEmails` drains fifty outbox rows in one
 * sequential pass; at Resend's typical latency that is comfortably more than
 * two a second, and the overflow comes back 429 `rate_limit_exceeded` — which
 * this adapter would report as `failed` on a row whose claim is already
 * written, i.e. a permanently lost email.
 */
const MIN_INTERVAL_MS = 550;

/**
 * How long to wait on Resend before giving up. See `withTimeout` for what
 * "giving up" does and does not do — it abandons the request, it cannot cancel
 * it.
 */
const SEND_TIMEOUT_MS = 10_000;

const paced = createPacer(MIN_INTERVAL_MS);

let client: Resend | null = null;

function resend(apiKey: string): Resend {
  // Cached across calls because the SDK holds a connection pool, and rebuilt
  // never — a key that changes mid-process is not a case that happens outside a
  // test, and a test can reach for a fresh module.
  client ??= new Resend(apiKey);
  return client;
}

export async function sendViaResend({
  to,
  sender,
  subject,
  body,
}: TransportInput): Promise<SendOutcome> {
  const config = resendConfig();

  // Unreachable through the port, which only selects a configured transport.
  // Kept because an adapter that assumes its own configuration is the one that
  // constructs `new Resend(undefined!)` and fails with a stack trace pointing at
  // the SDK instead of at the missing variable.
  if (!config) {
    return { status: "skipped", reason: "Resend is not configured" };
  }

  const { html, text } = renderEmail(body);

  return paced(() =>
    withTimeout(
      SEND_TIMEOUT_MS,
      async () => {
        try {
          const { data, error } = await resend(config.apiKey).emails.send({
            // P8-15 — one of the four vizserve.com mailboxes, chosen by what
            // this email is. Set per message, which is the whole reason the
            // split is possible at all: a transport whose sender is fixed on
            // the account collapses all four into one.
            from: emailFrom(sender),
            to,
            replyTo: emailReplyTo(),
            subject,
            html,
            text,
          });

          // Resend's own rejection. `error.message` is the only thing that says
          // which of the several ways this can be misconfigured actually
          // happened — an unverified `from` domain and a revoked key both
          // arrive here and read nothing alike.
          if (error) return { status: "failed", error: error.message } as const;
          if (!data?.id) return { status: "failed", error: "Resend returned no message id." } as const;

          return { status: "sent", id: data.id } as const;
        } catch (cause) {
          return {
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          } as const;
        }
      },
      () => ({ status: "failed", error: `Resend did not answer within ${SEND_TIMEOUT_MS}ms.` }),
    ),
  );
}
