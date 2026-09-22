import "server-only";

import { NOTIFICATION_EMAIL_SENDER } from "@/lib/notifications";
import { richTextToPlainText } from "@/lib/rich-text";

import type { VizservePmsNotificationType } from "@/lib/database.types";
import { createAdminClient } from "@/utils/supabase/admin";

import type { EmailBody } from "./layout";
import { sendEmail } from "./send";

/**
 * P0-11 — the notification outbox.
 *
 * `vizserve_pms_notify()` already writes a row with `send_email` resolved from
 * the per-type settings table. Nothing consumed it. This is the consumer.
 *
 * Modelled as an outbox drain rather than a send-at-write-time call, for three
 * reasons that all bite otherwise:
 *
 *   1. The Phase 1 submission path runs INSIDE Postgres. A SECURITY DEFINER
 *      function cannot call Resend, so the notification it writes could never be
 *      emailed by any amount of code in the server action above it.
 *   2. An email failure must not roll back the thing that caused it. Approving a
 *      request and creating its task is atomic (P2-07); the email about it is
 *      explicitly not part of that transaction.
 *   3. Retry becomes free. A row with `send_email` and no `emailed_at` is,
 *      by definition, an email still owed.
 *
 * `emailed_at` is both the sent-marker and the claim, so two overlapping runs
 * cannot double-send.
 */

/**
 * Per-type presentation. The notification row carries title/body/link, which is
 * enough for the inbox; email needs a subject line and a call to action too.
 *
 * Only the types with `send_email = true` in the settings table can reach here,
 * but every type is mapped anyway — the switch is flippable at runtime without a
 * deploy, and an unmapped type would then send a blank email.
 */
const PRESENTATION: Record<
  VizservePmsNotificationType,
  {
    subject: (title: string) => string;
    action: string;
    /**
     * P8-14 — the chip under the heading, where the TYPE alone settles what it
     * should say.
     *
     * ⚠️ MOST TYPES GET NONE, AND THAT IS THE POINT. A notification row carries
     * a title, a body and a link — no status column — so for `client_decision`
     * or `status_changed` any chip would be invented: the row does not say
     * whether the client approved or rejected, and a confident "Client
     * responded" in the app's own chip is worse than no chip, because the app's
     * chips are otherwise trustworthy.
     *
     * Three types DO settle it on their own: something is waiting on you, a
     * task is yours, a task is yours to QA. Those get one.
     */
    status?: NonNullable<EmailBody["status"]>;
  }
> = {
  // P8-15's sender choice is NOT here any more — it is
  // `NOTIFICATION_EMAIL_SENDER` in `lib/notifications.ts`, read at the send
  // below. It moved so P8-19's settings screen, which is a client component and
  // cannot import this `server-only` file, can tell an owner which mailbox a
  // switch is about without a second copy of the map.
  pending_approval: {
    subject: (title) => `Approval needed — ${title}`,
    action: "Review the request",
    status: { label: "Awaiting your approval", tone: "warning" },
  },
  assigned: {
    subject: (title) => `Assigned to you — ${title}`,
    action: "Open the task",
    status: { label: "Assigned to you", tone: "brand" },
  },
  // Gate 2. An approval in everything but the name — see CLAUDE.md's three-gate
  // spine.
  qa_requested: {
    subject: (title) => `Ready for your QA — ${title}`,
    action: "Open QA",
    status: { label: "Ready for QA", tone: "warning" },
  },
  // Gate 3's answer coming back. The staff-side half of `approvals@`.
  client_decision: {
    subject: (title) => `Client decision — ${title}`,
    action: "Open the task",
  },
  status_changed: {
    subject: (title) => title,
    action: "Open in VizServe Team Portal",
  },
  // Ships email-off (P5-05 seeds send_email = false) — the requester is staff
  // with an inbox, and docs/12 reserves email for people who have no other
  // channel. Mapped regardless, because the switch is flippable at runtime
  // without a deploy and an unmapped type would then send a blank email.
  internal_decision: {
    subject: (title) => `Your request — ${title}`,
    action: "Open the request",
  },
  // Also email-off (P7-08 seeds send_email = false). Discussion on a shared task
  // is not an interruption, and a mailbox copy of every comment is the fastest
  // way to teach people to filter this system into a folder they never open.
  /*
   * P8-18 — THE ONE KIND OF COMMENT THAT IS WORTH AN EMAIL.
   *
   * `commented` below is deliberately inbox-only: a mailbox copy of every
   * remark on a shared task is the fastest way to teach people to filter this
   * system into a folder they never open. A MENTION is the opposite case and
   * the distinction is the whole argument — somebody typed your name because
   * they are waiting on you specifically, which is the same test docs/12 §3
   * applies to an assignment or a QA hand-off.
   *
   * It sends from `notifications@`, not `approvals@` — nothing is being
   * decided. That choice lives in `NOTIFICATION_EMAIL_SENDER`.
   */
  mentioned: {
    subject: (title) => `You were mentioned — ${title}`,
    action: "Open the task",
    status: { label: "You were mentioned", tone: "brand" },
  },
  commented: {
    subject: (title) => title,
    action: "Open the task",
  },
};

export type DispatchSummary = {
  claimed: number;
  sent: number;
  /**
   * ⚠️ ITS OWN COUNTER, NOT PART OF `sent`, AND THIS IS THE SECOND TIME THE
   * DISTINCTION HAS HAD TO BE LEARNED. `SendOutcome` keeps `dry-run` as a
   * separate member precisely because counting it as success is how the Gate 3
   * flow reported clean for months while delivering nothing — and this summary
   * then folded the two back together anyway, which made the cron route's
   * reply say `sent: 1` for an email that was never handed to Resend.
   *
   * That reply is the only view anybody has of this queue from outside the
   * database. A drain returning `dryRun: 1` says `RESEND_API_KEY` is missing in
   * that environment, in one number, instead of sending somebody to look for a
   * message Resend never received.
   */
  dryRun: number;
  skipped: number;
  failed: number;
};

