import type { EmailBody } from "../layout";

/**
 * P8-10 — the contract every transport implements.
 *
 * Declared here rather than in `send.ts` so the adapters can import it without
 * importing the port that imports them. A type-only cycle is erased at build
 * time and would work, but it is the kind of thing that survives until somebody
 * adds a value export to it and then spends an afternoon on a circular-import
 * error that has nothing to do with what they were changing.
 *
 * `send.ts` re-exports `SendOutcome`, because every existing call site imports
 * it from there and the whole point of this change is that none of them moves.
 */

/**
 * What a send produced, or convincingly why it did not.
 *
 * ⚠️ THIS UNION IS FROZEN. Seven senders in `client-emails.ts`, the outbox drain
 * and the Gate 3 module all branch on it; widening it means visiting all of
 * them, and narrowing it means one of them silently stops handling a case.
 *
 * `dry-run` is NOT a success and must never be counted as one — that mistake is
 * exactly why a client never received a Gate 3 approval email for months while
 * QA saw a clean "moved to For client approval". It stays in the union because a
 * developer with no keys still has to be able to run the app; it is a distinct
 * member precisely so a caller cannot fold it into `sent` by accident.
 */
export type SendOutcome =
  | { status: "sent"; id: string }
  | { status: "dry-run" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/**
 * What the port hands an adapter.
 *
 * Identical to `SendEmailInput` on purpose — the adapter receives exactly what
 * the caller wrote, with `to` already trimmed and already past the deliverability
 * gate. It is a separate name so that a future port-level addition (a tag, an
 * idempotency key) has somewhere to land that is not the public signature.
 */
export type TransportInput = {
  /** Trimmed, contains an `@`, and NOT a reserved domain. Checked by the port. */
  to: string;
  subject: string;
  body: EmailBody;
};

/**
 * An adapter: one email in, one outcome out, and it never throws.
 *
 * A mailer that throws takes the surrounding transaction with it, and "the
 * approval failed because the notification email bounced" is a much worse
 * outcome than a missing email. The port catches anyway as a backstop, but each
 * adapter owning its own failure mapping is what lets it put the transport's own
 * error text into the outcome — which is the only thing that says WHICH of the
 * several ways this can be misconfigured actually happened.
 */
export type EmailTransportAdapter = (input: TransportInput) => Promise<SendOutcome>;
