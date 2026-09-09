"use client";

import { useQuery } from "@tanstack/react-query";
import { BarChart3, Clock, ListChecks, TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { RequestStatusBadge } from "@/components/status-badge";
import { StatTile } from "@/components/stat-tile";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { browserClient } from "@/lib/query/browser-client";
import { fetchDepartments } from "@/lib/query/fetchers/ref";
import {
  fetchDepartmentReport,
  type DepartmentReport,
} from "@/lib/query/fetchers/reports";
import { qk } from "@/lib/query/keys";
import { formatCellDuration } from "@/lib/schemas/timesheet";

import { BarRow, StageBar, StageLegend } from "./charts";
import { EngagementCard, FeedbackCard, NegotiationCard, TurnaroundCard } from "./metric-cards";
import { RangePicker } from "./range-picker";
import { ReportsTable } from "./reports-table";

/**
 * P6-05 / P6-04 / P6-06 / P6-07 / P12-21 — `/reports`, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * This was a 465-line RSC holding eight queries, `lib/reports-server.ts`'s four
 * loaders and every derivation over them, all behind ONE cache entry — the
 * route's own render. Nudging the From date therefore re-read the departments,
 * re-rendered the shell and re-ran all eight, because `RangePicker` calls
 * `router.push` and a route render has no smaller unit. The reads are now two
 * query keys: `qk.reports({from, to})` for the period and `qk.ref("departments")`
 * for the names, which every other screen in the app has already fetched.
 *
 * ⚠️ THE GATE DID NOT MOVE. `requireRole("team_leader")` runs in `page.tsx`
 * beside this, and it is about the HOURS rather than about seniority:
 * `vizserve_pms_timesheet_entries`' SELECT policy is owner-or-their-lead, so a
 * MEMBER reading this page would see only their own hours under their own
 * department's name and read it as the department's total. Settled decision 6 —
 * authentication does not move in any phase.
 *
 * ⚠️ NOR DID THE PERIOD, AND THAT IS DELIBERATE. `page.tsx` still awaits
 * `searchParams`, still narrows both dates with the same regex, and still hands
 * them down. The URL is the shareable source of truth for this period — a lead
 * who wants to send somebody "last month across the department" sends a link —
 * and reading it twice, once there for the fallback and once here with
 * `useSearchParams`, is how a key and a query drift by one navigation.
 *
 * ⚠️ AND NOTHING ABOUT THE FIGURES CHANGED ON THE WAY. Every derivation is the
 * same arithmetic in the same order; it lives in
 * `lib/query/fetchers/reports.ts` now, where it can throw. What it lost is nine
 * `?? []`s and four discarded PostgREST errors — see that file, which lists what
 * each of them rendered as.
 * ------------------------------------------------------------------------
 */
export function ReportsView({
  from,
  to,
  inverted,
}: {
  from: string;
  to: string;
  /**
   * ⚠️ INVERTED RANGES ARE NOT SILENTLY SWAPPED. Answering a different question
   * than the one asked is how somebody ends up trusting a period they never set
   * — the same call the DTR range makes. Decided in `page.tsx` beside the
   * narrowing that produced the two dates, so there is one reading of what the
   * period is.
   */
  inverted: boolean;
}) {
  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still rendered on the server for its initial
   * HTML and `createBrowserClient` reaches for `document.cookie`, which does not
   * exist there. A `queryFn` only ever runs in the browser.
   *
   * ⚠️ `enabled` RATHER THAN A FETCH-AND-DISCARD ON AN INVERTED RANGE. The RSC
   * resolved eight `Promise.resolve({data: [], error: null})`s for that case,
   * which was free because it never issued them; a query that ran and was thrown
   * away would not be. No day falls inside a backwards period, so there is
   * nothing to ask.
   */
  const reportQuery = useQuery({
    queryKey: qk.reports({ from, to }),
    queryFn: () => fetchDepartmentReport(browserClient(), { from, to }),
    enabled: !inverted,
  });

  /*
   * The department NAMES, from the reference entry rather than from this
   * report's own key.
   *
   * ⚠️ IT WAS THE EIGHTH QUERY IN THE RSC'S WAVE AND IT SHOULD NEVER HAVE BEEN.
   * A department's name does not depend on the period, so folding it into
   * `qk.reports(...)` meant re-reading six rows that change once a quarter every
   * time somebody moved a date. Under `qk.ref("departments")` it carries
   * `REF_STALE_TIME` and is almost always already in the tab — `/tasks` and
   * `/forms` both populate it.
   *
   * ⚠️ AND IT IS NOT GATED ON `inverted`. The names are wanted whatever the
   * period says, and asking for them is free on a warm cache.
   */
  const departmentsQuery = useQuery({
    queryKey: qk.ref("departments"),
    queryFn: () => fetchDepartments(browserClient()),
  });

  const failure = reportQuery.error ?? departmentsQuery.error;

  /*
   * ⚠️ ONE FAILURE STOPS THE WHOLE PAGE, AND THAT IS THE DESIGN RATHER THAN
   * CONVENIENCE. This is the one screen in the product where people make
   * decisions from numbers; a page showing three cards and a hole is a page
   * inviting somebody to add up what is left. The period is the unit of trust,
   * so it is the unit of failure. `lib/query/fetchers/reports.ts` argues it at
   * greater length, and lists what each swallowed error used to render as.
   */
  const body = failure ? (
    <QueryError what="the report" message={failure.message} />
  ) : inverted ? (
    <div className="rounded-lg border bg-card grade-surface shadow-raised-lg">
      <EmptyState
        icon={<BarChart3 />}
        title="That period runs backwards"
        description={`From is ${from} and To is ${to}, so no day falls inside it. This is not an empty report — swap the two dates.`}
      />
    </div>
  ) : !reportQuery.data || !departmentsQuery.data ? (
    /*
     * The same shape `loading.tsx` draws, for the same reason it draws it: a
     * placeholder that does not match the page it stands in for produces a
     * layout jump on every load, which is worse than a spinner.
     */
    <ReportSkeleton />
  ) : (
    <Report
      report={reportQuery.data}
      departmentNames={
        new Map(departmentsQuery.data.map((row) => [row.id, row.name] as const))
      }
    />
  );

  return (
    <PageShell>
      <RangePicker from={from} to={to} />
      {body}
    </PageShell>
  );
}

function ReportSkeleton() {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, tile) => (
          <Skeleton key={tile} className="h-24 rounded-lg" />
        ))}
      </div>
      {Array.from({ length: 2 }, (_, card) => (
        <Skeleton key={card} className="h-56 rounded-lg" />
      ))}
      <Skeleton className="h-48 rounded-lg" />
    </>
  );
}

