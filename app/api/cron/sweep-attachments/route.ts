import { NextResponse } from "next/server";

import { ATTACHMENT_BUCKET } from "@/lib/attachments-server";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P1-09 — collecting abandoned uploads.
 *
 * Someone picks three files and closes the tab. The receipts and the objects
 * both outlive the intent, and a private bucket that only ever grows is a
 * storage bill nobody chose.
 *
 * Two steps in this order, and the order matters: the database delete returns
 * the paths, then the objects go. Reversed, a failure between them leaves a
 * receipt pointing at nothing — and a receipt is the one thing the submission
 * function trusts.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const admin = createAdminClient();

  // 24 hours. Generously longer than anyone spends filling in a form, and short
  // enough that a bot uploading all night is cleaned up by morning.
  const { data: expired, error } = await admin.rpc("vizserve_pms_expire_pending_attachments", {
    p_older_than: "24 hours",
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const paths = (expired ?? []).map((row) => row.storage_path);
  if (paths.length === 0) {
    return NextResponse.json({ ok: true, removed: 0 });
  }

  const { error: removeError } = await admin.storage.from(ATTACHMENT_BUCKET).remove(paths);

  // The receipts are already gone, so a storage failure leaves orphaned objects
  // rather than dangling receipts. Reported, not retried — the next sweep will
  // not see them again, so this needs a human if it recurs.
  if (removeError) {
    console.error(`[attachments:sweep] ${paths.length} objects left behind: ${removeError.message}`);
    return NextResponse.json({ ok: true, removed: 0, orphaned: paths.length });
  }

  return NextResponse.json({ ok: true, removed: paths.length });
}
