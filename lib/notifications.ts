import type { VizservePmsNotificationType } from "@/lib/database.types";

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
  status_changed: "Status changes",
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
