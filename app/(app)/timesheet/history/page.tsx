import type { Metadata } from "next";

import { requireAuthContext } from "@/lib/auth/authorization";
import { loadUserNames } from "@/lib/counts-server";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { MySubmissionsTable, type MySubmission } from "./my-submissions-table";

export const metadata: Metadata = { title: "My submissions" };

/**
 * Every timesheet week this person has handed in, newest first.
 *
 * `/timesheet` shows the status of ONE week — the one on screen — and the
 * dashboard shows this week and last. Anything older meant stepping back a week
 * at a time to find out whether it had been approved or sent back.
 *
 * READ-ONLY. Submitting, fixing and resubmitting stay on the grid, where the
 * hours are; each row links there.
 *
 * The `user_id` eq NARROWS a policy result rather than replacing it — a lead
 * can read their team's weeks, and this list is first-person only.
 *
 * Capped rather than paginated: one row per week is ~52 a year, so 260 is five
 * years, and the table sorts in the browser because it holds every row it has.
 */
const LIMIT = 260;

export default async function MySubmissionsPage() {
  const context = await requireAuthContext();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("vizserve_pms_timesheet_weeks")
    .select("id, week_start, status, submitted_minutes, submitted_at, decision_reason, reviewed_by, reviewed_at")
    .eq("user_id", context.userId)
    .order("week_start", { ascending: false })
    .limit(LIMIT);

  const weeks = data ?? [];
  const reviewerNames = await loadUserNames(
    weeks.map((week) => week.reviewed_by).filter(Boolean) as string[],
  );

  const rows: MySubmission[] = weeks.map((week) => ({
    id: week.id,
    weekStart: week.week_start,
    status: week.status,
    submittedMinutes: week.submitted_minutes,
    submittedAt: week.submitted_at,
    decisionReason: week.decision_reason,
    reviewerName: week.reviewed_by ? (reviewerNames[week.reviewed_by] ?? null) : null,
    reviewedAt: week.reviewed_at,
  }));

  return (
    <PageShell>
      <MySubmissionsTable
        rows={rows}
        error={error ? <QueryError what="your submitted weeks" message={error.message} /> : null}
      />
    </PageShell>
  );
}
