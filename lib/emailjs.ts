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

/**
 * One stage in the progress trail, as the template's `{{#timeline}}` loop reads
 * it. The property names ARE the template's variable names.
 */
export type EmailTimelineEntry = {
  label: string;
  detail: string;
  /** Already formatted for reading — EmailJS does no date formatting. */
  at: string;
};

/**
 * The `{{variable}}` bag EmailJS substitutes into the template.
 *
 * Mostly strings, plus the one array the timeline loop iterates. EmailJS caps
 * the combined size of dynamic variables at 50KB; a trail of six stages is
 * nowhere near it, but a loop is the first thing here that could grow, so the
 * limit is worth knowing about.
 */
export type EmailJsParams = Record<string, string | EmailTimelineEntry[]>;

/**
 * The client-facing stage wording.
 *
 * ⚠️ MIRRORED FROM `vizserve_pms_get_request_status`
 * (`20260825150000_p7_51_request_status_page.sql`), which is the source of
 * truth — it is what `/status/[token]` renders. An email and a page describing
 * the same stage in different words is how a client ends up asking which one is
 * right, so these strings are pinned by a test rather than left to memory.
 *
 * Only the two stages an EmailJS send can reach are here. The later ones
 * (in progress, QA, sent for approval, completed) are reached by task movement,
 * which does not send through this module — see the header note on the
 * client/internal split.
 */
export const STAGE_RECEIVED = {
  label: "Request received",
  detail: "We have your request and it is queued for review.",
} as const;

export const STAGE_APPROVED = {
  label: "Approved — work scheduled",
  detail: "A team member has been assigned and work is scheduled.",
} as const;

/** The heading above the trail. Absent when there are no stages to show. */
const PROGRESS_TITLE = "Progress so far";

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
function base(subject: RequestEmailSubject, timeline: EmailTimelineEntry[]): EmailJsParams {
  return {
    // The trail, and the heading that only exists when the trail does — a
    // heading inside the loop would repeat once per stage.
    timeline,
    progress_title: timeline.length > 0 ? PROGRESS_TITLE : "",
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
    // One stage, because one stage is all that has happened. The trail is not
    // padded with the stages still to come: an email listing "In quality check"
    // against a request nobody has picked up yet promises a schedule that does
    // not exist.
    ...base(subject, [{ ...STAGE_RECEIVED, at: subject.submittedAt }]),
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
 *
 * `decidedAt` is when the approval happened, for the trail's second stage.
 * Formatted by the caller, like every other date in this bag — EmailJS does no
 * date formatting and a raw ISO string in a client's email reads as a fault.
 */
export function approvedParams(
  subject: RequestEmailSubject,
  agreedDate: string | null,
  decidedAt: string,
): EmailJsParams {
  return {
    // Two stages: what the client already saw in their acknowledgement, plus
    // what just happened. Repeating the first is deliberate — this email is
    // read on its own, often weeks later, and a trail starting at "Approved"
    // gives no sense of how long it took.
    ...base(subject, [
      { ...STAGE_RECEIVED, at: subject.submittedAt },
      { ...STAGE_APPROVED, at: decidedAt },
    ]),
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
