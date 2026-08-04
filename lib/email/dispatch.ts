import "server-only";

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
  { subject: (title: string) => string; action: string }
> = {
  pending_approval: {
    subject: (title) => `Approval needed — ${title}`,
    action: "Review the request",
  },
  assigned: {
    subject: (title) => `Assigned to you — ${title}`,
    action: "Open the task",
  },
  qa_requested: {
    subject: (title) => `Ready for your QA — ${title}`,
    action: "Open QA",
  },
  client_decision: {
    subject: (title) => `Client decision — ${title}`,
    action: "Open the task",
  },
  status_changed: {
    subject: (title) => title,
    action: "Open in VizServe PMS",
  },
  // Ships email-off (P5-05 seeds send_email = false) — the requester is staff
  // with an inbox, and docs/12 reserves email for people who have no other
  // channel. Mapped regardless, because the switch is flippable at runtime
  // without a deploy and an unmapped type would then send a blank email.
  internal_decision: {
    subject: (title) => `Your request — ${title}`,
    action: "Open the request",
  },
};

export type DispatchSummary = {
  claimed: number;
  sent: number;
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
  const summary: DispatchSummary = { claimed: 0, sent: 0, skipped: 0, failed: 0 };

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
    const firstName = recipient.full_name.trim().split(/\s+/)[0] || "there";

    const body: EmailBody = {
      preheader: notification.body || notification.title,
      heading: notification.title,
      paragraphs: [`Hi ${firstName},`, notification.body || "There is an update waiting for you."],
      button: notification.link_path
        ? { label: presentation.action, path: notification.link_path }
        : undefined,
      footnote: "This is also in your VizServe PMS inbox.",
    };

    const outcome = await sendEmail({
      to: recipient.email,
      subject: presentation.subject(notification.title),
      body,
    });

    if (outcome.status === "sent" || outcome.status === "dry-run") {
      summary.sent += 1;
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
