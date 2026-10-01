import { Suspense } from "react";
import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { departmentScopeFilter, requireRole, type AuthContext } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { percent, previousPeriod } from "@/lib/performance";
import { loadDepartmentOptions, loadPerformance, type PerformanceFilters as PerformanceFilterValues, type TeamFigures } from "@/lib/performance-server";

import { BarRow } from "../../reports/charts";
import { AnalyticsTabs } from "../analytics-tabs";
import { Delta, Figure, hours, LoadErrors, pct, periodLabel, SimpleTable, FiguresSkeleton } from "../figures";
import { readAnalyticsFilters, type AnalyticsSearch } from "../params";
import { PerformanceFilters } from "../performance-filters";

export const metadata: Metadata = { title: "Time & attendance" };

const onTimeRate = (figures: TeamFigures) => ({
  hit: figures.compliance.onTime,
  of: figures.compliance.expected,
});

/**
 * P15-02 — WHERE THE HOURS WENT, AND DID PEOPLE SHOW UP AND FILE.
 *
 * People are counted by their HOME department, whatever the HR tick lets the
 * viewer read. Attendance uses `/hr/attendance`'s definitions exactly, through
 * the same function, so the two screens cannot disagree.
 */
export default async function TimePage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
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
        basePath="/analytics/time"
        from={filters.from}
        to={filters.to}
        today={today}
        departments={departments}
        allLabel={departmentScopeFilter(context) === null ? "All departments" : "All my departments"}
        previousLabel={`${periodLabel(period)}, compared with ${periodLabel(previous)}. Kind and priority narrow the hours only; attendance and timesheets are about the person.`}
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
  const { team: now, teamBefore: before } = data;

  const kinds = [
    { label: "Client work", minutes: now.time.byKind.client },
    { label: "Internal work", minutes: now.time.byKind.internal },
    { label: "Personal tasks", minutes: now.time.byKind.personal },
  ];
  const maxKind = Math.max(0, ...kinds.map((kind) => kind.minutes)) / 60;
  const topLists = data.listHours.slice(0, 10);
  const maxList = topLists.length > 0 ? topLists[0]!.minutes / 60 : 0;

  return (
    <>
      <LoadErrors errors={data.errors} />

      <h2 className="text-sm font-semibold">Hours</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Hours logged"
          value={hours(now.time.minutes)}
          hint={`${hours(now.time.byKind.client)} client · ${hours(now.time.byKind.internal)} internal`}
          delta={<Delta now={now.time.minutes / 60} before={before.time.minutes / 60} better="up" unit="h" />}
        />
        <Figure
          label="Clocked-in time accounted for"
          value={pct(now.time.accounted)}
          hint={`${hours(now.time.accounted.hit)} logged of ${hours(now.time.clockedMinutes)} on the DTR, after breaks`}
          delta={<Delta now={percent(now.time.accounted)} before={percent(before.time.accounted)} better="up" unit=" pts" />}
        />
        <Figure
          label="Overtime approved"
          value={hours(now.overtimeMinutes)}
          delta={<Delta now={now.overtimeMinutes / 60} before={before.overtimeMinutes / 60} better="down" unit="h" />}
        />
        <Figure
          label="Leave days"
          value={now.attendance.onLeave}
          hint="Approved leave on working days"
          delta={<Delta now={now.attendance.onLeave} before={before.attendance.onLeave} better="down" />}
        />
      </div>

      <h2 className="text-sm font-semibold">Timesheets</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Submitted on time"
          value={pct(onTimeRate(now))}
          hint={`${now.compliance.onTime} of ${now.compliance.expected} weeks, by the Monday after`}
          delta={<Delta now={percent(onTimeRate(now))} before={percent(onTimeRate(before))} better="up" unit=" pts" />}
        />
        <Figure
          label="Never submitted"
          value={now.compliance.missing}
          hint="Finished weeks with nothing filed"
          tone={now.compliance.missing > 0 ? "warning" : undefined}
          delta={<Delta now={now.compliance.missing} before={before.compliance.missing} better="down" />}
        />
        <Figure
          label="Sent back"
          value={now.compliance.returned}
          hint="Weeks the manager returned"
          delta={<Delta now={now.compliance.returned} before={before.compliance.returned} better="down" />}
        />
        <Figure label="Weeks expected" value={now.compliance.expected} hint="Ended, and not a full week of leave" />
      </div>

      <h2 className="text-sm font-semibold">Attendance</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Figure
          label="Late arrivals"
          value={now.attendance.late}
          hint={`${hours(now.attendance.lateMinutes)} late in total · more than ${data.graceMinutes} min past the start`}
          tone={now.attendance.late > 0 ? "warning" : undefined}
          delta={<Delta now={now.attendance.late} before={before.attendance.late} better="down" />}
        />
        <Figure
          label="Absent"
          value={now.attendance.absent}
          hint="Working days with no time-in and no leave"
          tone={now.attendance.absent > 0 ? "warning" : undefined}
          delta={<Delta now={now.attendance.absent} before={before.attendance.absent} better="down" />}
        />
        <Figure
          label="Left early"
          value={now.attendance.undertime}
          hint="Clock-outs before the end, allowing for overtime"
          delta={<Delta now={now.attendance.undertime} before={before.attendance.undertime} better="down" />}
        />
        <Figure
          label="Missing clock-outs"
          value={now.missingPunches}
          hint="Past days with a time-in and no time-out"
          delta={<Delta now={now.missingPunches} before={before.missingPunches} better="down" />}
        />
        <Figure
          label="Time corrections asked"
          value={now.corrections}
          delta={<Delta now={now.corrections} before={before.corrections} better="down" />}
        />
      </div>
      <p className="text-2xs text-muted-foreground">
        Counted for {now.attendance.scheduledPeople} {now.attendance.scheduledPeople === 1 ? "person" : "people"} with fixed hours on
        record, over {now.attendance.workingDays} working days. Weekends and holidays are never absence; anyone with no
        schedule is not judged — the same rules as HR&rsquo;s attendance screen.
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Hours by kind of work</CardTitle>
          </CardHeader>
          <CardContent>
            {maxKind === 0 ? (
              <p className="text-xs text-muted-foreground">No time logged in this period.</p>
            ) : (
              <div className="space-y-2">
                {kinds.map((kind) => (
                  <BarRow key={kind.label} label={kind.label} value={Math.round((kind.minutes / 60) * 10) / 10} max={Math.round(maxKind * 10) / 10} unit="h" />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Hours by list</CardTitle>
            <CardDescription className="text-xs">The ten lists with the most time logged.</CardDescription>
          </CardHeader>
          <CardContent>
            {topLists.length === 0 ? (
              <p className="text-xs text-muted-foreground">No time logged in this period.</p>
            ) : (
              <div className="space-y-2">
                {topLists.map((list) => (
                  <BarRow key={list.id} label={list.name} value={Math.round((list.minutes / 60) * 10) / 10} max={Math.round(maxList * 10) / 10} unit="h" />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {data.byDepartment.length > 1 ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Departments side by side</CardTitle>
          </CardHeader>
          <CardContent>
            <SimpleTable
              head={["Department", "People", "Hours", "Accounted for", "Timesheets on time", "Late", "Absent"]}
              rows={data.byDepartment.map((row) => [
                row.name,
                row.people,
                hours(row.figures.time.minutes),
                pct(row.figures.time.accounted),
                pct(onTimeRate(row.figures)),
                row.figures.attendance.late,
                row.figures.attendance.absent,
              ])}
            />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
