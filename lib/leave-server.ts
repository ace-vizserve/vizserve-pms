import "server-only";

import type { LeaveSpan } from "@/lib/leave";
import { createClient } from "@/utils/supabase/server";

/**
 * Approved leave overlapping a date range, as `lib/leave.ts` wants it.
 *
 * WHY THIS EXISTS. Three screens asked this question and each wrote out the
 * query, the row type and the `requester_id -> user_id` mapping by hand:
 * `/dtr`, its payroll-export action, and `/hr/attendance`. The first two were
 * byte-identical down to the comment. The third selected FEWER COLUMNS — no
 * `start_half`, no `end_half` — so the attendance screen could not tell a half
 * day from a whole one, counted every half day as a full absence-exempt day,
 * and let the worked half of it escape the lateness and undertime checks
 * entirely. That is what three copies of a query buy you: not a typo, a
 * quietly different answer to the same question on two screens.
 *
 * ⚠️ NOT `vizserve_pms_leave_calendar`, AND THE DIFFERENCE IS LOAD-BEARING.
 * That function is SECURITY DEFINER and returns EVERY active user, because it
 * backs an out-of-office widget where that is the point. These callers are
 * SCOPED — a lead sees their departments, a member sees themselves — so they go
 * through the ordinary policy on `vizserve_pms_internal_requests`
 * (`requester_id = auth.uid() or vizserve_pms_manages_department(...)`), which
 * is the same shape as the DTR's own policy. Borrowing the calendar here would
 * put people outside the caller's scope into a payroll export.
 *
 * It also means the HALVES come along, which the calendar deliberately withholds
 * — P7-16 was right that a shared out-of-office view has no business claiming
 * "available until midday", and equally right that payroll is the opposite case.
 *
 * ⚠️ NO DEPARTMENT FILTER, deliberately. The policy does it. Restating it here
 * would imply the policy is optional.
 *
 * `reason` is never selected. The absence belongs on these screens; why belongs
 * to the requester and the lead who decided it.
 */

/** What PostgREST hands back before the embed is flattened. */
type LeaveRequestRow = {
  requester_id: string;
  start_date: string | null;
  end_date: string | null;
  start_half: "MORNING" | "AFTERNOON" | null;
  end_half: "MORNING" | "AFTERNOON" | null;
  vizserve_pms_leave_types: { label: string } | null;
};

const LEAVE_COLUMNS =
  "requester_id, start_date, end_date, start_half, end_half, vizserve_pms_leave_types(label)";

export async function loadApprovedLeaveSpans(
  from: string,
  to: string,
  /** One person, for the DTR's person picker. Omit for everyone in scope. */
  userId?: string | null,
): Promise<{ spans: LeaveSpan[]; error: { message: string } | null }> {
  const supabase = await createClient();

  let query = supabase
    .from("vizserve_pms_internal_requests")
    .select(LEAVE_COLUMNS)
    .eq("request_type", "LEAVE")
    .eq("status", "APPROVED")
    // OVERLAP, not containment — leave running across the range boundary counts
    // for the days that fall inside it. `expandLeaveDays` clamps the ends.
    .lte("start_date", to)
    .gte("end_date", from);

  if (userId) query = query.eq("requester_id", userId);

  const { data, error } = await query;

  // ⚠️ THE ERROR TRAVELS. /dtr renders a QueryError banner from it and the
  // payroll export refuses outright — an absence silently missing from a
  // payroll file is the failure this whole module exists to prevent, so a
  // failed read must not arrive looking like "nobody was away".
  const spans = ((data ?? []) as unknown as LeaveRequestRow[])
    // The shape constraint guarantees both dates on a LEAVE row; the generated
    // types do not, and a null would expand into an unbounded walk.
    .filter((row) => row.start_date !== null && row.end_date !== null)
    .map((row) => ({
      user_id: row.requester_id,
      start_date: row.start_date!,
      end_date: row.end_date!,
      start_half: row.start_half,
      end_half: row.end_half,
      type_name: row.vizserve_pms_leave_types?.label ?? null,
    }));

  return { spans, error: error ? { message: error.message } : null };
}
