import { Suspense } from "react";
import { ArrowLeft, UserCog } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  canAccessDepartment,
  canEditUser,
  canManageUsers,
  requireRole,
} from "@/lib/auth/authorization";
import type { Role } from "@/lib/auth/roles";
import { todayInAppZone } from "@/lib/dates";
import { percent } from "@/lib/performance";
import { loadPerformance } from "@/lib/performance-server";
import { ROLE_LABELS } from "@/lib/schemas/users";
import { cn } from "@/lib/utils";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

import { BarRow } from "../../../reports/charts";
import { days, Delta, Figure, FiguresSkeleton, hours, LoadErrors, pct, periodLabel } from "../../figures";
import { readAnalyticsFilters, type AnalyticsSearch } from "../../params";
import { PerformanceFilters } from "../../performance-filters";
import { averageRow, personRow } from "../rows";
import { resolvePage, resolvePageSize } from "@/components/pagination";
import { ActivitySection, RequestsSection, TasksSection, TimesheetsSection, type Paging } from "./sections";

export const metadata: Metadata = { title: "Person" };

const VIEWS = [
  { key: "performance", label: "Performance" },
  { key: "tasks", label: "Tasks" },
  { key: "timesheets", label: "Timesheets" },
  { key: "requests", label: "Requests" },
  { key: "activity", label: "Activity", managerOnly: true },
] as const;

type View = (typeof VIEWS)[number]["key"];

/**
 * P15-02 / P15-03 — ONE PERSON, EVERYTHING ABOUT THEM.
 *
 * Their figures against their department's average and the previous period,
 * and the records behind them: tasks, timesheets, requests, and — Manager and
 * above — what they did in the app and what was changed on their account.
 *
 * SCOPE: a Team Leader opens people in the departments they lead; Manager and
 * up, anyone. Decided by `canAccessDepartment` on the ACTIVE role, so the HR
 * tick does not widen it.
 */