/**
 * Sends every notification that is owed an email.
 *
 * Safe to call concurrently and safe to call often. Returns counts rather than
 * throwing, because its two callers — a cron route and a fire-and-forget call
 * after a server action — both want to carry on regardless.
 */
export async function dispatchPendingEmails(limit = 50): Promise<DispatchSummary> {
  const supabase = createAdminClient();
  const summary: DispatchSummary = { claimed: 0, sent: 0, dryRun: 0, skipped: 0, failed: 0 };

  const { data: pending, error } = await supabase
    .from("vizserve_pms_notifications")
    .select("id, user_id, type, title, body, link_path")
    .eq("send_email", true)
    .is("emailed_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error(`[email:dispatch] could not read the outbox: ${error.message}`);
    return summary;
  }

  for (const notification of pending ?? []) {
    // Claim first. `.is("emailed_at", null)` makes this a compare-and-set: a
    // second concurrent run matches zero rows and moves on, so an email is
    // never sent twice. The cost is that a crash between claiming and sending
    // loses one email — the right trade for a system where the inbox row is
    // already the source of truth and the email is only a nudge toward it.
    const { data: claimed } = await supabase
      .from("vizserve_pms_notifications")
      .update({ emailed_at: new Date().toISOString() })
      .eq("id", notification.id)
      .is("emailed_at", null)
      .select("id");

    if (!claimed || claimed.length === 0) continue;
    summary.claimed += 1;

    const { data: recipient } = await supabase
      .from("vizserve_pms_users")
      .select("email, full_name, is_active")
      .eq("id", notification.user_id)
      .maybeSingle();

    if (!recipient?.is_active) {
      // A deactivated account keeps its inbox row and gets no mail. Leaving the
      // claim in place is deliberate: this will not become deliverable later.
      summary.skipped += 1;
      continue;
    }

    const presentation = PRESENTATION[notification.type];
    // P8-19. Two Records over the same generated union, so they go missing
    // together — checked together for the same reason, because a `From` of
    // `undefined` is a failed send rather than a skipped one.
    const sender = NOTIFICATION_EMAIL_SENDER[notification.type];

    /*
     * ⚠️ A TYPE NOBODY MAPPED. Unreachable while the union in
     * `lib/database.types.ts` is complete and this map is a Record over it —
     * but that union is GENERATED, `npm run db:types` needs Docker, and
     * `mentioned` sat in the database for four days without reaching it. The
     * next enum value will do the same.
     *
     * Skipped rather than sent blank, and the claim is left unwritten so the
     * email is still owed once somebody maps it.
     */
    if (!presentation || !sender) {
      console.error(`[email:dispatch] no presentation for type "${notification.type}"`);
      summary.skipped += 1;
      continue;
    }

    const firstName = recipient.full_name.trim().split(/\s+/)[0] || "there";

    const body: EmailBody = {
      preheader: notification.body || notification.title,
      heading: notification.title,
      // Undefined for most types, which renders no chip at all — see the note
      // on `status` in PRESENTATION above.
      status: presentation.status,
      paragraphs: [
        `Hi ${firstName},`,
        /*
         * ⚠️ FLATTENED. A `commented` notification carries the comment itself,
         * and comments are rich text since P7-56. `layout.ts` escapes every
         * value it interpolates, so markup would arrive as visible tags.
         *
         * A no-op for every other notification type, whose bodies are written
         * as plain sentences by SQL triggers — which is exactly why it goes
         * here, once, rather than at each of the eleven call sites that could
         * produce one.
         */
        richTextToPlainText(notification.body) || "There is an update waiting for you.",
      ],
      button: notification.link_path
        ? { label: presentation.action, path: notification.link_path }
        : undefined,
      footnote: "This is also in your VizServe Team Portal inbox.",
    };

    const outcome = await sendEmail({
      to: recipient.email,
      sender,
      subject: presentation.subject(notification.title),
      body,
    });

    if (outcome.status === "sent") {
      summary.sent += 1;
    } else if (outcome.status === "dry-run") {
      // Claimed and counted, but nothing left the building. Kept claimed rather
      // than retried: without a key it would be a dry run every time, and an
      // outbox that never drains in development is an outbox that grows for
      // months and then floods the day a key is added.
      summary.dryRun += 1;
    } else if (outcome.status === "skipped") {
      // Reserved domain — seeded accounts. Stays claimed so it is not retried
      // hourly forever.
      summary.skipped += 1;
    } else {
      summary.failed += 1;
      console.error(`[email:dispatch] ${notification.id}: ${outcome.error}`);
      // Release the claim so the next run retries. A transient Resend outage
      // must not silently drop the queue.
      await supabase
        .from("vizserve_pms_notifications")
        .update({ emailed_at: null })
        .eq("id", notification.id);
    }
  }

  return summary;
}

/**
 * Fire-and-forget drain, for calling at the end of a server action.
 *
 * Deliberately not awaited by callers and deliberately swallowing everything:
 * the cron route is the reliable path, and this is only there so a Team Leader
 * approving a request does not wait an hour for the PIC to be told.
 */
export function dispatchPendingEmailsInBackground(): void {
  void dispatchPendingEmails().catch((error) => {
    console.error("[email:dispatch] background drain failed:", error);
  });
}
