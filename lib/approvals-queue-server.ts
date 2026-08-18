import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";
import {
  INTERNAL_REQUEST_LABELS,
  describeLeaveSpan,
} from "@/lib/schemas/internal-requests";

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

/**
 * The same three queues as ROWS, not counts.
 *
 * A count tells a lead there are seven things without telling them what any of
 * them are, and the only way to find out is to open Approvals — which is the
 * click the tile was supposed to save. Both `/` and `/dashboard` need the rows,
 * and both had grown their own copy of this mapping: `/` built it inline across
 * three query results and forty lines, and slice I was about to write a second.
 * That is exactly the divergence the counting half of this file was extracted to
 * stop, so the listing half lives here too.
 *
 * ONE QUERY MORE THAN THE COUNTS NEED: the names. A row saying "a colleague
 * filed leave" is a row nobody can act on, and the requester id is a uuid. The
 * users select is policy-scoped like everything else.
 *
 * `since` is a DATE STRING, not a formatted phrase. Callers render it — `/` wants
 * "3 days ago" and the dashboard wants the same, but a module that returns prose
 * has decided the tense for every future caller.
 */
export type WaitingRow = {
  /** Unique across the three sources — the queue prefix is part of it. */
  id: string;
  /** Which queue, in the words that queue uses. Goes on the chip. */
  kind: string;
  tone: "info" | "warning" | "brand" | "neutral";
  title: string;
  /** Who is waiting. Always a name where one exists. */
  who: string;
  /** `YYYY-MM-DD` — when it started waiting. */
  since: string;
  href: string;
};

export async function listWaitingOnYou(
  supabase: SupabaseClient<Database>,
  userId: string,
  isApprover: boolean,
  /** Per queue, not in total. Five each is enough to fill any list that shows them. */
  perQueue = 5,
): Promise<WaitingRow[]> {
  if (!isApprover) return [];

  const [client, internal, weeks, people] = await Promise.all([
    supabase
      .from("vizserve_pms_requests")
      .select("id, reference_no, title, requester_org, submitted_at")
      .eq("status", "PENDING_REVIEW")
      // Oldest first, everywhere. A queue read newest-first is a queue whose
      // bottom nobody reaches, and the bottom is the part that has been waiting.
      .order("submitted_at", { ascending: true })
      .limit(perQueue),

    supabase
      .from("vizserve_pms_internal_requests")
      .select(
        "id, request_type, requester_id, created_at, start_date, end_date, work_date, start_half, end_half",
      )
      .eq("status", "PENDING_REVIEW")
      .neq("requester_id", userId)
      .order("created_at", { ascending: true })
      .limit(perQueue),

    supabase
      .from("vizserve_pms_timesheet_weeks")
      .select("id, user_id, week_start, submitted_at")
      .eq("status", "SUBMITTED")
      .neq("user_id", userId)
      .order("week_start", { ascending: true })
      .limit(perQueue),

    supabase.from("vizserve_pms_users").select("id, full_name"),
  ]);

  const nameOf = new Map((people.data ?? []).map((row) => [row.id, row.full_name]));

  /**
   * A leave span, a one-day span, or a correction's single day.
   *
   * Formatted here, unlike `since`. The distinction is that this IS the row's
   * title — the only thing naming which request it is — whereas `since` is
   * relative prose whose tense belongs to the caller.
   */
  const when = (row: {
    start_date: string | null;
    end_date: string | null;
    work_date: string | null;
    start_half?: "MORNING" | "AFTERNOON" | null;
    end_half?: "MORNING" | "AFTERNOON" | null;
  }): string => {
    if (row.start_date && row.end_date) {
      // P7-16, through the shared description so a half day reads the same here
      // as it does on the request itself.
      return describeLeaveSpan(
        row.start_date,
        row.end_date,
        row.start_half ?? null,
        row.end_half ?? null,
        formatDate,
      );
    }
    return formatDate(row.work_date);
  };

  return [
    ...(client.data ?? []).map((request) => ({
      id: `req-${request.id}`,
      kind: "Client",
      tone: "brand" as const,
      // The reference number is the fallback rather than the label: a title is
      // what a lead recognises, and every request has a reference anyway.
      title: request.title || request.reference_no,
      who: request.requester_org || "Client request",
      since: request.submitted_at.slice(0, 10),
      href: `/requests/${request.id}`,
    })),

    ...(internal.data ?? []).map((request) => ({
      id: `int-${request.id}`,
      kind: INTERNAL_REQUEST_LABELS[request.request_type] ?? "Request",
      tone: "warning" as const,
      title: when(request),
      who: nameOf.get(request.requester_id) ?? "A colleague",
      since: request.created_at.slice(0, 10),
      href: `/approvals/${request.id}`,
    })),

    ...(weeks.data ?? []).map((week) => ({
      id: `wk-${week.id}`,
      kind: "Timesheet",
      tone: "neutral" as const,
      title: `Week of ${formatDate(week.week_start)}`,
      who: nameOf.get(week.user_id) ?? "A colleague",
      since: (week.submitted_at ?? week.week_start).slice(0, 10),
      // `/timesheet/team` anchored on the week in question, so the row lands on
      // the grid that shows it rather than on this week's.
      href: `/timesheet/team?week=${week.week_start}`,
    })),
  ];
}
