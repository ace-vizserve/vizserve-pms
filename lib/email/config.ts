import "server-only";

/**
 * P0-11 — transactional email configuration and the safety gate.
 *
 * The single most important thing in this file is `isDeliverable()`. This system
 * exists to send real mail to real clients (Phase 4), and the seed data is
 * sixteen accounts one typo away from a colleague's address. Every send goes
 * through that check.
 */

export type EmailMode = "live" | "dry-run";

/**
 * `dry-run` when there is no API key. Renders and logs, sends nothing.
 *
 * Deliberately not an error: a developer with no Resend key must still be able
 * to run the app, click Approve, and see what would have gone out. A mailer that
 * throws on a missing key turns every server action into a landmine.
 */
export function emailMode(): EmailMode {
  return process.env.RESEND_API_KEY ? "live" : "dry-run";
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
