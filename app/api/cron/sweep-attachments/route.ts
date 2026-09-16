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

// P11-05. `export const dynamic` is incompatible with cacheComponents and is
// redundant under it: a route handler that reads a request header is dynamic
// by construction. `isAuthorized` below reads `Authorization` on every call.
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

  const images = await sweepCommentImages(admin);

  return NextResponse.json({ ok: true, removed: paths.length, commentImages: images });
}

/**
 * P7-67 — the images pasted into a comment nobody sent.
 *
 * ⚠️ A SECOND SWEEP IN THE SAME ROUTE, NOT A SECOND CRON. Both collect uploads
 * that outlived the intention behind them, both run daily, and both are two
 * steps in the same order — rows first, then the objects the rows named. A
 * separate schedule would be a second thing to notice had stopped running.
 *
 * ⚠️ IT IS NOT THE SAME AS `sweepCommentImages` IN `lib/comment-images-server.ts`,
 * which handles an image REMOVED from a comment that was saved. That one is
 * driven by the old body and is exact; this one is driven by age, because a
 * draft nobody sent has no body to be driven by. Neither can do the other's job.
 *
 * A failure here must not fail the route: the pending sweep above has already
 * succeeded by this point, and reporting the whole run as broken would hide
 * that.
 */
async function sweepCommentImages(admin: ReturnType<typeof createAdminClient>): Promise<number> {
  const { data: expired, error } = await admin.rpc("vizserve_pms_expire_comment_images", {
    p_older_than: "24 hours",
  });

  if (error) {
    console.error(`[attachments:sweep] comment images: ${error.message}`);
    return 0;
  }

  const paths = (expired ?? []).map((row) => row.storage_path);
  if (paths.length === 0) return 0;

  const { error: removeError } = await admin.storage.from(ATTACHMENT_BUCKET).remove(paths);

  if (removeError) {
    console.error(
      `[attachments:sweep] ${paths.length} comment images left behind: ${removeError.message}`,
    );
    return 0;
  }

  return paths.length;
}
