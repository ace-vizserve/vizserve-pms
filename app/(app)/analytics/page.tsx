import type { Metadata } from "next";
import { ChartPie, CheckSquare, ListChecks, TriangleAlert } from "lucide-react";

import { departmentPickerScope, requireRole } from "@/lib/auth/authorization";
import {
  summariseWorkload,
  type WorkloadAssignment,
  type WorkloadTask,
} from "@/lib/department-analytics";
import { todayInAppZone } from "@/lib/dates";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { StatTile } from "@/components/stat-tile";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/utils/supabase/server";

import { StageBar, StageLegend } from "../reports/charts";
import { AnalyticsTable, type AnalyticsRow } from "./analytics-table";
import { DepartmentFilter } from "./department-filter";

export const metadata: Metadata = { title: "Department analytics" };

/**
 * PostgREST hands back at most 1,000 rows per request. A department's whole
 * task history passes that, and a silently capped read would under-count every
 * person on the page — so the two unbounded reads below page until they run dry.
 */
const PAGE = 1000;

async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return { data: rows, error: null };
  }
}

/**
 * P11-14 — DEPARTMENT ANALYTICS. Per person, in the departments this viewer
 * leads: how many tasks they are on, how many are finished, how many are late.
 *
 * Every task, not a period. The question is "who is carrying what", and a
 * date window would hide a six-week-old task still sitting on somebody's plate.
 * Subtasks count: each is a piece of assigned work with its own status.
 *
 * ⚠️ THE DEPARTMENT FILTER HERE NARROWS; IT DOES NOT RESTATE RLS. The tasks
 * policy returns more than a lead's departments — any task they are personally
 * on, and shared work in their own department. On a page titled after the
 * department, a task from somewhere else would inflate the numbers, so the
 * reads are cut to `departmentPickerScope`. RLS still runs underneath, which is
 * also why a lead does not see tasks in somebody's personal list (P11-08).
 *
 * Gated at `team_leader`, matching the nav row. A member reading this would get
 * their own tasks plus their department's shared work and take it for the team.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ department?: string }>;
}) {
  const context = await requireRole("team_leader");
  const params = await searchParams;
  const scope = departmentPickerScope(context);

  if (scope.kind === "none") {
    return (
      <PageShell>
        <div className="rounded-lg border bg-card grade-surface shadow-raised-lg">
          <EmptyState
            icon={<ChartPie />}
            title="You do not lead a department yet"
            description="This page shows the departments you manage. Ask an owner to add your departments on Users, then come back."
          />
        </div>
      </PageShell>
    );
  }

  const supabase = await createClient();

  let departmentsQuery = supabase
    .from("vizserve_pms_departments")
    .select("id, name")
    .eq("is_active", true)
    .order("name");
  if (scope.kind === "some") departmentsQuery = departmentsQuery.in("id", scope.ids);

  const departmentsResult = await departmentsQuery;
  const departments = departmentsResult.data ?? [];

  // Checked against what this viewer may read, so a pasted id from another
  // department falls back to all of theirs rather than to an empty page.
  const selected = departments.find((department) => department.id === params.department) ?? null;
  const ids = selected ? [selected.id] : departments.map((department) => department.id);

  const allLabel = scope.kind === "all" ? "All departments" : "All my departments";

  if (departmentsResult.error || ids.length === 0) {
    return (
      <PageShell>
        {departmentsResult.error ? (
          <QueryError what="your departments" message={departmentsResult.error.message} />
        ) : (
          <div className="rounded-lg border bg-card grade-surface shadow-raised-lg">
            <EmptyState
              icon={<ChartPie />}
              title="None of your departments are active"
              description="Every department you manage has been switched off. An owner can turn one back on from the admin screens."
            />
          </div>
        )}
      </PageShell>
    );
  }

  const [tasksResult, assignmentsResult, peopleResult] = await Promise.all([
    readAll<WorkloadTask>((from, to) =>
      supabase
        .from("vizserve_pms_tasks")
        .select("id, status, department_id, due_date, assignee_id")
        .in("department_id", ids)
        // A stable order, or paging can skip and repeat rows between requests.
        .order("id")
        .range(from, to),
    ),

    /*
     * EVERY JOIN ROW THIS VIEWER CAN READ, narrowed in TypeScript rather than in
     * the query. `.in("task_id", taskIds)` would put every task above into the
     * URL, which `lib/reports-server.ts` records breaking at 444 ids; an
     * `!inner` embed on tasks is untyped, because `database.types.ts` declares
     * no relationship for this table. `summariseWorkload` drops any row whose
     * task is not in the list, and the table is two uuids a row.
     */
    readAll<WorkloadAssignment>((from, to) =>
      supabase
        .from("vizserve_pms_task_assignees")
        .select("task_id, user_id")
        .order("task_id")
        .order("user_id")
        .range(from, to),
    ),

    // RLS scopes this to the departments the viewer leads (everybody, for an
    // owner). No `is_active` filter here: this doubles as the NAME lookup, and a
    // deactivated person's finished tasks still deserve a name.
    supabase.from("vizserve_pms_users").select("id, full_name, primary_department_id, is_active"),
  ]);

  const error = tasksResult.error ?? assignmentsResult.error ?? peopleResult.error;

  const people = peopleResult.data ?? [];
  const departmentName = new Map(departments.map((department) => [department.id, department.name]));

  const summary = summariseWorkload({
    tasks: tasksResult.data,
    assignments: assignmentsResult.data,
    // The roster — who gets a row with nothing on it — is ACTIVE people whose
    // home is one of the departments on screen.
    roster: people
      .filter((person) => person.is_active && person.primary_department_id && ids.includes(person.primary_department_id))
      .map((person) => ({
        id: person.id,
        full_name: person.full_name,
        department_id: person.primary_department_id,
      })),
    nameOf: new Map(people.map((person) => [person.id, person.full_name])),
    today: todayInAppZone(),
  });

  const rows: AnalyticsRow[] = summary.rows.map((row) => ({
    ...row,
    departmentName: row.departmentId ? (departmentName.get(row.departmentId) ?? null) : null,
  }));

  const { totals } = summary;
  const busy = rows.filter((row) => row.total > 0);

  return (
    <PageShell>
      {departments.length > 1 ? <DepartmentFilter departments={departments} allLabel={allLabel} /> : null}

      {error ? (
        <QueryError what="department analytics" message={error.message} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Tasks"
              value={totals.total}
              hint={
                summary.unassigned > 0
                  ? `${summary.unassigned} with nobody on them`
                  : `Every task in ${selected ? selected.name : allLabel.toLowerCase()}`
              }
              icon={<ListChecks />}
              tone="info"
            />
            <StatTile
              label="Still open"
              value={totals.notStarted + totals.active}
              hint={`${totals.notStarted} not started · ${totals.active} in progress`}
              icon={<ListChecks />}
            />
            <StatTile
              label="Completed"
              value={totals.completed}
              hint={
                totals.total > 0
                  ? `${Math.round((totals.completed / totals.total) * 100)}% of all tasks`
                  : "Nothing to complete yet"
              }
              icon={<CheckSquare />}
              tone={totals.completed > 0 ? "success" : undefined}
            />
            <StatTile
              label="Overdue now"
              value={totals.overdue}
              hint="Past due and still open, as of today"
              icon={<TriangleAlert />}
              tone={totals.overdue > 0 ? "warning" : undefined}
            />
          </div>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Tasks by stage, per person</CardTitle>
              <CardDescription className="text-xs">
                Everybody on a task counts it, so a shared task appears on each of their bars. The
                exact figures are in the table below.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <StageLegend notStarted={totals.notStarted} active={totals.active} done={totals.completed} />

              {busy.length === 0 ? (
                <p className="py-4 text-xs text-muted-foreground">
                  Nobody has a task yet. Tasks appear here as soon as somebody is put on one.
                </p>
              ) : (
                <div className="space-y-2">
                  {busy.map((row) => (
                    <StageBar
                      key={row.id}
                      label={row.name}
                      notStarted={row.notStarted}
                      active={row.active}
                      done={row.completed}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Every figure, per person</h2>
            <AnalyticsTable rows={rows} />
          </div>
        </>
      )}
    </PageShell>
  );
}
