import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * "Waiting on you" — the one definition of an approver's queue.
 *
 * THERE ARE THREE QUEUES, NOT ONE, and forgetting that is a bug this app has
 * already shipped twice. `/dashboard` counted `vizserve_pms_requests` alone and
 * had done since P0-08, when client Gate 1 was the only thing anybody approved.
 * It has not been the only one since P5 added internal requests (leave,
 * reimbursement, the two corrections, and now OVERTIME) or since P7-05 added
 * submitted timesheet weeks — so a lead with four leave requests and three
 * handed-in weeks and no client work read "Pending approvals: 0".
 *
 * A zero is not a soft failure on a landing page. It does not say "nothing has
 * loaded", it says THERE IS NOTHING TO DO, and people act on it by closing the
 * tab.
 *
 * It lives here rather than in a page because it was written inline twice and
 * the copies had already diverged. A rule that decides whether somebody sees
 * their work gets one home.
 *
 * NO DEPARTMENT FILTER on any of the three. All three tables scope by policy
 * through `vizserve_pms_manages_department`; restating it here would imply the
 * policy is optional.
 */
export type WaitingOnYou = {
  /** Client requests at Gate 1. */
  client: number;
  /** Leave, reimbursement, corrections, overtime — excluding the caller's own. */
  internal: number;
  /** Timesheet weeks handed in — excluding the caller's own. */
  weeks: number;
  total: number;
  /** `"2 client · 4 internal · 3 weeks"`, omitting the empty ones. */
  breakdown: string;
};

const EMPTY: WaitingOnYou = {
  client: 0,
  internal: 0,
  weeks: 0,
  total: 0,
  breakdown: "",
};

export async function countWaitingOnYou(
  supabase: SupabaseClient<Database>,
  userId: string,
  isApprover: boolean,
): Promise<WaitingOnYou> {
  // A member approves nothing. Returning zeroes rather than skipping the call
  // at every call site keeps the "is this person an approver" test in one place
  // too.
  if (!isApprover) return EMPTY;

  const [client, internal, weeks] = await Promise.all([
    supabase
      .from("vizserve_pms_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "PENDING_REVIEW"),

    // Excluding their own, mirroring the approvals list: a lead files leave
    // like everybody else, and `vizserve_pms_decide_internal_request` refuses a
    // self-decision. Counting it would put a number here that cannot be worked
    // off.
    supabase
      .from("vizserve_pms_internal_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "PENDING_REVIEW")
      .neq("requester_id", userId),

    // SUBMITTED only. RETURNED is back with the member and APPROVED is
    // finished — the same three-way split `vizserve_pms_timesheet_week_locked`
    // reads, and the reason RETURNED is absent from both lists.
    supabase
      .from("vizserve_pms_timesheet_weeks")
      .select("id", { count: "exact", head: true })
      .eq("status", "SUBMITTED")
      .neq("user_id", userId),
  ]);

  const counts = {
    client: client.count ?? 0,
    internal: internal.count ?? 0,
    weeks: weeks.count ?? 0,
  };

  return {
    ...counts,
    total: counts.client + counts.internal + counts.weeks,
    // Only the live ones. "2 client · 0 internal · 0 weeks" spends three
    // quarters of the line saying nothing.
    breakdown: (
      [
        [counts.client, "client"],
        [counts.internal, "internal"],
        [counts.weeks, "weeks"],
      ] as const
    )
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(" · "),
  };
}
