"use server";

import { revalidatePath } from "next/cache";

import { requireAuthContext } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";

/**
 * Mark ONE notification read.
 *
 * ⚠️ THIS EXISTED NOWHERE UNTIL NOW, AND ITS ABSENCE WAS THE BUG. Opening a
 * notification navigated to the record and left the row unread, so the only way
 * to clear the badge was "Mark all read" — a bulk action for a per-item job.
 * People either lived with a permanent count or wiped rows they had not looked
 * at, and both make the badge stop meaning anything.
 *
 * ⚠️ NO `.eq("user_id", …)`, deliberately. The "notifications update own" policy
 * is `user_id = auth.uid()`, so this cannot touch somebody else's row — and
 * restating the filter here would imply the policy were optional, which is the
 * rule this codebase enforces everywhere else. An id belonging to another
 * person matches zero rows rather than erroring, which is the right answer:
 * whether that notification exists is not this caller's business.
 *
 * ⚠️ AND IT ONLY EVER SETS `read_at` WHERE IT IS NULL. Re-opening something you
 * read last week must not move its timestamp — the column records when you
 * first saw it, and an inbox that quietly restamps rows would make "read on
 * Tuesday" unanswerable.
 */
export async function markNotificationRead(id: string): Promise<void> {
  await requireAuthContext();

  const supabase = await createClient();

  await supabase
    .from("vizserve_pms_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);

  /*
   * BOTH, and the second is the one that is easy to forget. `/inbox` re-renders
   * the row and its dot; the LAYOUT holds the unread badge in the sidebar,
   * which is on every page — so without the second call somebody who clicks a
   * notification watches the row go read while the rail still claims one
   * unread, until they navigate somewhere unrelated.
   */
  revalidatePath("/inbox");
  revalidatePath("/", "layout");
}