/**
 * Everything below the range picker, once the figures are in hand.
 *
 * Split from the query component only so the happy path reads as one block of
 * markup rather than as the tail of a four-branch ternary. Nothing is decided
 * here.
 */
function Report({
  report,
  departmentNames,
}: {
  report: DepartmentReport;
  departmentNames: Map<string, string>;
}) {
  const { totals, turnaround, negotiation, engagement, feedback } = report;

  /*
   * ⚠️ THE NAMES ARE JOINED ON HERE, and the fallback is the RSC's own.
   *
   * A department the policy did not return is still a department this reader's
   * tasks belong to. Naming it "Another department" is more honest than dropping
   * the row and reporting a total that does not add up.
   *
   * ⚠️ AND SINCE P12-20 IT NO LONGER FIRES FOR A RETIRED DEPARTMENT.
   * `qk.ref("departments")` holds every department in scope, active or not,
   * precisely so this label means what it says — a permissions boundary — rather
   * than "somebody unticked Active on this team in March".
   */
  const departmentRows = report.departments
    .map((row) => ({ ...row, name: departmentNames.get(row.id) ?? "Another department" }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const maxHours = Math.max(0, ...departmentRows.map((row) => row.minutes));

  return (
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
          // "Now", not "in the period": an overdue count is a fact about today,
          // and saying so is what stops it being read as a historical figure
          // that can be reconciled later.
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

      {/*
        P6-04 / P6-06 / P6-07 — the four questions P6-05 could not answer.
        Two columns from `lg` up: each is a self-contained finding rather than a
        series to be compared across, so they read as four cards and not as one
        dashboard.

        ⚠️ THE NULL GUARDS ARE GONE. They existed because the RSC set all four to
        `null` on an inverted range and the type checker could not see that the
        branch above had already handled it. The query is `enabled: false` for
        that case now, so this component is never reached without them.
      */}
      <div className="grid gap-3 lg:grid-cols-2">
        <TurnaroundCard data={turnaround} />
        <NegotiationCard data={negotiation} />
        <EngagementCard data={engagement} />
        <FeedbackCard data={feedback} />
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Tasks by stage, per department</CardTitle>
          <CardDescription className="text-xs">
            {/* The reduction from eight statuses to three bands is stated, not
                hidden — somebody comparing this against the table below should
                not have to work out why the columns differ. */}
            The eight statuses grouped as the task list groups them. Per-status counts are in the
            table below.
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
                entered against a task on the timesheet, and nothing more. There
                is no billable/non-billable split anywhere in the schema, so the
                word is avoided here rather than invented. */}
            Time entered against tasks in this period. One series, so no legend — the title names
            it.
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
            Requests submitted through a shared form in this period. {report.requestTotal} in
            total.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {report.requestTotal === 0 ? (
            <p className="text-xs text-muted-foreground">
              No client requests were submitted in this period.
            </p>
          ) : (
            // The canonical pills rather than a second chart. Six statuses over
            // one dimension is a list of six numbers, and drawing it as bars
            // would be a chart whose only job is to be a chart.
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {report.requestCounts.map(({ status, count }) => (
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

        The dataviz validator WARNs that three of the five categorical slots fall
        below 3:1 against white, and that warning obligates relief rather than
        being dismissable: visible labels or a table. This page has both. It is
        also where the per-status detail the bars collapse lives.
      */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Every figure, per department</h2>
        <ReportsTable rows={departmentRows} />
      </div>
    </>
  );
}
