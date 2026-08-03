import { NextResponse } from "next/server";

import { signAttachmentUrl } from "@/lib/attachments-server";
import { approvalPageResultSchema } from "@/lib/schemas/client-approval";
import { createClient } from "@/utils/supabase/server";

/**
 * P4-04 — a client downloading an output file, with no session.
 *
 * THE TOKEN AUTHORISES THE FILE. The route re-reads the approval page for this
 * token and will only sign an attachment that the page itself listed — so a
 * valid token for task A cannot fetch a file belonging to task B by swapping the
 * id in the URL.
 *
 * Doing it the obvious way — look up the attachment, sign it — would be an open
 * file server for anyone holding any token at all. The check is not "is this
 * token valid" but "does this token's own page include this file".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; attachmentId: string }> },
) {
  const { token, attachmentId } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("vizserve_pms_get_approval_page", {
    p_token: token,
  });

  if (error || !data) return new NextResponse("Not found", { status: 404 });

  const parsed = approvalPageResultSchema.safeParse(data);

  // 404 for every failure — an invalid token, an expired one, and a file that
  // belongs to somebody else all look identical from outside.
  if (!parsed.success || parsed.data.ok === false) {
    return new NextResponse("Not found", { status: 404 });
  }

  const attachment = parsed.data.attachments.find((file) => file.id === attachmentId);
  if (!attachment) return new NextResponse("Not found", { status: 404 });

  const { data: row } = await supabase
    .from("vizserve_pms_task_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  // Read through the service role deliberately: `anon` has no table privilege,
  // and authority for this read came from the token check above, not from RLS.
  const path = row?.storage_path ?? (await lookupPath(attachmentId));
  if (!path) return new NextResponse("Not found", { status: 404 });

  const url = await signAttachmentUrl(path, 120);
  if (!url) return new NextResponse("Not found", { status: 404 });

  return NextResponse.redirect(url);
}

async function lookupPath(attachmentId: string): Promise<string | null> {
  const { createAdminClient } = await import("@/utils/supabase/admin");

  const { data } = await createAdminClient()
    .from("vizserve_pms_task_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  return data?.storage_path ?? null;
}
