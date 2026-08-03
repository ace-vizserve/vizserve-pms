import { NextResponse } from "next/server";

import { dispatchPendingEmails } from "@/lib/email/dispatch";

/**
 * P0-11 — the reliable half of email delivery.
 *
 * Server actions kick a background drain so the common case is fast; this is
 * what guarantees the queue empties anyway when a process dies mid-action, when
 * Resend has a bad ten minutes, or when the notification was written inside
 * Postgres by the public submission function and no Node process was ever
 * involved.
 *
 * Scheduled in vercel.json. Phase 4's auto-complete job (P4-09) will sit
 * alongside it and share this authorization shape.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;

  // No secret configured means this endpoint is closed, not open. An unguarded
  // route here is a free way for anyone to drain and re-drain the outbox.
  if (!secret) return false;

  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    // 404 rather than 401: an unauthenticated caller learns nothing about
    // whether this path exists.
    return new NextResponse("Not found", { status: 404 });
  }

  const summary = await dispatchPendingEmails();

  return NextResponse.json({ ok: true, ...summary });
}
