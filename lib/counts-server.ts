import "server-only";

import { cache } from "react";

import { createClient } from "@/utils/supabase/server";

/**
 * The small counts several screens ask for at once.
 *
 * WHY THIS FILE EXISTS. Four separate pages each wrote out
 * `select("id", { count: "exact", head: true })` against
 * `vizserve_pms_notifications` with `.is("read_at", null)` — character for
 * character the same query, four times. Two more pairs did the same for "my
 * open tasks" and "on my QA". They are the numbers a person sees on two screens
 * they flip between, so the moment one of them grows a filter the other one
 * disagrees and there is no way to tell which is right.
 *
 * This is the pattern `lib/approvals-queue-server.ts` already established after
 * the two dashboards disagreed about "Waiting on you" — see its header. The
 * lesson was applied to that one queue and not to the four counts beside it.
 *
 * ⚠️ `cache()`d, AND THAT IS HALF THE POINT. `sidebar-panel.tsx` renders on
 * EVERY page, so the unread badge ran alongside the dashboard's own copy and
 * the inbox's own copy — two identical aggregates in one render. `cache()`
 * collapses them into one round trip per request. It does NOT cache across
 * requests, which is what keeps this safe: every count here is RLS-scoped to
 * `auth.uid()`, and `use cache` on one of these would serve one person's number
 * to somebody else. See the rule at the top of `next.config.ts`.
 *
 * ⚠️ NO USER FILTER ON THE NOTIFICATION COUNT, deliberately. RLS scopes
 * `vizserve_pms_notifications` to the caller; restating it in the query would
 * imply the policy is optional.
 *
 * Every function here degrades to 0 rather than throwing. These are badges and
 * tiles beside the thing they describe — a failed count should cost the badge,
 * never the page. The queue reads in `approvals-queue-server.ts` draw the line
 * the other way for lists somebody works off, and that difference is deliberate.
 */

/** The two statuses that mean the work is finished, as PostgREST wants them. */
const TERMINAL_FILTER = "(COMPLETED,COMPLETED_NO_RESPONSE)";

/** The QA queue's two stages. */
const QA_STAGES = ["FOR_QA", "QA_IN_PROGRESS"] as const;

/** Notifications the reader has not opened. Drives the inbox badge everywhere. */
export const countUnreadNotifications = cache(async (): Promise<number> => {
  const supabase = await createClient();

  const { count } = await supabase
    .from("vizserve_pms_notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);

  return count ?? 0;
});

/**
 * Open tasks with somebody's name on them as the accountable person.
 *
 * ⚠️ `assignee_id`, NOT `is_mine`. This is the PIC count both dashboards have
 * always shown; `MINE_COLUMN` is the wider "on the task at all" rule the Mine
 * FILTER uses. They are different questions and swapping one for the other here
 * would silently change a number on two screens.
 */
export const countMyOpenTasks = cache(async (userId: string): Promise<number> => {
  const supabase = await createClient();

  const { count } = await supabase
    .from("vizserve_pms_tasks")
    .select("id", { count: "exact", head: true })
    .eq("assignee_id", userId)
    .not("status", "in", TERMINAL_FILTER);

  return count ?? 0;
});

/** Tasks sitting in one of the two QA stages with this person as the reviewer. */
export const countMyQaQueue = cache(async (userId: string): Promise<number> => {
  const supabase = await createClient();

  const { count } = await supabase
    .from("vizserve_pms_tasks")
    .select("id", { count: "exact", head: true })
    .eq("qa_assignee_id", userId)
    .in("status", QA_STAGES);

  return count ?? 0;
});

/**
 * How much live work each list is carrying, keyed by `list_id`.
 *
 * ⚠️ TWO CALLERS THAT ARE ALWAYS ON SCREEN TOGETHER. `/tasks/lists` shows this
 * as a column and `sidebar-panel.tsx` shows it as a rail badge — the same number
 * in two places, on the same page. They were the same query AND the same reduce
 * loop, written out twice, and the sidebar's own comment records that the pair
 * had already drifted once on ordering. `cache()` also means opening
 * `/tasks/lists` now costs one read for both rather than two.
 *
 * LIVE WORK ONLY. A count including everything ever finished would grow forever
 * and stop meaning "how much is in here".
 *
 * Counted in TypeScript rather than through a PostgREST aggregate because the
 * two callers want a lookup by id, and a `group by` would still have to be
 * reshaped into one here.
 */
export const countOpenTasksByList = cache(async (): Promise<Map<string, number>> => {
  const supabase = await createClient();

  const { data } = await supabase
    .from("vizserve_pms_tasks")
    .select("list_id")
    .not("list_id", "is", null)
    .not("status", "in", TERMINAL_FILTER);

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    if (!row.list_id) continue;
    counts.set(row.list_id, (counts.get(row.list_id) ?? 0) + 1);
  }

  return counts;
});
