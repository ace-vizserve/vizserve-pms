import "server-only";

import { cache } from "react";

import { createClient } from "@/utils/supabase/server";

/**
 * P7-13 / P7-43 — the tasks the caller is on WITHOUT being named in
 * `assignee_id`.
 *
 * ONE DEFINITION, BECAUSE THERE ARE NOW FOUR CALLERS AND THEY DRIFTED. The
 * database answers "is this person on this task" with `vizserve_pms_is_on_task`,
 * which is `assignee_id = them OR qa_assignee_id = them OR a row in
 * `vizserve_pms_task_assignees``. Four screens have to ask the same question,
 * and a policy function cannot be called from a PostgREST filter — so each of
 * them spelled it out, and three of them spelled it wrong:
 *
 *   * the timesheet picker offered PIC-or-QA only, so a second assignee had
 *     nowhere to log the hours the database would have accepted
 *   * the task list and the board computed `isPic` from the column alone, so a
 *     second assignee saw a read-only page while the UPDATE policy — which goes
 *     through the helper — would have taken their edits
 *   * "Mine" filtered on the column alone, so work somebody was demonstrably
 *     doing did not appear in the view named after them
 *
 * This returns only the JOIN-TABLE half. Callers still test `assignee_id` and
 * `qa_assignee_id` themselves, because those two are columns on the rows they
 * are already fetching and a second query for them would be waste. What matters
 * is that the half nobody remembered lives in one place.
 *
 * `cache()`d per request: the tasks page needs it for `seat()` AND for the Mine
 * filter, and both run in the same render.
 *
 * ⚠️ RETURNS AN EMPTY ARRAY ON FAILURE rather than throwing. Every caller uses
 * it to WIDEN a set — the tasks they can already reach through `assignee_id`.
 * Degrading to "no extra tasks" shows somebody less than they should see; a
 * throw takes out the whole board. The first is a bug report, the second is an
 * outage.
 */
export const fetchJoinedTaskIds = cache(async (userId: string): Promise<string[]> => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("vizserve_pms_task_assignees")
    .select("task_id")
    .eq("user_id", userId);

  if (error) return [];

  return (data ?? []).map((row) => row.task_id);
});

/**
 * The same set as a `Set`, for the per-row membership tests that `seat()` and
 * its equivalents do once per task on screen.
 */
export const fetchJoinedTaskIdSet = cache(async (userId: string): Promise<Set<string>> => {
  return new Set(await fetchJoinedTaskIds(userId));
});

/**
 * The PostgREST `or(...)` fragment that widens a task query to "mine".
 *
 * P7-43: on an INTERNAL task there is no person in charge, so being on it at all
 * makes it yours. On a CLIENT task the accountable name is still the answer to
 * "whose is this" — somebody has to be answerable to the person who filed the
 * request — so membership alone does not put it in your Mine.
 *
 * Returned as a string because that is the only shape PostgREST's `.or()`
 * takes. `id.in.()` with an empty list is a syntax error rather than an empty
 * set, so the clause is omitted entirely when there is nothing to add.
 */
export function mineFilter(userId: string, joinedTaskIds: string[]): string {
  const clauses = [`assignee_id.eq.${userId}`];

  if (joinedTaskIds.length > 0) {
    clauses.push(`and(request_id.is.null,id.in.(${joinedTaskIds.join(",")}))`);
  }

  return clauses.join(",");
}
