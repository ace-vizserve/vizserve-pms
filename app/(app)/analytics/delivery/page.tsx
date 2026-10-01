import { Suspense } from "react";
import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { departmentScopeFilter, requireRole, type AuthContext } from "@/lib/auth/authorization";
import { formatDate, todayInAppZone } from "@/lib/dates";
import { percent, STAGE_BUCKETS, previousPeriod } from "@/lib/performance";
import { loadDepartmentOptions, loadPerformance, type PerformanceFilters as PerformanceFilterValues } from "@/lib/performance-server";

import { BarRow } from "../../reports/charts";
import { AnalyticsTabs } from "../analytics-tabs";
import { days, Delta, Figure, hoursValue, LoadErrors, pct, periodLabel, rateHint, SimpleTable, FiguresSkeleton } from "../figures";
import { readAnalyticsFilters, type AnalyticsSearch } from "../params";
import { PerformanceFilters } from "../performance-filters";

export const metadata: Metadata = { title: "Delivery & quality" };

/**
 * P15-02 — IS WORK FINISHED, ON TIME, AND RIGHT FIRST TIME?
 *
 * Every figure is for work COMPLETED in the period, compared with the period of
 * the same length before it. The bottleneck card answers "where does the time
 * go" from the task history: hours in each stage per finished task.
 */
export default async function DeliveryPage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
  const context = await requireRole("team_leader");
  const today = todayInAppZone();
  const filters = readAnalyticsFilters(await searchParams, today);
  // P15-02 — the bar renders from this cheap read; the figures stream below it.
  const { departments } = await loadDepartmentOptions(context);
  const period = { from: filters.from, to: filters.to };
  const previous = previousPeriod(period);

  return (
    <PageShell className="gap-3">
      <AnalyticsTabs />
      <PerformanceFilters
        basePath="/analytics/delivery"
        from={filters.from}
        to={filters.to}
        today={today}
        departments={departments}
        allLabel={departmentScopeFilter(context) === null ? "All departments" : "All my departments"}
        previousLabel={`Work completed ${periodLabel(period)}, compared with ${periodLabel(previous)}.`}
      />
      {/* Keyed by the filters, so changing one shows the skeleton at once
          instead of leaving the old figures up while the new ones load. */}
      <Suspense key={JSON.stringify(filters)} fallback={<FiguresSkeleton />}>
        <Body context={context} filters={filters} />
      </Suspense>
    </PageShell>
  );
}

async function Body({ context, filters }: { context: AuthContext; filters: PerformanceFilterValues }) {
  const data = await loadPerformance(context, filters);
  const { team, teamBefore } = data;
  const now = team.delivery;
  const before = teamBefore.delivery;

  const stages = STAGE_BUCKETS.map((stage) => ({ ...stage, hours: now.stageHours[stage.key] ?? 0 }));
  const slowest = stages.reduce((max, stage) => (stage.hours > max.hours ? stage : max), stages[0]!);
  const maxThroughput = Math.max(0, ...now.throughput.map((week) => week.completed));

  return (
    <>
      <LoadErrors errors={data.errors} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Figure
          label="Completed"
          value={now.completed}
          hint="Tasks finished in the period"
          delta={<Delta now={now.completed} before={before.completed} better="up" />}
        />
        <Figure
          label="On time"
          value={pct(now.onTime)}
          hint={rateHint(now.onTime, "with a due date")}
          delta={<Delta now={percent(now.onTime)} before={percent(before.onTime)} better="up" unit=" pts" />}
        />
        <Figure
          label="Cycle time"
          value={days(now.cycleDays)}
          hint="Median, created to completed"
          delta={<Delta now={now.cycleDays} before={before.cycleDays} better="down" format={(value) => days(value)} />}
        />
        <Figure
          label="Passed QA first time"
          value={pct(now.firstPass)}
          hint={rateHint(now.firstPass, "that went through QA")}
          delta={<Delta now={percent(now.firstPass)} before={percent(before.firstPass)} better="up" unit=" pts" />}
        />
        <Figure
          label="Sent back by QA"
          value={now.qaReturns}
          hint="Returns in the period"
          tone={now.qaReturns > 0 ? "warning" : undefined}
          delta={<Delta now={now.qaReturns} before={before.qaReturns} better="down" />}
        />
        <Figure
          label="Hours vs estimate"
          value={now.estimateRatio === null ? "—" : `${Math.round(now.estimateRatio * 100)}%`}
          hint={
            now.estimated === 0
              ? "No finished task had an estimate"
              : `Median of ${now.estimated} estimated ${now.estimated === 1 ? "task" : "tasks"}; over 100% ran long`
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Where the time goes</CardTitle>
            <CardDescription className="text-xs">
              Average time a finished task spent in each stage. The longest bar is the bottleneck
              {now.completed > 0 && slowest.hours > 0 ? ` — here, ${slowest.label.toLowerCase()}` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {now.completed === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing was completed in this period.</p>
            ) : (
              <div className="space-y-2">
                {stages.map((stage) => (
                  <BarRow
                    key={stage.key}
                    label={stage.label}
                    value={Math.round(stage.hours * 10) / 10}
                    max={Math.round(slowest.hours * 10) / 10}
                    unit="h"
                    note={hoursValue(stage.hours)}
                    tone={stage.key === slowest.key ? "chart-2" : "chart-1"}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Completed per week</CardTitle>
            <CardDescription className="text-xs">Weeks start on Monday.</CardDescription>
          </CardHeader>
          <CardContent>
            {maxThroughput === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing was completed in this period.</p>
            ) : (
              <div className="space-y-2">
                {now.throughput.map((week) => (
                  <BarRow
                    key={week.weekStart}
                    label={`Week of ${formatDate(week.weekStart)}`}
                    value={week.completed}
                    max={maxThroughput}
                    unit=" tasks"
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">QA reviewers</CardTitle>
          <CardDescription className="text-xs">
            Reviews finished in the period, how long work waited in &ldquo;For QA&rdquo; before they picked it up
            (median), and how many they sent back.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {team.reviewers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No QA reviews in this period.</p>
          ) : (
            <SimpleTable
              head={["Reviewer", "Reviews", "Waited for them", "Sent back"]}
              rows={team.reviewers.map((row) => [
                data.nameOf.get(row.userId) ?? "Someone no longer active",
                row.reviews,
                hoursValue(row.waitHours),
                row.returns,
              ])}
            />
          )}
        </CardContent>
      </Card>

      {data.byDepartment.length > 1 ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Departments side by side</CardTitle>
            <CardDescription className="text-xs">The same figures, one row per department.</CardDescription>
          </CardHeader>
          <CardContent>
            <SimpleTable
              head={["Department", "Completed", "On time", "Cycle time", "Passed QA first time", "Overdue now", "Open now"]}
              rows={data.byDepartment.map((row) => [
                row.name,
                row.figures.delivery.completed,
                `${pct(row.figures.delivery.onTime)} (${row.figures.delivery.onTime.of})`,
                days(row.figures.delivery.cycleDays),
                `${pct(row.figures.delivery.firstPass)} (${row.figures.delivery.firstPass.of})`,
                row.figures.workload.overdue,
                row.figures.workload.open,
              ])}
            />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
