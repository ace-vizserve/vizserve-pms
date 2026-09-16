import { NextResponse } from "next/server";

import { signAttachmentUrl } from "@/lib/attachments-server";
import { createClient } from "@/utils/supabase/server";

/**
 * P7-67 — the bytes behind an `<img>` in a comment.
 *
 * ⚠️ THE READ IS THROUGH THE VIEWER'S OWN CLIENT, so RLS decides. The attachment
 * policy is "visible to whoever can see the task" (P3-13), and that is the
 * whole authorisation: a row the viewer may not see returns zero rows, which is
 * a 404 here. Reaching for the service role would turn every comment image into
 * an open file server for anyone with a session and a uuid.
 *
 * ⚠️ AND IT IS A REDIRECT TO A SIGNED URL, NOT A PROXY. Streaming the bytes
 * through the app would put every screenshot in a thread through a serverless
 * function; the redirect hands the browser a one-minute signature and the CDN
 * serves it. The signature is minted per request, which is what lets the body
 * store a stable `/api/task-images/<id>` for years — see `TASK_IMAGE_PATH` in
 * `lib/rich-text.ts` for why a stored signed URL cannot work.
 *
 * 302, not 307 or a cached 301: `Cache-Control: private, max-age=0` because the
 * target expires. A cached redirect is a broken image an hour later, and it
 * would be cached against the WRONG viewer.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const { attachmentId } = await params;

  const supabase = await createClient();

  const { data: attachment } = await supabase
    .from("vizserve_pms_task_attachments")
    .select("storage_path, mime_type")
    .eq("id", attachmentId)
    .maybeSingle();

  // 404 for out of scope, for gone, and for never-existed alike. Whether a file
  // exists is itself something the viewer has not earned the right to know.
  if (!attachment) return new NextResponse("Not found", { status: 404 });

  /*
   * ⚠️ IMAGES ONLY, whatever the row says it is. This route's URL is written
   * into a comment body as an `<img src>`, and the sanitiser keeps that `src`
   * because it matches the route — so without this check, a PDF or a .docx
   * uploaded as a task OUTPUT could be addressed through it too. It would not
   * render, but it would be a download endpoint that skipped the actions with
   * their own rules on `getTaskAttachmentUrl`.
   */
  if (!attachment.mime_type.startsWith("image/")) {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = await signAttachmentUrl(attachment.storage_path, 60);
  if (!url) return new NextResponse("Not found", { status: 404 });

  return NextResponse.redirect(url, {
    status: 302,
    headers: { "Cache-Control": "private, max-age=0, must-revalidate" },
  });
}
