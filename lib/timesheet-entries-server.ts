import "server-only";

import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { createClient } from "@/utils/supabase/server";

/**
 * Timesheet entries for a date range, with the task each one is against.
 *
 * ⚠️ THE `LEFT` EMBED IS THE WHOLE REASON THIS IS ONE FUNCTION. It was typed out
 * three times — `/timesheet`, that page's last-week read, and `/timesheet/team`
 * — and it is the single most dangerous string in the module:
 *
 *   The entries policy returns a row on `user_id = auth.uid()`. The TASKS
 *   policy is narrower — PIC, QA, or department lead — so the two diverge the
 *   moment a task is reassigned away from somebody who already logged time
 *   against it. An `!inner` join turns "I cannot see that task" into "that row
 *   does not exist", and their hours vanish from their own week, from the day
 *   totals, and from everything derived from them.
 *
 * Pinned by `tests/db/timesheet.test.ts`, "entries survive losing sight of
 * their task" — but that test only ever covered ONE of the three copies. Two of
 * them carried the property by luck and a comment. Now there is one string to
 * get wrong, in a file whose header says why.
 *
 * ⚠️ `user_id` IS ALWAYS SELECTED, even for the first-person callers that have
 * no use for it. A column the lead's grid needs and the member's page does not
 * is not worth two functions, and the alternative — two selects that "only"
 * differ by one column — is exactly how the embed came to differ too.
 *
 * NO DEPARTMENT FILTER. The policy scopes rows to the caller and to leads of
 * their department; restating it here would imply the policy is optional. The
 * `userId` argument NARROWS that result for the first-person screens, it does
 * not replace it.
 */

export type TimesheetEntryRow = {
  id: string;
  user_id: string;
  task_id: string;
  work_date: string;
  minutes: number;
  note: string | null;
  /** P7-21. `HH:MM:SS` over the wire; callers trim to `HH:MM`. */
  started_at: string | null;
  ended_at: string | null;
  /** Null when the task has left the reader's scope — see the header. */
  vizserve_pms_tasks: {
    title: string;
    status: VizservePmsTaskStatus;
    list_id: string | null;
    department_id: string | null;
  } | null;
};

const ENTRY_COLUMNS =
  "id, user_id, task_id, work_date, minutes, note, started_at, ended_at, " +
  "vizserve_pms_tasks(title, status, list_id, department_id)";

export async function loadTimesheetEntries(
  from: string,
  to: string,
  /** One person, for the first-person week. Omit for everyone in scope. */
  userId?: string | null,
): Promise<{ entries: TimesheetEntryRow[]; error: { message: string } | null }> {
  const supabase = await createClient();

  let query = supabase
    .from("vizserve_pms_timesheet_entries")
    .select(ENTRY_COLUMNS)
    .gte("work_date", from)
    .lte("work_date", to)
    .order("work_date")
    .order("created_at");

  if (userId) query = query.eq("user_id", userId);

  const { data, error } = await query;

  // ⚠️ THE ERROR TRAVELS. A failed read rendered as an empty week is
  // indistinguishable from a week nobody worked, on the one screen where that
  // distinction decides what somebody gets paid.
  return {
    entries: (data ?? []) as unknown as TimesheetEntryRow[],
    error: error ? { message: error.message } : null,
  };
}
