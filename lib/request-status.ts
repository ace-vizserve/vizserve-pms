import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * P7-51 — the tracking token behind the public status page.
 *
 * ⚠️ THE RAW TOKEN IS STORED NOWHERE. `issueStatusToken` returns it once; the
 * database keeps only the SHA-256. That is the same rule P4's approval tokens
 * follow, and the reason is the same: a dump of `vizserve_pms_requests` should
 * yield nothing that can be replayed against the status endpoint.
 *
 * If a client loses the link there is no recovering it — a new one has to be
 * issued. That is the correct trade for a URL that grants read access with no
 * login behind it.
 */

/**
 * 32 bytes, base64url.
 *
 * `randomBytes`, not `randomUUID`. A v4 uuid carries 122 bits of entropy in a
 * recognisable shape, and a recognisable shape invites somebody to try
 * generating one. This is 256 bits with no structure to pattern-match, and
 * base64url means it survives being pasted into a URL, an email client's
 * autolinker and a chat app without escaping.
 */
export function generateStatusToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The only form that touches the database. */
export function hashStatusToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The link that goes in the email.
 *
 * ABSOLUTE, because it is read in a mail client where a relative path means
 * nothing. Falls back to localhost so a dev without `NEXT_PUBLIC_SITE_URL` set
 * still gets a clickable link rather than `undefined/status/...` — which looks
 * like a bug in the email rather than a missing environment variable.
 */
export function statusUrl(token: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/status/${token}`;
}

/** One entry in the trace. Mirrors what the SQL function builds. */
export type StatusTimelineEntry = {
  at: string;
  label: string;
  detail: string;
};

/** The shape `vizserve_pms_get_request_status` returns on success. */
export type RequestStatusPage = {
  ok: true;
  reference_no: string;
  title: string;
  requester_name: string;
  submitted_at: string;
  status: string;
  target_date: string | null;
  approved_target_date: string | null;
  timeline: StatusTimelineEntry[];
};

export type RequestStatusResult = RequestStatusPage | { ok: false; error: string };