export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<AnalyticsSearch & { view?: string; show?: string; sub?: string; page?: string; size?: string }>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  const { data: person } = await supabase
    .from("vizserve_pms_users")
    .select("id, full_name, email, role, primary_department_id, is_active, is_hr")
    .eq("id", id)
    .maybeSingle();

  if (!person) notFound();
  if (person.id !== context.userId && !canAccessDepartment(context, person.primary_department_id)) notFound();

  const isManager = canManageUsers(context);
  const views = VIEWS.filter((view) => !("managerOnly" in view) || isManager);
  const view: View = views.find((candidate) => candidate.key === search.view)?.key ?? "performance";

  const [{ data: department }, { data: held }] = await Promise.all([
    person.primary_department_id
      ? supabase.from("vizserve_pms_departments").select("name").eq("id", person.primary_department_id).maybeSingle()
      : Promise.resolve({ data: null }),
    // Held roles are readable by Admin and up under RLS; read for display only.
    createAdminClient().from("vizserve_pms_user_roles").select("role").eq("user_id", id),
  ]);
  const roles = ((held ?? []).map((row) => row.role) as Role[]).sort();
  const editable = isManager && canEditUser(context, { id, roles: roles.length > 0 ? roles : [person.role] });

  // Switching section drops what belongs to the old one: its toggle, sub-tab and page.
  const query = (next: Record<string, string>) => {
    const merged = new URLSearchParams();
    for (const [key, value] of Object.entries(search))
      if (typeof value === "string" && !["show", "sub", "page"].includes(key)) merged.set(key, value);
    for (const [key, value] of Object.entries(next)) merged.set(key, value);
    return `?${merged.toString()}`;
  };

  const basePath = `/analytics/people/${id}`;
  const paging: Paging = {
    page: resolvePage(search.page),
    pageSize: resolvePageSize(search.size),
    basePath,
    href: (next) => {
      const merged = new URLSearchParams();
      for (const [key, value] of Object.entries(search)) if (typeof value === "string") merged.set(key, value);
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined) merged.delete(key);
        else merged.set(key, value);
      }
      const qs = merged.toString();
      return qs ? `${basePath}?${qs}` : basePath;
    },
  };

  return (
    <PageShell className="gap-3">
      <BreadcrumbLabel value={person.full_name} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/analytics/people"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            People
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{person.full_name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {(roles.length > 0 ? roles : [person.role]).map((role) => ROLE_LABELS[role].label).join(" · ")}
            {person.is_hr ? " · HR" : ""}
            {department?.name ? ` · ${department.name}` : ""}
            {person.is_active ? "" : " · Deactivated"}
          </p>
        </div>
        {editable ? (
          <Link href="/admin/users" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <UserCog aria-hidden />
            Manage in Users
          </Link>
        ) : null}
      </div>

      <nav aria-label="Sections" className="flex gap-1 overflow-x-auto border-b">
        {views.map((candidate) => (
          <Link
            key={candidate.key}
            href={query({ view: candidate.key })}
            aria-current={candidate.key === view ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm",
              candidate.key === view
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {candidate.label}
          </Link>
        ))}
      </nav>

      {/* P15-02 — the header and sections render at once; the section's data
          streams in, and a new section or filter shows the skeleton at once. */}
      <Suspense key={JSON.stringify(search)} fallback={<FiguresSkeleton />}>
      {view === "performance" ? (
        <Performance context={context} personId={id} departmentId={person.primary_department_id} search={search} />
      ) : view === "tasks" ? (
        <TasksSection userId={id} show={search.show === "all" ? "all" : "open"} paging={paging} />
      ) : view === "timesheets" ? (
        <TimesheetsSection userId={id} paging={paging} />
      ) : view === "requests" ? (
        <RequestsSection userId={id} sub={search.sub === "gate1" ? "gate1" : "filed"} paging={paging} />
      ) : (
        <ActivitySection userId={id} sub={search.sub === "account" ? "account" : "did"} paging={paging} />
      )}
      </Suspense>
    </PageShell>
  );
}

async function Performance({
  context,
  personId,
  departmentId,
  search,
}: {
  context: Awaited<ReturnType<typeof requireRole>>;
  personId: string;
  departmentId: string | null;
  search: AnalyticsSearch;
}) {
  const today = todayInAppZone();
  const filters = { ...readAnalyticsFilters(search, today), departmentId };
  const data = await loadPerformance(context, filters);
  const me = data.people.find((row) => row.userId === personId);
  const before = data.peopleBefore.get(personId);

  if (!me) {
    return (
      <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        No figures for this person: they have no department, or are deactivated. Their tasks, timesheets and
        requests are still in the other sections.
      </p>
    );
  }

  const departmentName = data.selected?.name ?? null;
  const rows = data.people.map((row) => personRow(row, departmentName));
  const average = averageRow(rows);
  const mine = personRow(me, departmentName);
  const avg = (value: number | null, digits = 0, unit = "") =>
    value === null ? "no department average" : `department average ${value.toFixed(digits)}${unit}`;

  return (
    <div className="grid gap-3">
      <PerformanceFilters
        basePath={`/analytics/people/${personId}`}
        from={filters.from}
        to={filters.to}
        today={today}
        departments={[]}
        allLabel=""
        previousLabel={`${periodLabel(data.period)}, compared with ${periodLabel(data.previous)} and with the ${departmentName ?? "department"} average.`}
      />
      <LoadErrors errors={data.errors} />

      <h2 className="text-sm font-semibold">Work</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Open now" value={me.workload.open} hint={`${me.workload.dueSoon} due this week · ${avg(average.open, 1)}`} />
        <Figure
          label="Overdue now"
          value={me.workload.overdue}
          hint={avg(average.overdue, 1)}
          tone={me.workload.overdue > 0 ? "warning" : undefined}
        />
        <Figure
          label="Completed"
          value={me.delivery.completed}
          hint={avg(average.completed, 1)}
          delta={<Delta unavailable={data.earlier.tasks} now={me.delivery.completed} before={before?.delivery.completed ?? null} better="up" />}
        />
        <Figure
          label="On time"
          value={pct(me.delivery.onTime)}
          hint={`${me.delivery.onTime.hit} of ${me.delivery.onTime.of} · ${avg(average.onTime, 0, "%")}`}
          delta={
            <Delta unavailable={data.earlier.tasks} now={percent(me.delivery.onTime)} before={before ? percent(before.delivery.onTime) : null} better="up" unit=" pts" />
          }
        />
        <Figure
          label="Cycle time"
          value={days(me.delivery.cycleDays)}
          hint={`Median · ${avg(average.cycleDays, 1, "d")}`}
          delta={<Delta unavailable={data.earlier.tasks} now={me.delivery.cycleDays} before={before?.delivery.cycleDays ?? null} better="down" format={(value) => days(value)} />}
        />
        <Figure
          label="Passed QA first time"
          value={pct(me.delivery.firstPass)}
          hint={`${me.delivery.firstPass.hit} of ${me.delivery.firstPass.of} · ${avg(average.firstPass, 0, "%")}`}
          delta={
            <Delta unavailable={data.earlier.tasks} now={percent(me.delivery.firstPass)} before={before ? percent(before.delivery.firstPass) : null} better="up" unit=" pts" />
          }
        />
        <Figure
          label="QA reviews they did"
          value={me.reviews}
          hint={avg(average.reviews, 1)}
          delta={<Delta unavailable={data.earlier.tasks} now={me.reviews} before={before?.reviews ?? null} better="up" />}
        />
        <Figure
          label="Client rating"
          value={me.rating.average === null ? "—" : `${me.rating.average.toFixed(1)} / 5`}
          hint={`${me.rating.count} ${me.rating.count === 1 ? "rating" : "ratings"} · ${me.clientRevisions} client revision${me.clientRevisions === 1 ? "" : "s"}`}
        />
      </div>

      <h2 className="text-sm font-semibold">Time and attendance</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Hours logged"
          value={hours(me.time.minutes)}
          hint={`${hours(me.time.byKind.client)} client · ${hours(me.time.byKind.internal)} internal`}
          delta={<Delta unavailable={data.earlier.time} now={me.time.minutes / 60} before={before ? before.time.minutes / 60 : null} better="up" unit="h" />}
        />
        <Figure
          label="Clocked time logged"
          value={pct(me.time.accounted)}
          hint={`${hours(me.time.clockedMinutes)} on the DTR · ${avg(average.accounted, 0, "%")}`}
        />
        <Figure
          label="Timesheets on time"
          value={mine.timesheetsOnTime === null ? "—" : `${mine.timesheetsOnTime}%`}
          hint={`${me.compliance.onTime} of ${me.compliance.expected} weeks · ${me.compliance.missing} missing · ${me.compliance.returned} sent back`}
          tone={me.compliance.missing > 0 ? "warning" : undefined}
        />
        <Figure
          label="Late arrivals"
          value={me.attendance && !me.attendance.unscheduled ? me.attendance.late : "—"}
          hint={
            me.attendance && !me.attendance.unscheduled
              ? `${hours(me.attendance.lateMinutes)} in total · ${avg(average.late, 1)}`
              : "No fixed hours on record"
          }
          delta={
            me.attendance && !me.attendance.unscheduled ? (
              <Delta unavailable={data.earlier.time} now={me.attendance.late} before={before?.attendance?.late ?? null} better="down" />
            ) : undefined
          }
        />
        <Figure
          label="Absent"
          value={me.attendance && !me.attendance.unscheduled ? me.attendance.absent : "—"}
          hint={
            me.attendance && !me.attendance.unscheduled
              ? `of ${me.attendance.workingDays} working days · ${me.attendance.onLeave} on leave`
              : "No fixed hours on record"
          }
          tone={me.attendance && me.attendance.absent > 0 ? "warning" : undefined}
        />
        <Figure label="Left early" value={me.attendance && !me.attendance.unscheduled ? me.attendance.undertime : "—"} />
        <Figure label="Missing clock-outs" value={me.missingPunches} hint={`${me.corrections} time corrections asked`} />
        <Figure label="Overtime approved" value={hours(me.overtimeMinutes)} />
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Where their time went</CardTitle>
          <CardDescription className="text-xs">Hours logged in the period, by kind of work.</CardDescription>
        </CardHeader>
        <CardContent>
          {me.time.minutes === 0 ? (
            <p className="text-xs text-muted-foreground">No time logged in this period.</p>
          ) : (
            <div className="space-y-2">
              {(
                [
                  ["Client work", me.time.byKind.client],
                  ["Internal work", me.time.byKind.internal],
                  ["Personal tasks", me.time.byKind.personal],
                ] as const
              ).map(([label, minutes]) => (
                <BarRow
                  key={label}
                  label={label}
                  value={Math.round((minutes / 60) * 10) / 10}
                  max={Math.round((Math.max(me.time.byKind.client, me.time.byKind.internal, me.time.byKind.personal) / 60) * 10) / 10}
                  unit="h"
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
