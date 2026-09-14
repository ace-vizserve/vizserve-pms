import "server-only";

import { createClient } from "@/utils/supabase/server";

/**
 * Approved overtime falling inside a date range.
 *
 * WHY THIS EXISTS. Three screens asked this and each wrote it out: `/timesheet`
 * (to raise the eight-hour marker on a day somebody was signed off to work
 * long), `/timesheet/team` (the same marker on a lead's grid), and
 * `/hr/attendance` (so a late clock-out on an agreed long day is not counted as
 * undertime). Three copies of `request_type = OVERTIME and status = APPROVED`
 * over a `work_date` range, differing only in which columns they bothered to
 * select — which is exactly how the leave read ended up answering the same
 * question two ways on two screens.
 *
 * ⚠️ NOT THE FOURTH CALLER. `/dtr` reads overtime too, and deliberately does
 * NOT use this: its query pulls `TIME_CORRECTION_TYPES` alongside OVERTIME and
 * takes EVERY status, because it renders the requests attached to a day as well
 * as the approved minutes. Narrowing it to this would cost the screen the
 * pending and returned rows it exists to show. A superset serving two purposes
 * is not a duplicate of the subset.
 *
 * ⚠️ ADVISORY EVERYWHERE, NEVER ENFORCEMENT. The enforced rule is the
 * 1440-minute day trigger on `vizserve_pms_timesheet_entries`; approved
 * overtime is capped at 960 by a CHECK precisely so `480 + approved` cannot
 * exceed what the trigger allows.
 *
 * ⚠️ `id` IS NOT DECORATION. A day marked "OT" is the app asserting somebody
 * signed those hours off, and the id is what lets a reader open that decision.
 * It is safe to put in a link because it arrived through a policy-scoped read.
 *
 * NO DEPARTMENT FILTER. The policy on `vizserve_pms_internal_requests` scopes
 * rows to the requester and to leads of their department; restating it here
 * would imply the policy is optional.
 */

export type ApprovedOvertime = {
  id: string;
  requester_id: string;
  /** `YYYY-MM-DD`. Non-null on every OVERTIME row by CHECK. */
  work_date: string;
  overtime_minutes: number;
};

type OvertimeRow = {
  id: string;
  requester_id: string;
  work_date: string | null;
  overtime_minutes: number | null;
};

export async function loadApprovedOvertime(
  from: string,
  to: string,
  /** One person, for the first-person screens. Omit for everyone in scope. */
  userId?: string | null,
): Promise<ApprovedOvertime[]> {
  const supabase = await createClient();

  let query = supabase
    .from("vizserve_pms_internal_requests")
    .select("id, requester_id, work_date, overtime_minutes")
    .eq("request_type", "OVERTIME")
    .eq("status", "APPROVED")
    .gte("work_date", from)
    .lte("work_date", to);

  if (userId) query = query.eq("requester_id", userId);

  const { data } = await query;

  return ((data ?? []) as OvertimeRow[])
    // A CHECK guarantees both on an OVERTIME row; the generated types do not,
    // and a null date would key a day nothing can look up.
    .filter((row): row is OvertimeRow & { work_date: string } => row.work_date !== null)
    .map((row) => ({
      id: row.id,
      requester_id: row.requester_id,
      work_date: row.work_date,
      overtime_minutes: row.overtime_minutes ?? 0,
    }));
}
