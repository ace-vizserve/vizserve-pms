import { NextResponse } from "next/server";

import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P17-05 — the error log keeps 30 days.
 *
 * An error log is for fixing things now; a month is long enough to see whether
 * a fix held. Unlike the audit trail — which is a record and is never pruned —
 * nothing here is evidence of anything somebody did.
 */

export const maxDuration = 60;

const KEEP_DAYS = 30;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await createAdminClient()
    .from("vizserve_pms_error_logs")
    .delete({ count: "exact" })
    .lt("occurred_at", cutoff);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: count ?? 0 });
}
