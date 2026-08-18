import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import { addDays, formatWeekRange, startOfWeek, todayInAppZone, weekDates } from "@/lib/dates";
import type { TimesheetWeekStatus } from "@/lib/schemas/timesheet";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";

import { TeamWeekGrid, type TeamRow } from "./team-week-grid";

export const metadata: Metadata = { title: "Team week" };

/**
 * P6-05 / slice E1 — the lead's week, and slice C's reviewer screen.
 *
 * These were always one page. A queue of weeks to approve with no view of the
 * hours inside them is a rubber stamp, so the approve buttons live ON the grid
 * rather than on a list that links to it.
 *
 * THE SHAPE IS THE TRANSPOSE of the member's own week: people down the side,
 * the seven days across, totals on both axes. A lead already knows how to read
 * it, because it is the same grid they fill in themselves.
 *
 * NO DEPARTMENT FILTER ON ANY QUERY. Every table here scopes by policy through
 * the person the row belongs to — `20260817090000_p6_01_timesheet.sql:154-164`
 * for entries, and the equivalent on weeks and internal requests. Restating the
 * filter would imply the policy is optional, and it is the only thing standing
 * between one lead and another lead's team.
 */
export default async function TeamWeekPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const context = await requireAuthContext();

  // A member has nobody to review. The policies would return only their own
  // rows anyway, so this is about not offering a page that can only ever show
  // one person their own week twice.
  if (!roleAtLeast(context.role, "team_leader")) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">
          This page is for team leaders. Your own week is on{" "}
          <Link href="/timesheet" className="underline">
            the timesheet
          </Link>
          .
        </p>
      </PageShell>
    );
  }

  const supabase = await createClient();
  const params = await searchParams;

  const today = todayInAppZone();
  // Any day in the week works as an anchor and is normalised here, mirroring
  // `/timesheet` and `vizserve_pms_submit_timesheet_week`. `?week=banana`
  // falls back to this week rather than erroring.
  const monday = startOfWeek(params.week ?? today) ?? startOfWeek(today)!;
  const days = weekDates(monday);
  const lastDay = days[days.length - 1]!;

  const [entriesResult, weeksResult, overtimeResult, leaveResult, peopleResult] =
    await Promise.all([
      // Every entry the policy will show this lead, for this week. The join to
      // users is what names the rows.
      supabase
        .from("vizserve_pms_timesheet_entries")
        .select("user_id, work_date, minutes")
        .gte("work_date", monday)
        .lte("work_date", lastDay),

      supabase
        .from("vizserve_pms_timesheet_weeks")
        .select("id, user_id, status, submitted_minutes, submitted_at, decision_reason")
        .eq("week_start", monday),

      // The team's approved overtime, not just the viewer's. This widens from
      // the member's page with NO policy change: the SELECT policy on internal
      // requests already returns `requester_id = auth.uid() or
      // vizserve_pms_manages_department(department_id)`.
      supabase
        .from("vizserve_pms_internal_requests")
        .select("requester_id, work_date, overtime_minutes")
        .eq("request_type", "OVERTIME")
        .eq("status", "APPROVED")
        .gte("work_date", monday)
        .lte("work_date", lastDay),

      /*
       * P7-10 — who was away.
       *
       * WITHOUT THIS THE PAGE LIBELS PEOPLE. Slice C refuses to submit an empty
       * week ("an approved empty week is a signed statement that somebody did
       * nothing"), so a person on approved leave all week has no week row at
       * all — and on this grid that is indistinguishable from somebody who has
       * simply not filed. A lead would chase someone who was on holiday, which
       * is the exact manual process this module exists to remove.
       *
       * The function returns name and dates and no reason and no type, so the
       * grid can say "on leave" and nothing more. That is all a lead needs and
       * all they are entitled to.
       */
      supabase.rpc("vizserve_pms_leave_calendar", { p_from: monday, p_to: lastDay }),

      supabase.from("vizserve_pms_users").select("id, full_name").eq("is_active", true),
    ]);

  const nameOf = new Map((peopleResult.data ?? []).map((row) => [row.id, row.full_name]));

  // Minutes per person per day.
  const cells = new Map<string, Record<string, number>>();
  for (const entry of entriesResult.data ?? []) {
    const row = cells.get(entry.user_id) ?? {};
    row[entry.work_date] = (row[entry.work_date] ?? 0) + entry.minutes;
    cells.set(entry.user_id, row);
  }

  // Approved overtime per person per day, summed — two approvals for one day
  // both count, for the same reason they do on the member's page.
  const overtime = new Map<string, Record<string, number>>();
  for (const row of overtimeResult.data ?? []) {
    if (!row.work_date) continue;
    const byDay = overtime.get(row.requester_id) ?? {};
    byDay[row.work_date] = (byDay[row.work_date] ?? 0) + (row.overtime_minutes ?? 0);
    overtime.set(row.requester_id, byDay);
  }

  // Leave days per person. Expanded from spans to individual dates here so the
  // grid can ask a flat question per cell.
  const leave = new Map<string, Set<string>>();
  for (const span of (leaveResult.data ?? []) as {
    user_id: string;
    start_date: string;
    end_date: string;
  }[]) {
    const taken = leave.get(span.user_id) ?? new Set<string>();
    for (const day of days) {
      if (day >= span.start_date && day <= span.end_date) taken.add(day);
    }
    leave.set(span.user_id, taken);
  }

  const weekByUser = new Map((weeksResult.data ?? []).map((row) => [row.user_id, row]));

  // Everyone the lead can see anything about this week: somebody with hours,
  // somebody with a submitted week, or somebody who was away. Built from the
  // policy-scoped results rather than from a department list, so the page shows
  // exactly what the database is willing to show and never an empty row for
  // somebody out of scope.
  const userIds = new Set<string>([
    ...cells.keys(),
    ...weekByUser.keys(),
    ...leave.keys(),
  ]);

  const rows: TeamRow[] = [...userIds]
    .map((userId) => {
      const week = weekByUser.get(userId);

      return {
        userId,
        name: nameOf.get(userId) ?? "Someone no longer active",
        cells: cells.get(userId) ?? {},
        overtime: overtime.get(userId) ?? {},
        leaveDays: [...(leave.get(userId) ?? [])],
        weekId: week?.id ?? null,
        status: (week?.status ?? null) as TimesheetWeekStatus | null,
        submittedMinutes: week?.submitted_minutes ?? null,
        decisionReason: week?.decision_reason ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const previousWeek = addDays(monday, -7);
  const nextWeek = addDays(monday, 7);
  const thisWeek = startOfWeek(today);

  function weekHref(target: string | null) {
    return target && target !== thisWeek ? `/timesheet/team?week=${target}` : "/timesheet/team";
  }

  return (
    <PageShell className="gap-3">
      <div className="flex items-center gap-2 rounded-lg border bg-card grade-surface p-2 shadow-raised-lg">
        <Link
          href={weekHref(previousWeek)}
          aria-label="Previous week"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <ChevronLeft />
        </Link>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-medium">{formatWeekRange(monday)}</p>
          {monday === thisWeek ? (
            <p className="text-2xs text-muted-foreground">This week</p>
          ) : (
            <Link href="/timesheet/team" className="text-2xs text-muted-foreground hover:underline">
              Back to this week
            </Link>
          )}
        </div>

        <Link
          href={weekHref(nextWeek)}
          aria-label="Next week"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <ChevronRight />
        </Link>
      </div>

      {/* A failed read rendering as "nobody logged anything" is the specific
          failure this app keeps having. Named rather than swallowed. */}
      {entriesResult.error ? (
        <QueryError what="this week" message={entriesResult.error.message} />
      ) : (
        <TeamWeekGrid monday={monday} days={days} today={today} rows={rows} />
      )}
    </PageShell>
  );
}
