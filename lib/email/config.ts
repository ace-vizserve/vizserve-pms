import "server-only";

/**
 * P0-11 / P8-10 — transactional email configuration, transport selection and
 * the safety gate.
 *
 * The single most important thing in this file is `isDeliverable()`. This system
 * exists to send real mail to real clients (Phase 4), and the seed data is
 * sixteen accounts one typo away from a colleague's address. Every send goes
 * through that check.
 *
 * ---------------------------------------------------------------------------
 * P8-10 — TWO TRANSPORTS, ONE CHOICE, MADE HERE.
 *
 * VizServe sends through EmailJS. Resend was built first, `RESEND_API_KEY` was
 * never set, `emailMode()` therefore returned `"dry-run"`, and every send in the
 * system was a silent no-op — which is why a client never received a Gate 3
 * approval email. The code was written, wired and correct; the transport was
 * simply off.
 *
 * The fix is not "swap Resend for EmailJS". It is to make the transport a
 * CHOICE rather than an assumption, so that the eventual move back to Resend is
 * one environment variable and not a search-and-replace across every call site.
 * `lib/email/send.ts` is the port; `lib/email/transports/*` are the adapters;
 * this file decides which one is in play.
 *
 * The env reading for BOTH adapters lives here rather than in each adapter,
 * because the selection has to be able to ask "is that one actually configured?"
 * without importing the adapters — which import this file. One direction of
 * dependency, no cycle.
 * ---------------------------------------------------------------------------
 */

export type EmailMode = "live" | "dry-run";

/** The transports that exist. Add a member only alongside an adapter. */
export type EmailTransport = "emailjs" | "resend";

export type ResendConfig = { apiKey: string };

/**
 * Everything EmailJS's REST API needs, or null when it is not set up.
 *
 * ⚠️ `EMAILJS_PRIVATE_KEY` CARRIES NO PREFIX — not `VITE_`, not `NEXT_PUBLIC_`.
 * The other three use Vite's prefix, which means nothing to Next and is exactly
 * why they were safe to hand to a browser back when the browser did the sending.
 * The private key never was. An unprefixed name is the guard, and this module is
 * `server-only` so nothing can read it from a component that ships.
 *
 * Null when ANY part is missing, including the private key. A partial config is
 * not a degraded config — EmailJS rejects a REST call without the access token,
 * so three-out-of-four fails at the transport with a message nobody reads.
 * Null means "not set up", and the port degrades to dry-run.
 *
 * ⚠️ SETTING THESE IS NECESSARY BUT NOT SUFFICIENT. Non-browser API requests are
 * DISABLED BY DEFAULT on an EmailJS account: every call comes back 403 with
 * perfectly correct credentials until somebody ticks "Allow EmailJS API for
 * non-browser applications" in **Account → Security**. No amount of code can do
 * that step. See docs/emailjs/README.md.
 */
export type EmailJsConfig = {
  /** EmailJS calls this `user_id` in the REST body. It is the PUBLIC key. */
  publicKey: string;
  serviceId: string;
  templateId: string;
  /** EmailJS calls this `accessToken`. Server-only, never in a bundle. */
  privateKey: string;
};

export function resendConfig(): ResendConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  return apiKey ? { apiKey } : null;
}

export function emailJsConfig(): EmailJsConfig | null {
  // The `VITE_` names are the ones already in `.env` — a leftover prefix from
  // another project that Next ignores entirely. Renaming three live keys to buy
  // nothing but tidiness is a deploy-day outage waiting to happen, so they stay.
  const publicKey = process.env.VITE_EMAILJS_PUBLIC_KEY;
  const serviceId = process.env.VITE_EMAILJS_SERVICE_ID;
  const templateId = process.env.VITE_EMAILJS_TEMPLATE_ID;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;

  if (!publicKey || !serviceId || !templateId || !privateKey) return null;
  return { publicKey, serviceId, templateId, privateKey };
}

/** Whether the named transport could send right now. */
export function isTransportConfigured(transport: EmailTransport): boolean {
  return transport === "emailjs" ? emailJsConfig() !== null : resendConfig() !== null;
}

