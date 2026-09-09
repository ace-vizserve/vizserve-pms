"use server";

import { revalidatePath } from "next/cache";

import { readableError, type ActionResult } from "@/lib/action-result";
import { requireAuthContext } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";

/**
 * ⚠️ P12-17 — BOTH ACTIONS RETURN AN `ActionResult` NOW, AND ONE OF THEM DID
 * NOT EXIST AS AN ACTION AT ALL.
 *
 * `markNotificationRead` returned `void` and never destructured `error`, so a
 * refused or failed update was completely silent: the optimistic value stayed
 * on screen, the row looked read, and the badge in the rail disagreed with it
 * until the next navigation. Under `useMutation` the envelope is what drives
 * `onError`, which is what puts the row BACK — so the return type is not
 * bookkeeping, it is the rollback's trigger.
 *
 * "Mark all read" used to be an inline `"use server"` closure inside
 * `app/(app)/inbox/page.tsx`, passed down to the table as a prop. It moved here
 * when the page stopped being the thing that reads the rows: a client view
 * cannot declare one, and a prop-passed action is one more indirection between
 * a button and what it does.
 *
 * ⚠️ THE `revalidatePath` CALLS STAY, AND THEY ARE NOT REDUNDANT WITH THE CACHE.
 * `/inbox` itself is now a client view reading from TanStack, so the first call
 * moves nothing there — but the LAYOUT still server-renders the rail, and
 * `sidebar-snapshot.tsx` turns a changed `serverRenderedAt` into an invalidation
 * for every domain that has not been converted. Dropping them would be a Phase 6
 * cleanup, taken with the rest; see the note in that file for the condition.
 */

/**
 * Mark ONE notification read.
 *
 * ⚠️ THIS EXISTED NOWHERE UNTIL P11-05, AND ITS ABSENCE WAS THE BUG. Opening a
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
export async function markNotificationRead(id: string): Promise<ActionResult<null>> {
  await requireAuthContext();

  const supabase = await createClient();

  const { error } = await supabase
    .from("vizserve_pms_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);

  if (error) return { ok: false, error: readableError(error) };

  /*
   * BOTH, and the second is the one that is easy to forget. `/inbox` re-renders
   * the row and its dot; the LAYOUT holds the unread badge in the sidebar,
   * which is on every page — so without the second call somebody who clicks a
   * notification watches the row go read while the rail still claims one
   * unread, until they navigate somewhere unrelated.
   */
  revalidatePath("/inbox");
  revalidatePath("/", "layout");

  return { ok: true, data: null };
}

/**
 * Mark EVERY unread notification read.
 *
 * ⚠️ DELIBERATELY NOT LIMITED TO THE CURRENT PAGE OR THE CURRENT SEARCH. The
 * button says "all", and a Mark-all-read that leaves unread rows behind the
 * paginator is the kind of thing people stop trusting. The table withholds the
 * button entirely while a search is active, which is the other half of the same
 * rule: clearing rows somebody cannot see is not a thing to offer.
 *
 * No `.eq("user_id", …)`: RLS already scopes the update to the caller's own
 * rows, and restating it here would imply the policy is optional.
 */
export async function markAllNotificationsRead(): Promise<ActionResult<null>> {
  await requireAuthContext();

  const supabase = await createClient();

  const { error } = await supabase
    .from("vizserve_pms_notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);

  if (error) return { ok: false, error: readableError(error) };

  revalidatePath("/inbox");
  revalidatePath("/", "layout");

  return { ok: true, data: null };
}
