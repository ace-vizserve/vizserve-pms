import "server-only";

import { removeStoredAttachments } from "@/lib/attachments-server";
import { taskImageIds } from "@/lib/rich-text";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P7-67 — collecting the pictures a comment no longer has.
 *
 * THE PROBLEM. An image in a comment is committed the moment it is pasted —
 * there is no receipt handshake on a staff upload, and the alternative is a
 * comment box that cannot show you the picture until you press Send. So the
 * bytes and the attachment row exist before anything references them, and the
 * body is the ONLY thing that ever will. Take the image back out of the comment
 * and the row is unreachable: it is not in the Files panel (that query excludes
 * `kind = 'comment'`), it is not in the thread, and nothing sweeps it.
 *
 * ⚠️ IT IS DRIVEN BY THE OLD BODY, NOT BY A SCAN OF THE TASK. The caller passes
 * what the comment used to reference; this deletes the ones that are now
 * referenced by no comment on that task. A scan-everything version would be
 * simpler and would delete every image sitting in somebody's UNSENT DRAFT on
 * the same task, because a draft references nothing — the draft is exactly the
 * case a sweep cannot see and must not touch. The age-based cron is where that
 * case belongs, and it needs its own long grace period for the same reason.
 *
 * ⚠️ SERVICE ROLE, AFTER THE CALLER'S OWN WRITE HAS ALREADY BEEN AUTHORISED.
 * Both call sites reach here only once RLS has let them edit or delete the
 * comment, which is the permission that matters — `author_id = auth.uid()`.
 * Doing the cleanup through the user's client instead would fail on the one
 * case that motivated it: the attachment DELETE policy is "your own upload, or
 * you lead the department", which is not the same set of people, so a lead who
 * cannot delete an upload could edit a comment and silently leave the file.
 *
 * ⚠️ NOTHING HERE IS FATAL. It runs after the write it cleans up for, and a
 * comment that saved correctly must not report failure because a file could not
 * be removed. Every failure below is logged and swallowed; the worst outcome is
 * an orphan, which is what this function exists to reduce, not a promise it
 * makes.
 */
export async function sweepCommentImages(input: {
  taskId: string;
  /** The body as it was BEFORE the edit or delete. */
  previousBody: string | null | undefined;
  /** The body as it is now. Omit for a deleted comment. */
  nextBody?: string | null;
}): Promise<void> {
  const { taskId, previousBody, nextBody } = input;

  const before = taskImageIds(previousBody);
  if (before.length === 0) return;

  const after = new Set(taskImageIds(nextBody));
  const dropped = before.filter((id) => !after.has(id));
  if (dropped.length === 0) return;

  const admin = createAdminClient();

  /*
   * ⚠️ THE SAME PICTURE CAN BE IN TWO COMMENTS. Somebody quotes a screenshot in
   * a reply, or pastes the same file twice; both bodies carry the same
   * attachment id, and deleting on the strength of one comment losing it would
   * break the other. `like` over the remaining bodies is the check — crude, and
   * correct in the direction that matters: a false match keeps a file that
   * could have gone, a missed one deletes a picture somebody can still see.
   */
  const { data: remaining, error: readError } = await admin
    .from("vizserve_pms_task_comments")
    .select("body")
    .eq("task_id", taskId);

  if (readError) {
    console.error(`[comment-images] could not read bodies for ${taskId}: ${readError.message}`);
    return;
  }

  const stillUsed = new Set((remaining ?? []).flatMap((row) => taskImageIds(row.body)));
  const orphaned = dropped.filter((id) => !stillUsed.has(id));
  if (orphaned.length === 0) return;

  /*
   * Scoped to this task AND to `kind = 'comment'`, so a bug in the extractor
   * above cannot reach a task output or a client's reference file. The row goes
   * first and returns the path; the object goes second — reversed, a failure
   * between them would leave a row pointing at nothing, and of the two only
   * that one is visible to anybody.
   */
  const { data: deleted, error: deleteError } = await admin
    .from("vizserve_pms_task_attachments")
    .delete()
    .eq("task_id", taskId)
    .eq("kind", "comment")
    .in("id", orphaned)
    .select("storage_path");

  if (deleteError) {
    console.error(`[comment-images] ${orphaned.length} rows left behind: ${deleteError.message}`);
    return;
  }

  await removeStoredAttachments((deleted ?? []).map((row) => row.storage_path));
}
