import "server-only";

import { absoluteUrl, emailJsConfig, emailReplyTo } from "../config";
import type { EmailBody } from "../layout";

import type { SendOutcome, TransportInput } from "./types";

/**
 * P8-10 — the EmailJS adapter. Today's transport.
 *
 * ⛔ NO `@emailjs/browser` IMPORT HERE, and there is no longer one anywhere.
 * That package is the browser SDK: it expects a DOM and it authenticates with
 * the public key alone. The REST call below is plain `fetch` against a
 * documented endpoint and needs no dependency — pulling in a package to reach an
 * HTTP POST is supply-chain risk for no benefit.
 *
 * WHY THE SERVER AND NOT THE BROWSER, which is where this used to happen for
 * two of the seven emails. A browser send dies if the tab closes, and four of
 * the seven have no browser anywhere near them: the reminder sweep and the
 * auto-complete pass are an hourly cron. Two transports for one system also
 * means two safety gates, two escaping rules and two sets of copy — and the
 * browser half quietly bypassed `isDeliverable`, so a QA run against a seeded
 * account was one typo from mailing a real client.
 *
 * ⚠️ NON-BROWSER API REQUESTS ARE DISABLED BY DEFAULT ON AN EMAILJS ACCOUNT.
 * Every call here comes back 403 with perfectly correct credentials until
 * somebody ticks "Allow EmailJS API for non-browser applications" in
 * **Account → Security**. That is a step in the EmailJS dashboard that no amount
 * of code can do, and it is the first thing to check when nothing sends.
 *
 * ⚠️ EMAILJS HTML-ESCAPES EVERY `{{placeholder}}`. So NOTHING in this file
 * escapes anything — see `emailJsTemplateParams` below. The Resend adapter's
 * `renderEmail` escapes because it builds the HTML itself; doing it on both
 * paths would show a client `&amp;` where they wrote `&`, and that is the single
 * easiest bug to ship here.
 */

/** https://www.emailjs.com/docs/rest-api/send/ */
const EMAILJS_SEND_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";

/**
 * The minimum gap between two EmailJS calls, in milliseconds.
 *
 * EmailJS allows ONE REQUEST PER SECOND per account. 1100 rather than 1000
 * because the limiter runs on their clock, not ours, and a request that leaves
 * at exactly 1000ms arrives inside the previous second often enough to matter.
 * The cost of being wrong in this direction is a hundred milliseconds per email.
 */
const MIN_INTERVAL_MS = 1100;

/**
 * How long to wait on EmailJS before giving up.
 *
 * A third-party HTTP call with no timeout inside a server action holds the
 * user's response open for as long as the other end feels like taking. The Gate
 * 3 cron has `maxDuration = 60` for a whole sweep, so one hung send must not be
 * allowed to eat it.
 */
const SEND_TIMEOUT_MS = 10_000;

/**
 * The `{{variable}}` bag `docs/emailjs/template.html` substitutes into.
 *
 * ⚠️ THESE KEYS ARE THE TEMPLATE'S VARIABLE NAMES. EmailJS renders a missing
 * variable as an empty string and reports no error, so a rename on one side and
 * not the other ships as a blank in a client's inbox with nothing anywhere
 * saying why. `tests/unit/emailjs-template.test.ts` reads the real template and
 * checks every placeholder in it is a key here.
 */
export type EmailJsTemplateParams = {
  to_email: string;
  reply_to: string;
  subject: string;
  preheader: string;
  heading: string;
  /** ⚠️ An array of OBJECTS. EmailJS loops arrays; `string[]` has no field to read. */
  paragraphs: { text: string }[];
  /** The loop's guard. Empty when there are none — see the truthiness note below. */
  has_facts: string;
  facts: { label: string; value: string }[];
  quote_label: string;
  quote_text: string;
  button_url: string;
  button_label: string;
  footnote: string;
};

/**
 * `EmailBody` → the template's variables. The heart of this adapter, and the
 * only part of it worth unit-testing, so it is pure and exported.
 *
 * FOUR RULES, all of them things EmailJS does that nothing warns you about:
 *
 *  1. NOTHING IS ESCAPED HERE. `{{like_this}}` is HTML-escaped by EmailJS, so a
 *     brief containing a `<` is already safe and a title containing an `&`
 *     already arrives as `&`. Escaping first would show the client `&amp;`. (Do
 *     not "fix" that with a triple-brace placeholder in the template either —
 *     that disables escaping and lets a submitted brief inject markup into an
 *     email going to your own staff.)
 *
 *  2. A LOOP ITERATES AN ARRAY OF OBJECTS, and inside the block the item's
 *     fields resolve, not the top-level bag. `EmailBody.paragraphs` is
 *     `string[]`, which has nothing to name, so each one is wrapped as
 *     `{ text }`. `facts` is already `{ label, value }[]` and passes straight
 *     through.
 *
 *  3. AN EMPTY STRING IS FALSEY to a section block, and that is the mechanism
 *     every optional part of the template uses. So every key is always present
 *     and empty rather than absent — both behave identically to EmailJS, and one
 *     shape means a missing key is a bug rather than a normal state.
 *
 *  4. A FACTS LOOP CANNOT GUARD ITS OWN WRAPPER — the panel around the rows
 *     would repeat once per row. `has_facts` is a separate scalar for the same
 *     reason the old template carried `progress_title`: the container is drawn
 *     once, the contents repeat.
 *
 * The button path becomes an ABSOLUTE url here. `absoluteUrl` passes anything
 * already starting with http(s) straight through, so a caller that built the
 * whole link (the tracking page) and one that passed a path (`/approve/{token}`)
 * both work. A relative path in a mail client links to nothing at all.
 */
