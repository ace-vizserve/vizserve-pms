import { Suspense } from "react";
import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { departmentScopeFilter, requireRole, type AuthContext } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { TASK_PRIORITY_LABELS } from "@/lib/schemas/tasks";
import { loadDepartmentOptions, loadPerformance, type PerformanceFilters as PerformanceFilterValues } from "@/lib/performance-server";

import { AnalyticsTabs } from "../analytics-tabs";
import { LoadErrors, periodLabel, FiguresSkeleton } from "../figures";
import { readAnalyticsFilters, type AnalyticsSearch } from "../params";
import { PerformanceFilters } from "../performance-filters";
import { PeopleTable } from "./people-table";
import { averageRow, personRow } from "./rows";

export const metadata: Metadata = { title: "People" };

const KIND_LABELS = { client: "Client work", internal: "Internal work", personal: "Personal tasks" } as const;

/**
 * P15-02 — EVERY PERSON IN SCOPE, EVERY MEASURE, against the average.
 *
 * Team leaders see their departments; Manager and up, everyone. A number
 * clearly worse than the average (by more than a quarter) is marked with a
 * word as well as a colour. Click a name for that person's full page.
 */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
  const context = await requireRole("team_leader");
  const today = todayInAppZone();
  const filters = readAnalyticsFilters(await searchParams, today);
  // P15-02 — the bar renders from this cheap read; the figures stream below it.
  const { departments } = await loadDepartmentOptions(context);
  const period = { from: filters.from, to: filters.to };

  return (
    <PageShell className="gap-3">
      <AnalyticsTabs />
      <PerformanceFilters
        basePath="/analytics/people"
        from={filters.from}
        to={filters.to}
        today={today}
        departments={departments}
        allLabel={departmentScopeFilter(context) === null ? "All departments" : "All my departments"}
        previousLabel={`${periodLabel(period)}. Open and overdue are as of today; everything else is for the period.`}
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
  const departmentName = new Map(data.departments.map((department) => [department.id, department.name]));

  const rows = data.people.map((person) =>
    personRow(person, person.departmentId ? (departmentName.get(person.departmentId) ?? null) : null),
  );

  // P15-09 — the filters in words, for the PDF's header.
  const scope = [
    filters.departmentId ? (departmentName.get(filters.departmentId) ?? "One department") : "All departments",
    filters.kind ? KIND_LABELS[filters.kind] : null,
    filters.priority ? `${TASK_PRIORITY_LABELS[filters.priority as keyof typeof TASK_PRIORITY_LABELS] ?? filters.priority} priority` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <LoadErrors errors={data.errors} />
      <PeopleTable rows={rows} average={averageRow(rows)} report={{ from: filters.from, to: filters.to, scope }} />
      <p className="text-2xs text-muted-foreground">
        ▾ marks a figure clearly worse than the department average. Late and absent are blank for anyone with no fixed
        hours on record. Hover a percentage to see how many it was out of.
      </p>
    </>
  );
}
