import type { VizservePmsNotificationType } from "@/lib/database.types";
/*
 * TYPE-ONLY, AND IT HAS TO STAY THAT WAY. `lib/email/config.ts` opens with
 * `import "server-only"`, and this module is reached from client components —
 * the inbox filter and P8-19's settings form. `import type` is erased before
 * the bundler sees it, so nothing server-only is pulled across; a value import
 * from that file would break the build on the next client screen that labels a
 * notification.
 */
import type { EmailSender } from "@/lib/email/config";

/**
 * Presentation for notification types, and the guard that keeps a URL param
 * from reaching the database as an enum value.
 *
 * The enum itself lives in Postgres (P0-10, extended by P5-05). This mirror
 * exists so the inbox filter can label the types and validate `?type=` without
 * every screen inventing its own wording.
 */

export const NOTIFICATION_TYPES = [
  "pending_approval",
  "assigned",
  "qa_requested",
  "client_decision",
  "internal_decision",
  "commented",
  "mentioned",
  "status_changed",
] as const;

/**
 * Reader-facing labels. Deliberately phrased from the recipient's point of
 * view — "Assigned to you", not "Assignment" — because the filter sits next to
 * a list of things that happened TO the person reading it.
 */
export const NOTIFICATION_TYPE_LABELS: Record<VizservePmsNotificationType, string> = {
  pending_approval: "Needs your approval",
  assigned: "Assigned to you",
  qa_requested: "Your QA",
  client_decision: "Client decision",
  internal_decision: "Your requests",
  commented: "Comments",
  // Its own filter rather than a kind of "Comments": the whole reason a mention
  // exists as a separate type is that it is addressed to the reader, and the
  // list this sits beside is things that happened TO them.
  mentioned: "Mentions",
  status_changed: "Status changes",
};

/**
 * P8-19 — what each type actually fires on, in the words of somebody deciding
 * whether it is worth an inbox.
 *
 * ⚠️ NOT THE `description` COLUMN ON `vizserve_pms_notification_type_settings`,
 * and that is deliberate rather than an oversight. Those strings are written
 * for whoever opens the migration — "Inbox only -- see the note in
 * 20260917090100" — and a settings screen that prints a filename at an owner is
 * a settings screen that gets ignored. The column stays as the note to the next
 * engineer; this is the note to the person holding the switch.
 */
export const NOTIFICATION_TYPE_HINTS: Record<VizservePmsNotificationType, string> = {
  pending_approval: "A request has reached a gate you are the approver on.",
  assigned: "A task became yours as PIC.",
  qa_requested: "A task you are QA on reached FOR_QA.",
  client_decision: "A client approved, rejected, or ran out of time to answer.",
  internal_decision: "An internal request you raised was approved or rejected.",
  commented: "Somebody commented on a task you are PIC or QA on.",
  mentioned: "Somebody typed your name with @ in a comment.",
  status_changed: "A record you are on moved from one status to another.",
};

/**
 * P8-15 / P8-19 — WHICH MAILBOX A TYPE SENDS FROM, and the single place that
 * decides it.
 *
 * It lived inside `PRESENTATION` in `lib/email/dispatch.ts` until the settings
 * screen needed to say "this sends from approvals@" next to the switch. That
 * file is `server-only`, so the choice moved here rather than being copied —
 * §7 of the design system bans the second copy of a map for a reason, and this
 * repo has already watched five of them drift.
 *
 * The rule is `approvals@` for anything sitting on one of the three gates, read
 * off the lifecycle rather than the word in the type name: Gate 1 is
 * `pending_approval`, Gate 2 is `qa_requested`, Gate 3 comes back as
 * `client_decision`, and Phase 5's internal outcome is the same engine. A
 * colleague who mutes `notifications@` because the comment traffic is noisy
 * must not thereby mute the queue they are the bottleneck on.
 *
 * Everything else is `notifications@` — ambient traffic, nothing being decided.
 * A mention is addressed to you, which is why it emails at all, but it still
 * decides nothing.
 */
export const NOTIFICATION_EMAIL_SENDER: Record<VizservePmsNotificationType, EmailSender> = {
  pending_approval: "approvals",
  qa_requested: "approvals",
  client_decision: "approvals",
  internal_decision: "approvals",
  assigned: "notifications",
  status_changed: "notifications",
  mentioned: "notifications",
  commented: "notifications",
};

/**
 * Narrows an untrusted `?type=` value.
 *
 * Postgres rejects an unknown enum value with `invalid input value for enum`,
 * which surfaces as a 500-ish error page rather than "no such filter". Checking
 * here turns a hand-edited URL into a silently ignored filter instead.
 */
export function isNotificationType(value: unknown): value is VizservePmsNotificationType {
  return typeof value === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** The read/unread filter. `all` is the absence of the param. */
export const READ_FILTERS = ["all", "unread", "read"] as const;
export type ReadFilter = (typeof READ_FILTERS)[number];

export function isReadFilter(value: unknown): value is ReadFilter {
  return typeof value === "string" && (READ_FILTERS as readonly string[]).includes(value);
}

/**
 * Badge text for an unread count.
 *
 * Capped, because the count is genuinely unbounded — a real inbox here is
 * already past 1,600 — and a four-digit number does not fit a sidebar badge
 * without pushing the label off its own row.
 */
// `formatUnreadBadge` moved to lib/navigation.ts as `formatNavBadge` when
// P7-50 gave Requests a badge too. It was never about notifications — it is
// the rule for every count in the sidebar, and a second copy under a second
// name is how two badges start disagreeing about what "99+" means.