/**
 * Which adapter the port will use.
 *
 * `EMAIL_TRANSPORT` wins when it names a transport that exists. An explicit
 * choice has to beat inference, because the one case that matters is a machine
 * where BOTH are configured and somebody is deliberately testing the other one.
 *
 * With it unset, infer from what is configured — EmailJS first, because that is
 * what VizServe uses and an inferred default that is not today's answer is a
 * trap. A garbage value is treated as unset rather than throwing: a typo in an
 * env var must not take the app down on boot, and the dry-run below is a loud
 * enough symptom.
 *
 * Falls back to `emailjs` when NEITHER is configured, so the log line a
 * developer sees names the transport they will eventually be configuring rather
 * than the one they will not.
 */
export function emailTransport(): EmailTransport {
  const requested = process.env.EMAIL_TRANSPORT?.trim().toLowerCase();

  if (requested === "emailjs" || requested === "resend") return requested;

  if (emailJsConfig()) return "emailjs";
  if (resendConfig()) return "resend";

  return "emailjs";
}

/**
 * `dry-run` when the SELECTED transport is not configured. Renders, logs, sends
 * nothing.
 *
 * Deliberately not an error, and this is unchanged from P0-11: a developer with
 * no keys must still be able to run the app, click Approve, and see what would
 * have gone out. A mailer that throws on a missing key turns every server action
 * into a landmine.
 *
 * ⚠️ IT IS ALSO NOT A SUCCESS. `SendOutcome` keeps `dry-run` as its own member
 * for exactly that reason — see the note on the union in
 * `lib/email/transports/types.ts`.
 *
 * The selected transport, not "any transport": with `EMAIL_TRANSPORT=resend` and
 * only the EmailJS keys present, this is dry-run and says so. Answering "live"
 * because some OTHER transport happens to be configured is how you get a system
 * that reports healthy and delivers nothing.
 */
export function emailMode(): EmailMode {
  return isTransportConfigured(emailTransport()) ? "live" : "dry-run";
}

export function emailFrom(): string {
  // Resend rejects an unverified sending domain, so this is required in
  // production and defaulted only so dry-run has something to render.
  return process.env.EMAIL_FROM ?? "VizServe PMS <onboarding@resend.dev>";
}

export function emailReplyTo(): string | undefined {
  return process.env.EMAIL_REPLY_TO || undefined;
}

/**
 * Absolute base URL for links in email bodies.
 *
 * Every email links to the exact record (docs/12 §3 rule 2), and a relative path
 * in an email body links to nothing at all.
 */
export function appUrl(): string {
  const raw =
    // NEXT_PUBLIC_SITE_URL, not a second APP_URL variable — app/login/actions.ts
    // already builds the OAuth redirect from it, and two names for one origin is
    // how the SSO callback and the email links end up pointing at different
    // hosts.
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    // Port 3000 on the build machine is the HFSE SIS app, whose login page also
    // says "Welcome back" — so a wrong default here fails silently and
    // convincingly.
    "http://localhost:3177";

  return raw.replace(/\/+$/, "");
}

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${appUrl()}/${path.replace(/^\/+/, "")}`;
}

/**
 * IANA reserves example.com precisely so that it can never route anywhere.
 * Every seeded account uses it, and dev/staging must never deliver real mail
 * (docs/04). This is the last line of that rule, enforced below every call site
 * rather than remembered at each one.
 */
const UNDELIVERABLE_DOMAINS = ["example.com", "example.org", "example.net", "test", "invalid", "localhost"];

export function isDeliverable(address: string): boolean {
  const domain = address.trim().toLowerCase().split("@")[1];
  if (!domain) return false;
  return !UNDELIVERABLE_DOMAINS.some(
    (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
  );
}

/**
 * Escapes text for interpolation into an HTML email body.
 *
 * Request titles and decision reasons are attacker-influenced — they come off a
 * public, unauthenticated form. Not escaping them means a submitted title can
 * rewrite the email a Team Leader reads.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
