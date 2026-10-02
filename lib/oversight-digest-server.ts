import "server-only";

import { NextResponse } from "next/server";

import { renderEmail, type EmailBody } from "@/lib/email/layout";
import { sendEmail } from "@/lib/email/send";
import type { EmailAttachment } from "@/lib/email/transports/types";
import type { createAdminClient } from "@/utils/supabase/admin";

/**
 * P15-08 — the morning attendance email's plumbing, kept apart from the
 * report itself: the cron gate, the roster, the recipients and the send loop.
 * (P15-07, a separate 7 AM leave email, was folded into it and removed.)
 *
 * ⚠️ EVERYTHING HERE READS THROUGH THE ADMIN CLIENT, because a cron has no
 * session. Each caller is responsible for applying by hand the visibility
 * rules RLS would have applied for it.
 */

type Admin = ReturnType<typeof createAdminClient>;

/** The same check every route under `/api/cron/` makes. Closed when unset. */
export function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export function cronFailure(tag: string, what: string, message: string) {
  console.error(`[${tag}] ${what}: ${message}`);
  return NextResponse.json({ ok: false, error: `${what}: ${message}` }, { status: 500 });
}

export type RosterPerson = {
  id: string;
  email: string;
  fullName: string;
  departmentName: string | null;
  workStart: string | null;
  workEnd: string | null;
  /** Holds the CEO or Business Manager role, or the Business Manager tick. */
  isOversight: boolean;
};

/**
 * Every active person with access to this app, with their department and
 * schedule, flagged when they should receive the oversight emails.
 *
 * HELD role, not acting role: somebody who is CEO but acting as Manager this
 * morning still runs the company. Plus the legacy Business Manager tick.
 */
export async function loadRoster(
  admin: Admin,
): Promise<{ people: RosterPerson[]; error: string | null }> {
  const [users, departments, roles] = await Promise.all([
    admin
      .from("vizserve_pms_users")
      .select("id, email, full_name, primary_department_id, work_start, work_end, is_business_manager, app_access")
      .eq("is_active", true)
      .order("full_name"),
    admin.from("vizserve_pms_departments").select("id, name"),
    admin.from("vizserve_pms_user_roles").select("user_id").in("role", ["owner", "business_manager"]),
  ]);

  const error = users.error ?? departments.error ?? roles.error;
  if (error) return { people: [], error: error.message };

  const departmentName = new Map((departments.data ?? []).map((row) => [row.id, row.name]));
  const oversight = new Set((roles.data ?? []).map((row) => row.user_id));

  const people = (users.data ?? [])
    // The `app_access` key is the literal repo name, never the product name.
    .filter((user) => (user.app_access ?? []).includes("vizserve-pms"))
    .map((user) => ({
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      departmentName: user.primary_department_id ? (departmentName.get(user.primary_department_id) ?? null) : null,
      workStart: user.work_start,
      workEnd: user.work_end,
      isOversight: oversight.has(user.id) || Boolean(user.is_business_manager),
    }));

  return { people, error: null };
}

/** One email to every oversight recipient. Never throws; counts the outcomes. */
export async function sendToOversight(
  tag: string,
  people: readonly RosterPerson[],
  subject: string,
  body: EmailBody,
  attachments?: EmailAttachment[],
) {
  const recipients = people.filter((person) => person.isOversight);
  const summary = { recipients: recipients.length, sent: 0, skipped: 0, failed: 0 };

  for (const recipient of recipients) {
    const outcome = await sendEmail({ to: recipient.email, sender: "notifications", subject, body, attachments });

    if (outcome.status === "sent") summary.sent += 1;
    else if (outcome.status === "failed") {
      summary.failed += 1;
      console.error(`[${tag}] ${recipient.id}: ${outcome.error}`);
    } else summary.skipped += 1;
  }

  return summary;
}

/**
 * `?preview=1` — the rendered email as the response, sent to nobody. For
 * looking at it in a browser or Postman's Preview tab. Still behind the cron
 * secret, because the page carries the whole company's attendance.
 */
export function previewResponse(subject: string, body: EmailBody): NextResponse {
  const { html } = renderEmail(body);
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Header values must be Latin-1; the subject's "·" and "—" are not.
      "x-email-subject": encodeURIComponent(subject),
      "cache-control": "no-store",
    },
  });
}
