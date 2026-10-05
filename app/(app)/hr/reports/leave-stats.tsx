import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { sumDays, summariseLeave, type LeaveReportStatRow } from "@/lib/leave-stats";
import type { createClient } from "@/utils/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { BarRow } from "../../reports/charts";
import { Figure, LoadErrors, SimpleTable } from "../../analytics/figures";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` for the last day of a month. Plain arithmetic, no Date. */
function lastDay(year: number, month: number): string {
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${year}-${String(month).padStart(2, "0")}-${days[month - 1]}`;
}

const pct = (value: number | null) => (value === null ? "—" : `${value}%`);

/**
 * P15-13 — the year at a glance, above the two printable documents.
 *
 * Read through the same two functions the PDFs use, so a figure here and the
 * same figure in a filed audit cannot disagree. Both are scope-checked inside:
 * HR and Manager-and-above get everybody, a lead their own departments.
 */
export async function LeaveStats({
  supabase,
  year,
  currentYear,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  year: number;
  currentYear: number;
}) {
  const [report, pending, ...months] = await Promise.all([
    supabase.rpc("vizserve_pms_leave_report", { p_year: year }),
    supabase
      .from("vizserve_pms_internal_requests")
      .select("id", { count: "exact", head: true })
      .eq("request_type", "LEAVE")
      .eq("status", "PENDING_REVIEW")
      .gte("start_date", `${year}-01-01`)
      .lte("start_date", `${year}-12-31`),
    // One overlap read per month, so leave crossing a month end is split across
    // both rather than counted where it started.
    ...MONTHS.map((_, index) =>
      supabase.rpc("vizserve_pms_leave_taken", {
        p_from: `${year}-${String(index + 1).padStart(2, "0")}-01`,
        p_to: lastDay(year, index + 1),
      }),
    ),
  ]);

  const errors = [report.error, pending.error, ...months.map((month) => month.error)]
    .filter((error): error is NonNullable<typeof error> => Boolean(error))
    .map((error) => error.message);

  const stats = summariseLeave((report.data ?? []) as LeaveReportStatRow[]);
  const byMonth = months.map((month) => sumDays((month.data ?? []) as { days: number | string }[]));
  const monthMax = Math.max(0, ...byMonth);
  const typeMax = Math.max(0, ...stats.byType.map((type) => type.used));

  const yearHref = (target: number) => (target === currentYear ? "/hr/reports" : `/hr/reports?year=${target}`);

  return (
    <section aria-labelledby="leave-stats-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="leave-stats-heading" className="text-sm font-semibold">
          Leave in {year}
        </h2>
        {/* Real links, so a year is shareable. */}
        <div className="flex items-center gap-1.5">
          <Link
            href={yearHref(year - 1)}
            aria-label={`Go to ${year - 1}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronLeft />
          </Link>
          <span className="min-w-14 text-center text-sm font-semibold tabular-nums">{year}</span>
          <Link
            href={yearHref(year + 1)}
            aria-label={`Go to ${year + 1}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronRight />
          </Link>
        </div>
      </div>

      <LoadErrors errors={errors} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Figure label="Days taken" value={stats.used} hint="Approved, counted in the year it starts" />
        <Figure
          label="Regular leave allocated"
          value={stats.regularAllocated}
          hint="Vacation, sick, service incentive, birthday"
        />
        <Figure label="Regular leave remaining" value={stats.regularRemaining} />
        <Figure
          label="Regular leave used"
          value={pct(stats.regularUsedPercent)}
          hint="Maternity, paternity and other life-event leave left out"
        />
        <Figure
          label="People who took leave"
          value={`${stats.peopleWhoTookLeave} of ${stats.people}`}
        />
        <Figure
          label="Pending requests"
          value={pending.count ?? 0}
          hint="Leave starting this year, not yet decided"
          tone={(pending.count ?? 0) > 0 ? "warning" : undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Days taken by month</CardTitle>
            <CardDescription className="text-xs">
              Leave crossing a month end counts in both months. Totals can differ from &ldquo;Days
              taken&rdquo; by leave that crosses New Year.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {MONTHS.map((label, index) => (
              <BarRow key={label} label={label} value={byMonth[index]} max={monthMax} unit="days" />
            ))}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Days taken by leave type</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.byType.length === 0 ? (
              <p className="text-xs text-muted-foreground">No leave types.</p>
            ) : (
              stats.byType.map((type) => (
                <BarRow
                  key={type.id}
                  label={type.label}
                  note={`${type.allocated} allocated · ${pct(type.usedPercent)} used`}
                  value={type.used}
                  max={typeMax}
                  unit="days"
                  tone="chart-2"
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">By department</CardTitle>
          </CardHeader>
          <CardContent>
            <SimpleTable
              head={["Department", "People", "Days taken", "Per person"]}
              rows={stats.byDepartment.map((department) => [
                department.name,
                department.people,
                department.used,
                department.perPerson,
              ])}
            />
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Most leave taken</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.topTakers.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nobody has taken leave in {year}.</p>
            ) : (
              <SimpleTable
                head={["Person", "Department", "Days taken"]}
                rows={stats.topTakers.map((person) => [
                  person.name,
                  person.department ?? "—",
                  person.used,
                ])}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