export function emailJsTemplateParams(
  body: EmailBody,
  envelope: { to: string; subject: string },
): EmailJsTemplateParams {
  return {
    // `to_email` is a template VARIABLE, and that is what makes one template
    // enough for all seven emails: the caller decides who receives it. Hardcode
    // it in the dashboard and you need one template per recipient, and they
    // drift.
    to_email: envelope.to,
    // One reply-to for both transports, out of one variable. The Resend adapter
    // reads the same `EMAIL_REPLY_TO`; two sources for "where does a reply go"
    // is how a client's question about their own request reaches nobody. Empty
    // means EmailJS falls back to the service's own default.
    reply_to: emailReplyTo() ?? "",
    subject: envelope.subject,
    preheader: body.preheader,
    heading: body.heading,
    paragraphs: body.paragraphs.map((text) => ({ text })),
    has_facts: body.facts && body.facts.length > 0 ? "yes" : "",
    facts: body.facts ?? [],
    quote_label: body.quote?.label ?? "",
    quote_text: body.quote?.text ?? "",
    button_url: body.button ? absoluteUrl(body.button.path) : "",
    button_label: body.button?.label ?? "",
    footnote: body.footnote ?? "",
  };
}

/*
 * ---------------------------------------------------------------------------
 * The rate limit, handled HERE and nowhere else.
 *
 * EmailJS allows one request per second per account. Two callers send in a
 * loop — the Gate 3 reminder cron and the notification outbox drain — and a
 * third will exist the moment somebody adds a digest. A throttle written at each
 * loop site is a throttle that will be forgotten at the next one, and the
 * symptom is the nastiest kind: the first few emails go out, the rest are
 * refused, and every log line about the successful ones looks fine.
 *
 * So it lives in the adapter, where "cannot exceed one per second" is stated
 * once and cannot be bypassed by a caller who did not know about it. The price
 * is a hidden sleep inside a function called "send one email", which is a real
 * surprise for a server action holding an HTTP response open — that was the
 * argument for putting it at the call sites, and it lost. A single send waits
 * for nothing (the gate only delays when a previous send was recent), and a
 * server action that sends two emails back to back is already doing something it
 * should be handing to the outbox.
 *
 * HONEST GAP: this is per PROCESS. Two serverless instances running the cron and
 * a server action at the same moment can still exceed one per second between
 * them. A cross-instance limiter needs shared state (a Postgres advisory lock, a
 * counter row) and is not worth it for a system whose steady-state volume is a
 * few emails an hour — but it is the reason a burst can still see a 429, which
 * is why that comes back as a `failed` outcome carrying EmailJS's own text
 * rather than as a crash.
 * ---------------------------------------------------------------------------
 */

/** When the last request left, as `Date.now()`. Zero means "none yet". */
let lastSendAt = 0;

/**
 * The tail of the queue. Every send chains onto it, so two concurrent callers
 * are serialised rather than racing — without this both would read the same
 * `lastSendAt`, both would decide they could go, and both would go at once.
 */
let queue: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paced<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastSendAt);
    if (lastSendAt > 0 && wait > 0) await sleep(wait);

    // Stamped BEFORE the request, not after. The limit is on when a request
    // arrives, so a slow send must not be paid for twice.
    lastSendAt = Date.now();
    return work();
  });

  // The queue must never become a rejected promise, or every subsequent send
  // inherits the failure. `work()` does not reject — see `sendViaEmailJs` — but
  // the queue is the one place where being wrong about that is permanent.
  queue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

/**
 * Sends one email through EmailJS, or explains why it did not. NEVER THROWS.
 *
 * The config is read here rather than passed in: passing a bag containing the
 * PRIVATE key through a call chain is how one ends up serialised into a page.
 */
export async function sendViaEmailJs({ to, subject, body }: TransportInput): Promise<SendOutcome> {
  const config = emailJsConfig();

  // Unreachable through the port, which only selects a configured transport —
  // kept so the adapter is honest when called directly.
  if (!config) {
    return { status: "skipped", reason: "EmailJS is not configured" };
  }

  const params = emailJsTemplateParams(body, { to, subject });

  return paced(async () => {
    try {
      const response = await fetch(EMAILJS_SEND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: config.serviceId,
          template_id: config.templateId,
          // `user_id` IS THE PUBLIC KEY. The naming is EmailJS's and it is
          // genuinely confusing: `user_id` is the public key that also
          // authenticates browser sends, and `accessToken` is the private key
          // the non-browser API additionally demands.
          user_id: config.publicKey,
          accessToken: config.privateKey,
          template_params: params,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (!response.ok) {
        // EmailJS answers a rejected send with a PLAIN-TEXT body, not JSON —
        // "The user ID is required", "API calls are disabled for non-browser
        // applications", and so on. It is the only thing that says which of the
        // several ways this can be misconfigured actually happened, so it goes
        // into the outcome verbatim.
        const detail = await response.text().catch(() => "");
        const message = `${response.status} ${response.statusText}${detail.trim() ? ` — ${detail.trim()}` : ""}`;

        return { status: "failed", error: message };
      }

      /*
       * ⚠️ EMAILJS RETURNS NO MESSAGE ID — the body of a success is the literal
       * string "OK". `SendOutcome` requires one, so the transport name stands in
       * where Resend supplies a real id.
       *
       * That is a genuine loss and worth naming: with Resend an id in a log can
       * be pasted into their dashboard to see whether a message bounced. Here
       * there is nothing to trace, which is the other reason the Resend adapter
       * is kept rather than deleted.
       */
      return { status: "sent", id: "emailjs" };
    } catch (error) {
      // A network failure, a DNS failure, or the abort above. `.message` on an
      // AbortError reads as "The operation was aborted due to timeout", which is
      // exactly what somebody reading the log needs.
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  });
}
