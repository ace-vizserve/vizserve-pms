import type { Metadata } from "next";
import { BarChart3, Clock, ListChecks, TriangleAlert } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import type { VizservePmsRequestStatus, VizservePmsTaskStatus } from "@/lib/database.types";
import { addDays, addMonths, isOverdue, startOfMonth, todayInAppZone } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isTerminal,
} from "@/lib/schemas/tasks";
import { formatCellDuration } from "@/lib/schemas/timesheet";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { RequestStatusBadge } from "@/components/status-badge";
import { StatTile } from "@/components/stat-tile";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/utils/supabase/server";

import { BarRow, StageBar, StageLegend } from "./charts";
import { RangePicker } from "./range-picker";

export const metadata: Metadata = { title: "Reports" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * P6-05 / SLICE E2 — status and volume per department.
 *
 * THE NARROW READING OF P6-05 AND NO WIDER. Tasks by stage, requests by status,
 * overdue counts, and — for the first time with data behind it — hours logged per
 * department, which is the seventh metric in docs/09-later-phases.md:111.
 *
 * Explicitly NOT here: P6-04 (turnaround), P6-06 (negotiation and auto-complete
 * splits), P6-07 (feedback report), P6-08 (archive) and P6-09 (CSV export). Those
 * are the rest of the reporting phase, and the rest of the phase is a phase, not a
 * slice. E2 exists because slice C gave leads weeks to approve and D21 turned
 * "every report the team reads in ClickUp has an equivalent here" into the cutover
 * gate.
 *
 * AGGREGATED IN TYPESCRIPT OVER RLS-SCOPED ROWS, deliberately. Sixteen users and
 * one tenant do not justify a `SECURITY DEFINER` aggregate, and a definer function
 * would have to re-implement the department scoping the policies already do — the
 * exact duplication the house rules warn about. If this ever gets slow the upgrade
 * is a definer scoped through `vizserve_pms_approvable_department_ids()`; this
 * comment is that note, rather than the function being built now.
 *
 * NO DEPARTMENT FILTER IN ANY QUERY. Every table below scopes by policy, so the
 * same page shows a team leader their department and an admin everything. That is
 * also why the numbers can be trusted without a scope selector: there is nothing
 * on this page a reader is not already entitled to see.
 *
 * ONE EXCEPTION TO THAT, AND IT IS THE HOURS. `vizserve_pms_timesheet_entries`'
 * SELECT policy is owner-or-their-lead, which means a MEMBER reading this page
 * would see only their own hours under their own department's name and read it as
 * the department's total. Rather than adding a definer function for it, the page
 * is gated at `team_leader` — the role for whom the policy already returns the
 * whole department. A member has no departmental question to ask here anyway.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  // The gate, and it is about the HOURS rather than about seniority — see above.
  await requireRole("team_leader");

  const params = await searchParams;
  const supabase = await createClient();

  const today = todayInAppZone();

  /*
   * The period. This month by default, and narrowed rather than trusted: these
   * reach Postgres as date literals, so an unparseable value would turn a
   * mistyped bookmark into a 500.
   */
  const monthStart = startOfMonth(today) ?? today;
  const from = DATE.test(params.from ?? "") ? params.from! : monthStart;
  const to = DATE.test(params.to ?? "")
    ? params.to!
    : // The last day of the month the period starts in: forward a month, back a
      // day. `lib/dates.ts` has both, and neither needs a date library.
      (addDays(addMonths(monthStart, 1) ?? monthStart, -1) ?? today);

  /*
   * Inverted ranges are NOT silently swapped. Answering a different question than
   * the one asked is how somebody ends up trusting a period they never set — the
   * same call the DTR range makes.
   */
  const inverted = from > to;

  const [tasksResult, requestsResult, hoursResult, departmentsResult] = await Promise.all([
    /*
     * Tasks CREATED in the period, not tasks touched in it.
     *
     * "Volume per department" is a question about intake, and `created_at` is the
     * only date every task has — `due_date` is nullable on most internal work and
     * would silently drop it from the count.
     */
    inverted
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from("vizserve_pms_tasks")
          .select("id, status, department_id, due_date, created_at")
          .gte("created_at", from)
          // `to` is a DATE and `created_at` is a timestamp, so `lte` on the bare
          // date would exclude everything created after midnight on the last day.
          // The day after, exclusive, is the whole day.
          .lt("created_at", addDays(to, 1) ?? to),

    inverted
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from("vizserve_pms_requests")
          .select("id, status, created_at")
          .gte("created_at", from)
          .lt("created_at", addDays(to, 1) ?? to),

    // Hours logged in the period. `work_date` is a real date here, so the range is
    // inclusive on both ends with no arithmetic.
    inverted
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from("vizserve_pms_timesheet_entries")
          .select("minutes, vizserve_pms_tasks!inner(department_id)")
          .gte("work_date", from)
          .lte("work_date", to),

    supabase.from("vizserve_pms_departments").select("id, name").order("name"),
  ]);

  const departmentName = new Map(
    (departmentsResult.data ?? []).map((row) => [row.id, row.name] as const),
  );

  type TaskRow = {
    id: string;
    status: VizservePmsTaskStatus;
    department_id: string;
    due_date: string | null;
  };

  const tasks = (tasksResult.data ?? []) as TaskRow[];

  /**
   * Per department: the eight per-status counts, the three bands, and overdue.
   *
   * THE BANDS ARE DERIVED, not listed — `INITIAL_TASK_STATUS` and `isTerminal` are
   * the same two facts the status dropdown groups by, so a status added to the
   * enum lands in the right band here without anybody remembering to come back.
   * A hand-written list of "active statuses" is the copy that goes stale.
   */
  type Row = {
    id: string;
    name: string;
    byStatus: Record<VizservePmsTaskStatus, number>;
    notStarted: number;
    active: number;
    done: number;
    overdue: number;
    minutes: number;
    total: number;
  };

  const rows = new Map<string, Row>();

  function rowFor(departmentId: string): Row {
    const existing = rows.get(departmentId);
    if (existing) return existing;

    const fresh: Row = {
      id: departmentId,
      // A department the policy did not return is still a department this reader's
      // tasks belong to. Naming it "Another department" is more honest than
      // dropping the row and reporting a total that does not add up.
      name: departmentName.get(departmentId) ?? "Another department",
      byStatus: Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
        VizservePmsTaskStatus,
        number
      >,
      notStarted: 0,
      active: 0,
      done: 0,
      overdue: 0,
      minutes: 0,
      total: 0,
    };

    rows.set(departmentId, fresh);
    return fresh;
  }

  for (const task of tasks) {
    const row = rowFor(task.department_id);
    row.byStatus[task.status] += 1;
    row.total += 1;

    if (task.status === INITIAL_TASK_STATUS) row.notStarted += 1;
    else if (isTerminal(task.status)) row.done += 1;
    else row.active += 1;

    // Overdue only counts on live work. A completed task delivered late is
    // history, and counting it would make the figure only ever grow.
    if (isOverdue(task.due_date) && !isTerminal(task.status)) row.overdue += 1;
  }

  for (const entry of (hoursResult.data ?? []) as {
    minutes: number;
    vizserve_pms_tasks: { department_id: string } | null;
  }[]) {
    // `!inner` above means the join is guaranteed, but the generated type does not
    // know that. An entry with no task is not a thing the schema allows.
    const departmentId = entry.vizserve_pms_tasks?.department_id;
    if (!departmentId) continue;
    rowFor(departmentId).minutes += entry.minutes;
  }

  const departmentRows = [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const totals = departmentRows.reduce(
    (sum, row) => ({
      notStarted: sum.notStarted + row.notStarted,
      active: sum.active + row.active,
      done: sum.done + row.done,
      overdue: sum.overdue + row.overdue,
      minutes: sum.minutes + row.minutes,
      total: sum.total + row.total,
    }),
    { notStarted: 0, active: 0, done: 0, overdue: 0, minutes: 0, total: 0 },
  );

  // ------------------------------------------------------------- requests
  const requestCounts = new Map<VizservePmsRequestStatus, number>();
  for (const request of (requestsResult.data ?? []) as { status: VizservePmsRequestStatus }[]) {
    requestCounts.set(request.status, (requestCounts.get(request.status) ?? 0) + 1);
  }

  const requestTotal = [...requestCounts.values()].reduce((sum, count) => sum + count, 0);

  const maxHours = Math.max(0, ...departmentRows.map((row) => row.minutes));

  const error = tasksResult.error ?? requestsResult.error ?? hoursResult.error;

  const columns: Column<Row>[] = [
    {
      key: "department",
      header: "Department",
      className: "font-medium",
      cell: (row) => row.name,
    },
    ...TASK_STATUSES.map(
      (status): Column<Row> => ({
        key: status,
        // The human label, never the enum — a column headed
        // "COMPLETED_NO_RESPONSE" is a database value on screen.
        header: TASK_STATUS_LABELS[status],
        className: "hidden lg:table-cell tabular-nums text-muted-foreground",
        align: "end",
        cell: (row) =>
          row.byStatus[status] === 0 ? (
            // A dash rather than a zero. Eight columns of zeroes is a table
            // nobody can find the numbers in.
            <span className="text-foreground-faint">—</span>
          ) : (
            row.byStatus[status]
          ),
      }),
    ),
    {
      key: "overdue",
      header: "Overdue",
      className: "tabular-nums",
      align: "end",
      cell: (row) =>
        row.overdue === 0 ? (
          <span className="text-foreground-faint">—</span>
        ) : (
          // The word travels with the number, so a scanned column does not rely
          // on the heading being in view.
          <span className="font-medium text-destructive">{row.overdue} late</span>
        ),
    },
    {
      key: "hours",
      header: "Logged",
      className: "tabular-nums",
      align: "end",
      cell: (row) =>
        row.minutes === 0 ? (
          <span className="text-foreground-faint">—</span>
        ) : (
          formatCellDuration(row.minutes)
        ),
    },
  ];

  return (
    <PageShell>
      <RangePicker from={from} to={to} />

      {error ? (
        <QueryError what="the report" message={error.message} />
      ) : inverted ? (
        // Deliberately not swapped behind their back — the same call the DTR
        // range makes, and for the same reason.
        <div className="rounded-lg border bg-card grade-surface shadow-raised-lg">
          <EmptyState
            icon={<BarChart3 />}
            title="That period runs backwards"
            description={`From is ${from} and To is ${to}, so no day falls inside it. This is not an empty report — swap the two dates.`}
          />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* Every tile names its unit. "412" is not an answer to anything. */}
            <StatTile
              label="Tasks created"
              value={totals.total}
              hint="In this period, across every department you can see"
              icon={<ListChecks />}
              tone="info"
            />
            <StatTile
              label="Still open"
              value={totals.notStarted + totals.active}
              hint="Not yet finished, either ending"
              icon={<ListChecks />}
            />
            <StatTile
              label="Overdue now"
              value={totals.overdue}
              // "Now", not "in the period": an overdue count is a fact about
              // today, and saying so is what stops it being read as a historical
              // figure that can be reconciled later.
              hint="Past due and still live, as of today"
              icon={<TriangleAlert />}
              tone={totals.overdue > 0 ? "warning" : undefined}
            />
            <StatTile
              label="Hours logged"
              value={formatCellDuration(totals.minutes)}
              hint="Time entered against tasks in this period"
              icon={<Clock />}
            />
          </div>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Tasks by stage, per department</CardTitle>
              <CardDescription className="text-xs">
                {/* The reduction from eight statuses to three bands is stated,
                    not hidden — somebody comparing this against the table below
                    should not have to work out why the columns differ. */}
                The eight statuses grouped as the task list groups them. Per-status counts are in
                the table below.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <StageLegend
                notStarted={totals.notStarted}
                active={totals.active}
                done={totals.done}
              />

              {departmentRows.length === 0 ? (
                <p className="py-4 text-xs text-muted-foreground">
                  No tasks were created in this period.
                </p>
              ) : (
                <div className="space-y-2">
                  {departmentRows.map((row) => (
                    <StageBar
                      key={row.id}
                      label={row.name}
                      notStarted={row.notStarted}
                      active={row.active}
                      done={row.done}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Hours logged per department</CardTitle>
              <CardDescription className="text-xs">
                {/* "Billed time" was settled on 18 Aug 2026: it means the time
                    entered against a task on the timesheet, and nothing more.
                    There is no billable/non-billable split anywhere in the
                    schema, so the word is avoided here rather than invented. */}
                Time entered against tasks in this period. One series, so no legend — the title
                names it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {maxHours === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No time has been logged against tasks in this period.
                </p>
              ) : (
                <div className="space-y-2">
                  {[...departmentRows]
                    .sort((a, b) => b.minutes - a.minutes)
                    .map((row) => (
                      <BarRow
                        key={row.id}
                        label={row.name}
                        // Hours, to one place, because minutes on a bar label is
                        // four digits of precision nobody asked for. The table
                        // carries the exact figure.
                        value={Math.round((row.minutes / 60) * 10) / 10}
                        max={Math.round((maxHours / 60) * 10) / 10}
                        unit="h"
                        note={`${row.total} ${row.total === 1 ? "task" : "tasks"} created`}
                      />
                    ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Client requests by status</CardTitle>
              <CardDescription className="text-xs">
                Requests submitted through a shared form in this period. {requestTotal} in total.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {requestTotal === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No client requests were submitted in this period.
                </p>
              ) : (
                // The canonical pills rather than a second chart. Six statuses
                // over one dimension is a list of six numbers, and drawing it as
                // bars would be a chart whose only job is to be a chart.
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {[...requestCounts.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([status, count]) => (
                      <span key={status} className="inline-flex items-center gap-2">
                        <RequestStatusBadge status={status} />
                        <span className="text-sm font-semibold tabular-nums">{count}</span>
                      </span>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/*
            THE TABLE VIEW, and it is not optional decoration.

            The dataviz validator WARNs that three of the five categorical slots
            fall below 3:1 against white, and that warning obligates relief rather
            than being dismissable: visible labels or a table. This page has both.
            It is also where the per-status detail the bars collapse lives.
          */}
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Every figure, per department</h2>
            <DataTable
              columns={columns}
              rows={departmentRows}
              getRowKey={(row) => row.id}
              empty={
                <EmptyState
                  icon={<BarChart3 />}
                  title="Nothing in this period"
                  description="No tasks were created between these two dates. Widen the range, or check that the department you expected has work in it."
                />
              }
            />
          </div>
        </>
      )}
    </PageShell>
  );
}
