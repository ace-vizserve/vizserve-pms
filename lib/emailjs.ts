/**
 * P7-49 — EmailJS, the client-facing half of request mail.
 *
 * WHAT THIS DOES AND DOES NOT COVER, because the split is deliberate:
 *
 *   CLIENT mail (the requester)   → here, EmailJS, from the browser
 *   INTERNAL mail (TL, PIC, QA)   → stays in lib/email/, the Resend outbox
 *
 * The internal notifications already route correctly: `vizserve_pms_notify()`
 * resolves who leads the request's department and writes a row per person, and
 * the outbox drains it. Reproducing that through EmailJS would mean hardcoding a
 * staff address list in a template — which mails the same two people whatever
 * department the request belongs to, and is wrong the first time somebody joins.
 *
 * So EmailJS carries exactly the two emails that have no user row to route to,
 * which is the same reason `lib/email/client-emails.ts` sends those directly
 * rather than through the outbox.
 *
 * ⚠️ IF `RESEND_API_KEY` IS EVER SET, THE CLIENT GETS TWO OF EACH. The Resend
 * path in `client-emails.ts` is still wired and currently silent only because
 * the mailer is in dry-run. Turning Resend on means removing the calls to this
 * module, or vice versa — not both.
 */

/** Read from the server and handed to the browser. See `emailJsConfig`. */
export type EmailJsConfig = {
  publicKey: string;
  serviceId: string;
  templateId: string;
};

/**
 * Where a client's reply should land.
 *
 * NOT the requester's own address. On the staff-facing side reply-to is the
 * client, so hitting Reply reaches them; on a client-facing email the same value
 * would send their reply to themselves, and a question about their own request
 * would reach nobody.
 *
 * A constant rather than an env var because it is not a secret and not
 * per-environment — change it here when there is a shared mailbox.
 */
const CLIENT_REPLY_TO = "kurt.vizserve@gmail.com";

/**
 * The config, or null when it is not set up.
 *
 * READS THE `VITE_` NAMES ALREADY IN `.env`. That prefix is Vite's and means
 * nothing to Next, so these are invisible to the browser — which is why this
 * runs on the SERVER and the values are passed down as props. The alternative
 * was renaming three keys to `NEXT_PUBLIC_*`; this way nothing in `.env` has to
 * change and the values still reach the browser, because a prop on a client
 * component is serialised into the page either way.
 *
 * That is safe for exactly these three: an EmailJS public key is designed to be
 * public, and the service and template ids are not credentials. Do NOT extend
 * this to EmailJS's PRIVATE key — that one belongs in a server action only.
 *
 * Returns null rather than throwing when unset, so a missing key degrades to
 * "no client email" instead of a broken form.
 */
export function emailJsConfig(): EmailJsConfig | null {
  const publicKey = process.env.VITE_EMAILJS_PUBLIC_KEY;
  const serviceId = process.env.VITE_EMAILJS_SERVICE_ID;
  const templateId = process.env.VITE_EMAILJS_TEMPLATE_ID;

  if (!publicKey || !serviceId || !templateId) return null;
  return { publicKey, serviceId, templateId };
}

/** Everything the template needs about the request itself. */
export type RequestEmailSubject = {
  referenceNo: string;
  requesterName: string;
  requesterEmail: string;
  requesterOrg: string;
  title: string;
  description: string;
  formName: string;
  /** Already formatted for reading, or null. */
  targetDate: string | null;
  submittedAt: string;
  /**
   * P7-51. The tracking page, or null when the token could not be issued.
   * Null renders as an empty string in the template, which is why the button
   * markup there is wrapped rather than always present.
   */
  statusUrl?: string | null;
};

/** The flat `{{variable}}` bag EmailJS substitutes into the template. */
export type EmailJsParams = Record<string, string>;

/**
 * `Maria Santos` → `Maria`. A greeting uses a first name; the full name in the
 * table below it is where the formal version belongs.
 */
function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || "there";
}

/**
 * Never `undefined`, and this is the whole reason this builder exists.
 *
 * EmailJS renders an unresolved variable as an empty string and reports no
 * error, so a missing value ships as a labelled row with a blank beside it —
 * which reads to a client as a broken email rather than as "not specified".
 * Building the bag in one place means the fallbacks cannot be forgotten at a
 * call site.
 */
function base(subject: RequestEmailSubject): EmailJsParams {
  return {
    reference_no: subject.referenceNo,
    requester_name: subject.requesterName,
    requester_email: subject.requesterEmail,
    requester_org: subject.requesterOrg || "HFSE",
    title: subject.title,
    description: subject.description,
    form_name: subject.formName,
    target_date: subject.targetDate ?? "Not specified",
    submitted_at: subject.submittedAt,
    // Empty string rather than absent, so the template renders nothing instead
    // of the literal text "undefined" in an href.
    status_url: subject.statusUrl ?? "",
  };
}

/** "Received" — sent the moment the public form is submitted. */
export function receivedParams(subject: RequestEmailSubject): EmailJsParams {
  return {
    ...base(subject),
    to_email: subject.requesterEmail,
    reply_to: CLIENT_REPLY_TO,
    intro: `Hi ${firstName(subject.requesterName)}, thanks for sending this through.`,
    status_label: "Received",
    status_note:
      "It has reached the team and somebody will review it shortly. You do not need to do anything else for now — you can check progress any time using the link below.",
  };
}

/**
 * "Approved" — sent when a Team Leader accepts the request.
 *
 * ⚠️ `agreedDate` IS THE NEGOTIATED DATE, not the one the client asked for.
 * Gate 1 exists to move `target_date` to `approved_target_date`, and this is the
 * only moment the client is told what was actually agreed. Passing the requested
 * date here would be the app confirming a commitment nobody made.
 */
export function approvedParams(
  subject: RequestEmailSubject,
  agreedDate: string | null,
): EmailJsParams {
  return {
    ...base(subject),
    to_email: subject.requesterEmail,
    reply_to: CLIENT_REPLY_TO,
    intro: `Hi ${firstName(subject.requesterName)}, there is an update on your request.`,
    status_label: "Approved and under way",
    status_note: agreedDate
      ? `Somebody is now working on this. The team has committed to ${agreedDate} — if that does not work for you, reply and tell us now rather than closer to the day.`
      : "Somebody is now working on this. We have not fixed a delivery date yet and will confirm one with you shortly.",
    // Overridden so the table shows what was AGREED rather than what was asked.
    // Everything else in the email is about the request as submitted; this one
    // row is about the decision.
    target_date: agreedDate ?? "To be confirmed",
  };
}
