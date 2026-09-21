import "server-only";

/**
 * P0-11 / P8-16 — transactional email configuration, the sender addresses and
 * the safety gate.
 *
 * The single most important thing in this file is `isDeliverable()`. This system
 * exists to send real mail to real clients (Phase 4), and the seed data is
 * sixteen accounts one typo away from a colleague's address. Every send goes
 * through that check.
 *
 * ---------------------------------------------------------------------------
 * P8-16 — ONE TRANSPORT. EmailJS is gone.
 *
 * The history, because this file carried the scaffolding for a choice that no
 * longer exists and somebody will wonder why the seams are visible. Resend was
 * built first in P0-11, `RESEND_API_KEY` was never set, `emailMode()` therefore
 * returned `"dry-run"`, and every send was a silent no-op — which is why a
 * client never received a Gate 3 approval email. P8-10 made the transport a
 * CHOICE and EmailJS carried the traffic; P8-13 flipped it back to Resend the
 * day the key arrived; P8-14 deleted the EmailJS template; P8-16 deleted the
 * rest.
 *
 * WHAT SURVIVES THE REMOVAL, and deliberately: `lib/email/send.ts` is still a
 * PORT and `lib/email/transports/resend.ts` is still an ADAPTER behind it. One
 * implementation does not make the seam pointless — the port is where the
 * reserved-domain gate and the never-throws contract live, above any transport,
 * and that is the part that must not be reachable around. The `EMAIL_TRANSPORT`
 * variable is gone because a switch with one position is a lie; the boundary it
 * switched across is not.
 * ---------------------------------------------------------------------------
 */

export type EmailMode = "live" | "dry-run";

export type ResendConfig = { apiKey: string };

export function resendConfig(): ResendConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  return apiKey ? { apiKey } : null;
}

/**
 * `dry-run` when `RESEND_API_KEY` is absent. Renders, logs, sends nothing.
 *
 * Deliberately not an error, and this is unchanged from P0-11: a developer with
 * no key must still be able to run the app, click Approve, and see what would
 * have gone out. A mailer that throws on a missing key turns every server action
 * into a landmine.
 *
 * ⚠️ IT IS ALSO NOT A SUCCESS. `SendOutcome` keeps `dry-run` as its own member
 * for exactly that reason — see the note on the union in
 * `lib/email/transports/types.ts`. Counting it as sent is how the Gate 3 flow
 * reported clean for months while delivering nothing.
 */
export function emailMode(): EmailMode {
  return resendConfig() ? "live" : "dry-run";
}

/**
 * P8-15 — WHICH MAILBOX A MESSAGE COMES FROM.
 *
 * Four addresses on vizserve.com, chosen by what the email IS rather than who
 * it goes to:
 *
 *   approvals@      every approval gate — Gate 1's decisions, Gate 2's QA
 *                   hand-off, Gate 3's client request and its reminders, and
 *                   Phase 5's internal outcomes.
 *   notifications@  the ambient traffic: assignment, status, comments.
 *   support@        the public form's acknowledgement, which is the one email a
 *                   stranger gets and the one they are likeliest to reply to.
 *   survey@         the completion survey, and nothing else.
 *
 * WHY SPLIT AT ALL, given one verified domain would have done. A recipient
 * filters, mutes and — the one that matters — marks as spam PER SENDER. Folding
 * the completion survey in with the Gate 3 approval means one client who is
 * tired of surveys can bin the email Phase 4 rests on. Separate addresses make
 * that a per-purpose decision on their side and a per-purpose reputation on
 * ours.
 *
 * ⚠️ EACH IS A REAL, MONITORED MAILBOX — none is a `noreply@`. A client who
 * hits reply must reach a person, and a From nobody reads is a small but real
 * spam signal on top of that.
 */
export type EmailSender = "approvals" | "notifications" | "support" | "survey";

/**
 * The env var holding each sender's address. Split out so `emailFrom` below is
 * a lookup rather than a switch, and so a missing one names itself in the
 * warning.
 */
const SENDER_ENV: Record<EmailSender, string> = {
  approvals: "EMAIL_FROM_APPROVALS",
  notifications: "EMAIL_FROM_NOTIFICATIONS",
  support: "EMAIL_FROM_SUPPORT",
  survey: "EMAIL_FROM_SURVEY",
};

/**
 * The `From` header for one kind of message.
 *
 * ⚠️ RESEND REJECTS AN UNVERIFIED SENDING DOMAIN. Since P8-13 this is the
 * single likeliest reason for "email is configured and nothing arrives": the
 * key is valid, the transport is live, `emailMode()` says `live`, and every
 * send comes back `failed` with Resend's own 403. D16/Q12 settled the domain as
 * **vizserve.com**; it has to be verified in the Resend dashboard, with the
 * DNS records published, before ANY address on it will send.
 *
 * ✅ VERIFYING THE DOMAIN COVERS ALL FOUR. Resend verifies a domain, not a
 * mailbox, so adding a fifth sender here needs no dashboard work — only that
 * somebody is actually reading the replies.
 *
 * Falls back to `EMAIL_FROM` and then to Resend's shared sandbox sender, which
 * delivers ONLY to the Resend account owner's own address and silently refuses
 * everything else. That last default is right for a fresh checkout with no DNS
 * at all, and exactly wrong to leave in place for Phase 4 — so reaching it says
 * so in the log rather than failing quietly at the transport.
 */
export function emailFrom(sender: EmailSender): string {
  const configured = process.env[SENDER_ENV[sender]] ?? process.env.EMAIL_FROM;
  if (configured) return configured;

  console.warn(
    `[email] neither ${SENDER_ENV[sender]} nor EMAIL_FROM is set — falling back to ` +
      `Resend's sandbox sender, which only delivers to the Resend account owner.`,
  );
  return "VizServe Team Portal <onboarding@resend.dev>";
}

/**
 * Where a reply goes. Optional, and UNSET IS THE RIGHT ANSWER TODAY.
 *
 * ⚠️ DELIBERATELY STATIC, and P8-13 checked this rather than assumed it.
 * The old EmailJS notes described a per-message reply-to — "staff
 * mail should reply to the client, client mail should reply to a monitored
 * mailbox" — which was never implemented and no longer matches the shape of
 * the system:
 *
 *   - all SEVEN senders in `client-emails.ts` go to the CLIENT, so there is no
 *     staff/client split left to vary on. They all want the same monitored
 *     mailbox.
 *   - staff mail goes through `dispatchPendingEmails` instead, off notification
 *     rows that carry no client address. Routing a staff reply to the client
 *     would also be wrong on purpose: a reply typed into an email client is work
 *     that happened outside the system meant to be tracking it. The button in
 *     the body goes to the record; that is the path.
 *
 * With `EMAIL_FROM` set to a real monitored mailbox rather than a `noreply@`,
 * this header is redundant — a Reply-To identical to the From is one more thing
 * to keep in sync for no behaviour. Set it only when the two genuinely differ.
 */
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
