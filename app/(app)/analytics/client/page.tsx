import { Suspense } from "react";
import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { RequestStatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { departmentScopeFilter, requireRole } from "@/lib/auth/authorization";
import { loadDepartmentOptions, type PerformanceFilters as PerformanceFilterValues } from "@/lib/performance-server";
import type { VizservePmsRequestStatus } from "@/lib/database.types";
import { addDays, todayInAppZone } from "@/lib/dates";
import { earlierNote, previousPeriod, RECORDS_START } from "@/lib/performance";
import {
  loadClientEngagement,
  loadFeedback,
  loadGateOne,
  loadNegotiation,
  loadRatingsByPerson,
  loadTurnaround,
  loadTurnaroundStandard,
} from "@/lib/reports-server";
import { createClient } from "@/utils/supabase/server";

import { EngagementCard, FeedbackCard, NegotiationCard, TurnaroundCard } from "../../reports/metric-cards";
import { RatingsCard } from "../../reports/ratings-card";
import { AnalyticsTabs } from "../analytics-tabs";
import { Delta, Figure, FiguresSkeleton, hoursValue, periodLabel } from "../figures";
import { readAnalyticsFilters, type AnalyticsSearch } from "../params";
import { PerformanceFilters } from "../performance-filters";

export const metadata: Metadata = { title: "Client results" };

/**
 * P15-02 — CLIENT RESULTS, which was /reports (P6-04..P7-80).
 *
 * Everything about the client request flow: intake, how Gate 1 answers, how
 * long delivery takes and whether it met the form's standard, whether Gate 1
 * negotiates, what clients said and how they rated the work. The task and hours
 * charts that /reports also carried now live on Delivery & quality and Time &
 * attendance, where they are not duplicated.
 *
 * No department filter in the queries: the policies scope every table, and a
 * chosen department narrows what they returned, in memory.
 */
export default async function ClientResultsPage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
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
        basePath="/analytics/client"
        from={filters.from}
        to={filters.to}
        today={today}
        departments={departments}
        allLabel={departmentScopeFilter(context) === null ? "All departments" : "All my departments"}
        showKind={false}
        showPriority={false}
        previousLabel={`${periodLabel(period)}, compared with ${periodLabel(previous)}.`}
      />
      <Suspense key={JSON.stringify(filters)} fallback={<FiguresSkeleton />}>
        <Body departments={departments} filters={filters} />
      </Suspense>
    </PageShell>
  );
}

async function Body({
  departments,
  filters,
}: {
  departments: { id: string; name: string }[];
  filters: PerformanceFilterValues;
}) {
  const supabase = await createClient();
  const selected = departments.find((department) => department.id === filters.departmentId) ?? null;
  const departmentIds = selected ? [selected.id] : undefined;

  const period = { from: filters.from, to: filters.to, departmentIds };
  const previous = { ...previousPeriod(period), departmentIds };
  const inverted = filters.from > filters.to;
  const unavailable = earlierNote(previous, RECORDS_START.client);

  const [requests, gate, gateBefore, standard, standardBefore, turnaround, negotiation, engagement, feedback, ratings] =
    await Promise.all([
      supabase
        .from("vizserve_pms_requests")
        .select("status, vizserve_pms_forms(department_id)")
        .gte("created_at", filters.from)
        .lt("created_at", addDays(filters.to, 1) ?? filters.to),
      loadGateOne(supabase, period),
      loadGateOne(supabase, previous),
      loadTurnaroundStandard(supabase, period),
      loadTurnaroundStandard(supabase, previous),
      loadTurnaround(supabase, period),
      loadNegotiation(supabase, period),
      loadClientEngagement(supabase, period),
      loadFeedback(supabase, period),
      loadRatingsByPerson(supabase, period),
    ]);

  const counts = new Map<VizservePmsRequestStatus, number>();
  for (const row of (requests.data ?? []) as unknown as {
    status: VizservePmsRequestStatus;
    vizserve_pms_forms: { department_id: string | null } | null;
  }[]) {
    if (departmentIds && !departmentIds.includes(row.vizserve_pms_forms?.department_id ?? "")) continue;
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const intake = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const standardRate = standard.of === 0 ? null : Math.round((standard.met / standard.of) * 100);
  const standardBeforeRate = standardBefore.of === 0 ? null : Math.round((standardBefore.met / standardBefore.of) * 100);

  return (
    <>
      {inverted ? (
        <p className="rounded-lg border bg-card p-6 text-sm">
          That period runs backwards — swap the two dates.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <Figure label="Requests received" value={intake} hint="Submitted through a client form" />
            <Figure
              label="Gate 1 answer time"
              value={hoursValue(gate.medianHours)}
              hint={`Median, submitted to decided · ${gate.reviewed} decided`}
              delta={<Delta unavailable={unavailable} now={gate.medianHours} before={gateBefore.medianHours} better="down" format={hoursValue} />}
            />
            <Figure
              label="Waiting at Gate 1 now"
              value={gate.pendingNow}
              hint={
                gate.oldestPendingDays === null
                  ? "Nothing waiting"
                  : `Oldest has waited ${hoursValue(gate.oldestPendingDays * 24)}`
              }
              tone={gate.pendingNow > 0 ? "warning" : undefined}
            />
            <Figure
              label="Approved at Gate 1"
              value={gate.reviewed === 0 ? "—" : `${Math.round((gate.approved / gate.reviewed) * 100)}%`}
              hint={`${gate.approved} approved · ${gate.returned} returned · ${gate.rejected} rejected`}
            />
            <Figure
              label="Delivered within standard"
              value={standardRate === null ? "—" : `${standardRate}%`}
              hint={
                standard.of === 0
                  ? "No client work finished in the period"
                  : `${standard.met} of ${standard.of}, in working days from submission`
              }
              delta={<Delta unavailable={unavailable} now={standardRate} before={standardBeforeRate} better="up" unit=" pts" />}
            />
            <Figure
              label="Client approval rate"
              value={
                engagement.approved + engagement.revisionRequested === 0
                  ? "—"
                  : `${Math.round((engagement.approved / (engagement.approved + engagement.revisionRequested)) * 100)}%`
              }
              hint={`${engagement.approved} approved · ${engagement.revisionRequested} asked for changes`}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <TurnaroundCard data={turnaround} />
            <NegotiationCard data={negotiation} />
            <EngagementCard data={engagement} />
            <FeedbackCard data={feedback} />
          </div>

          <RatingsCard data={ratings} />

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Requests by status</CardTitle>
              <CardDescription className="text-xs">Submitted in this period. {intake} in total.</CardDescription>
            </CardHeader>
            <CardContent>
              {intake === 0 ? (
                <p className="text-xs text-muted-foreground">No client requests were submitted in this period.</p>
              ) : (
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {[...counts.entries()]
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
        </>
      )}
    </>
  );
}
