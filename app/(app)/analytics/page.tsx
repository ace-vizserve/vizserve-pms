import type { Metadata } from "next";
import { ChartPie, CheckSquare, FileBarChart, ListChecks, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { departmentPickerScope, requireRole } from "@/lib/auth/authorization";
import {
  summariseWorkload,
  type WorkloadAssignment,
  type WorkloadTask,
} from "@/lib/department-analytics";
import { formatDate, isDateOnly, todayInAppZone } from "@/lib/dates";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { StatTile } from "@/components/stat-tile";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/utils/supabase/server";

import { StageLegend } from "../reports/charts";
import { AnalyticsTable, type AnalyticsRow } from "./analytics-table";
import { AnalyticsFilters } from "./filters";
import { PersonBar } from "./person-bar";
import { StageDonut, type DonutSubject } from "./stage-donut";

export const metadata: Metadata = { title: "Department analytics" };

/**
 * PostgREST hands back at most 1,000 rows per request. A department's whole
 * task history passes that, and a silently capped read would under-count every
 * person on the page — so the two unbounded reads below page until they run dry.
 */
const PAGE = 1000;

/**
 * How many task ids go into one `.in(...)`.
 *
 * TWO CEILINGS, AND THIS SITS UNDER BOTH. `lib/reports-server.ts` records the
 * URL breaking at 444 ids; 100 uuids is about 3.7 KB of query string, nowhere
 * near it. The lower ceiling is the one that actually bit: Postgres cancels a
 * statement that runs too long, and the per-row cost here is an RLS policy
 * calling a SECURITY DEFINER function. Splitting the work across statements
 * keeps every one of them short, and they are fired together.
 */
const ID_CHUNK = 100;

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

/**
 * ⚠️ THE PAGES AFTER THE FIRST ARE FETCHED IN PARALLEL, not in a loop.
 *
 * This used to walk the ranges one at a time, waiting for each before asking
 * for the next. On the unfiltered view — every department, no period — that is
 * four round trips for the tasks and four more for the assignments, all of them
 * in series, and the page could not start rendering until the last one landed.
 *
 * PostgREST will tell us the total up front if we ask for it, so the first
 * request does: it carries `{ count: "exact" }` and comes back knowing how many
 * rows exist. Every remaining range is then one `Promise.all`, and the read
 * costs two round trips instead of N.
 *
 * The sequential walk survives as a fallback for a caller that does not ask for
 * a count — without one there is no way to know how many pages to fire, and
 * guessing would either miss rows or fire requests for ranges past the end.
 */
async function readAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null; count?: number | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const first = await page(0, PAGE - 1);
  if (first.error) return { data: [], error: first.error };

  const rows = first.data ?? [];

  // Everything fitted in one page, which is the common case once a lead has
  // picked a department or a period.
  if (rows.length < PAGE) return { data: rows, error: null };

  const total = first.count ?? null;

  if (total === null) {
    // No count to plan with — walk the rest one range at a time.
    for (let from = PAGE; ; from += PAGE) {
      const { data, error } = await page(from, from + PAGE - 1);
      if (error) return { data: rows, error };
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) return { data: rows, error: null };
    }
  }

  const rest = await Promise.all(
    Array.from({ length: Math.ceil(total / PAGE) - 1 }, (_, index) =>
      page((index + 1) * PAGE, (index + 2) * PAGE - 1),
    ),
  );

  // The ranges come back in whatever order the network returns them, but
  // `Promise.all` preserves the order they were fired in, and each query is
  // ordered by a unique key — so concatenating them rebuilds the full sequence.
  for (const result of rest) {
    if (result.error) return { data: rows, error: result.error };
    rows.push(...(result.data ?? []));
  }

  return { data: rows, error: null };
}

/**
 * P11-14 — DEPARTMENT ANALYTICS. Per person, in the departments this viewer
 * leads: how many tasks they are on, how many are finished, how many are late.
 *
 * EVERY TASK BY DEFAULT, NOT A PERIOD. The question is "who is carrying what",
 * and a date window silently applied would hide a six-week-old task still
 * sitting on somebody's plate. The period is therefore opt-in, and with neither
 * end set the page is all-time. /reports takes the opposite default for the
 * opposite reason; see `filters.tsx`.
 *
 * ⚠️ THE PERIOD IS THE DUE DATE, NOT `created_at`, and this was changed after
 * the filter shipped looking broken. /reports ranges on `created_at` because it
 * asks about INTAKE, and that reasoning was copied here without checking the
 * data: every task in this database was created inside one eleven-day window
 * (the import), so every period a lead could plausibly pick returned either all
 * 3,964 tasks or none. `due_date` spans Feb 2025 to Dec 2026 and is the date a
 * lead means when they say "this month".
 *
 * ⚠️ THAT EXCLUDES UNDATED WORK WHILE A PERIOD IS SET — roughly a third of all
 * tasks have no due date. Dropping a third of the page silently is worse than
 * the filter not existing, so `filters.tsx` says so in the filter bar rather
 * than leaving a lead to wonder where the tasks went.
 *
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
  searchParams: Promise<{ department?: string; from?: string; to?: string }>;
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

  /*
   * The period — a DUE-DATE window; see the header for why it is not
   * `created_at`. Narrowed rather than trusted: these reach Postgres as date
   * literals, so an unparseable one would turn a mistyped bookmark into a 500.
   * Either end may be absent — an open-ended range is a useful question ("due
   * before the end of the quarter"), not a half-filled form.
   */
  const from = isDateOnly(params.from) ? params.from : "";
  const to = isDateOnly(params.to) ? params.to : "";

  /*
   * Inverted ranges are NOT silently swapped. Answering a different question
   * than the one asked is how somebody ends up trusting a period they never
   * set — the same call /reports and the DTR range make.
   */
  const inverted = Boolean(from && to) && from > to;

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

  /*
   * What the numbers cover, in words, for the tiles underneath. Both ends are
   * optional, so all four phrasings are spelled out — "due from 1 Sep" is a
   * sentence a reader can check against the control they just used.
   */
  const periodLabel =
    from && to
      ? `due ${formatDate(from)} – ${formatDate(to)}`
      : from
        ? `due on or after ${formatDate(from)}`
        : to
          ? `due on or before ${formatDate(to)}`
          : "";

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

  /*
   * ⚠️ EVERY STATEMENT HERE IS DELIBERATELY SMALL, and that is a correctness
   * requirement rather than a tuning preference. Production failed with
   * `canceling statement due to statement timeout` on this page.
   *
   * The reason is not the row count on its own — it is what a row costs. Both
   * policies in play call a SECURITY DEFINER function PER ROW:
   *
   *   vizserve_pms_tasks           ... manages_department(department_id)
   *                                    or is_on_task(id, auth.uid())
   *   vizserve_pms_task_assignees  ... is_on_task(task_id, auth.uid())
   *                                    or exists(... manages_department ...)
   *
   * P9-06 measured that shape at about 0.44 ms a row before it was inlined, and
   * Postgres cannot inline a definer function. One statement over four thousand
   * tasks is therefore seconds of function calls, and it is killed before it
   * returns anything at all.
   *
   * ⚠️ NONE OF THIS IS VISIBLE TO A SERVICE-ROLE PROBE. The service key bypasses
   * policies, so the same queries measured in hundreds of milliseconds from a
   * script while production was timing out. Anything measured about this page
   * has to be measured as a real signed-in user or it is measuring nothing.
   *
   * So the reads are split along the dimensions that are already indexed —
   * tasks by department, join rows by task id — and fired together. Same rows,
   * same RLS, same answer; no single statement long enough to be cancelled.
   *
   * The durable fix is the one /reports already names: a SECURITY DEFINER
   * aggregate scoped once through `vizserve_pms_approvable_department_ids()`,
   * so the department test runs a handful of times instead of once per row.
   * That is a migration and it has to re-state the P11-07/P11-08 personal-list
   * privacy rules exactly, which is why it is not being done casually here.
   */
  const [taskPages, peopleResult] = await Promise.all([
    // ONE STATEMENT PER DEPARTMENT rather than one `.in(...)` over all of them.
    // `department_id` is indexed, so each is a short scan, and four short
    // statements outrun one long one even before the timeout is considered.
    Promise.all(
      ids.map((departmentId) =>
        inverted
          ? Promise.resolve({ data: [] as WorkloadTask[], error: null })
          : readAll<WorkloadTask>((offset, end) => {
              let query = supabase
                .from("vizserve_pms_tasks")
                // `count` so `readAll` can fire the remaining pages at once.
                .select("id, title, status, department_id, due_date, assignee_id", {
                  count: "exact",
                })
                .eq("department_id", departmentId);

              // Inclusive at both ends, and no timestamp arithmetic: `due_date`
              // is a real DATE column, so the bare strings compare directly. A
              // task with no due date matches neither and drops out of the
              // period — the filter bar says so.
              if (from) query = query.gte("due_date", from);
              if (to) query = query.lte("due_date", to);

              // A stable order, or paging can skip and repeat rows between
              // requests.
              return query.order("id").range(offset, end);
            }),
      ),
    ),

    // RLS scopes this to the departments the viewer leads (everybody, for an
    // owner). No `is_active` filter here: this doubles as the NAME lookup, and a
    // deactivated person's finished tasks still deserve a name.
    supabase.from("vizserve_pms_users").select("id, full_name, primary_department_id, is_active"),
  ]);

  const tasksResult = {
    data: taskPages.flatMap((result) => result.data),
    error: taskPages.find((result) => result.error)?.error ?? null,
  };

  /*
   * THE JOIN ROWS FOR THE TASKS ON SCREEN, and nothing else.
   *
   * This read used to ignore both filters and scan the whole 3,888-row table to
   * keep fifteen rows — a fixed floor under every filter change, and 3,888
   * definer calls. Listing the task ids instead means the `(task_id, user_id)`
   * key narrows FIRST and the policy only ever runs on rows that survive.
   *
   * ⚠️ NOT AN `!inner` EMBED, which is what this briefly was. An embed reads
   * correctly and measures beautifully against a service key, but under RLS it
   * makes a statement that evaluates BOTH tables' policies across the join —
   * strictly more per-row work than the scan it replaced, in one statement that
   * cannot be split. That version is what timed out in production.
   *
   * It has to wait for the tasks, so it is a second round trip rather than a
   * third parallel one. That is the trade: one more hop, in exchange for a
   * query whose cost is the size of what is on screen.
   */
  const assignmentChunks = await Promise.all(
    chunked(
      tasksResult.data.map((task) => task.id),
      ID_CHUNK,
    ).map((taskIds) =>
      supabase.from("vizserve_pms_task_assignees").select("task_id, user_id").in("task_id", taskIds),
    ),
  );

  const assignmentsResult = {
    data: assignmentChunks.flatMap((chunk) => chunk.data ?? []) as WorkloadAssignment[],
    error: assignmentChunks.find((chunk) => chunk.error)?.error ?? null,
  };

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
    // Every department on screen, in name order, so each gets a chart even
    // when the period empties it — and so the charts keep one stable order.
    departmentIds: ids,
    nameOf: new Map(people.map((person) => [person.id, person.full_name])),
    today: todayInAppZone(),
  });

  /*
   * ⚠️ `samples` IS DROPPED HERE ON PURPOSE. The table shows counts, and every
   * one of these rows crosses to the browser as props — carrying four task
   * titles per stage per person into a table that never renders one would be
   * paying the payload twice over. The rings and bars below get their own.
   *
   * Spelled out rather than spread, so the one field that is NOT carried across
   * is visible at the call site as well as in the type.
   */
  const rows: AnalyticsRow[] = summary.rows.map((row) => ({
    id: row.id,
    name: row.name,
    departmentId: row.departmentId,
    departmentName: row.departmentId ? (departmentName.get(row.departmentId) ?? null) : null,
    total: row.total,
    notStarted: row.notStarted,
    active: row.active,
    completed: row.completed,
    overdue: row.overdue,
  }));

  const { totals } = summary;

  // From `summary.rows` rather than the table's `rows`, because the bars hover
  // to reveal their tasks and the table's copies have had the samples stripped.
  const busy = summary.rows.filter((row) => row.total > 0);

  // Named here rather than in the lib: `summariseWorkload` is pure and knows
  // nothing about department names. Anything outside the picker's scope is
  // dropped rather than drawn as an unnamed ring — `ids` is what the reads were
  // cut to, so this can only be a task that moved department mid-request.
  const departmentRings: DonutSubject[] = summary.departments.flatMap((department) => {
    const name = departmentName.get(department.departmentId);
    return name === undefined ? [] : [{ ...department, id: department.departmentId, name }];
  });

  /*
   * ONE RING PER DEPARTMENT, OR ONE PER TEAM MEMBER — decided by whether the
   * page is showing a single department, however it got there: the lead picked
   * one in the filter, or leads only one to begin with.
   *
   * The switch is the point. A single department's ring only redraws the four
   * stat tiles directly above it, whereas "who on this team is carrying what,
   * and what is on their plate" is the question a lead opens this page to ask.
   */
  const perPerson = departmentRings.length === 1;

  // Everybody, including anyone with nothing on — a person with an empty ring
  // is the most useful tile here for a lead deciding who takes the next task.
  // Already sorted busiest-first by `summariseWorkload`.
  const personRings: DonutSubject[] = summary.rows.map((row) => ({ ...row, id: row.id }));

  const rings = perPerson ? personRings : departmentRings;

  return (
    <PageShell>
      {/* /reports has no nav row of its own; this is the way in. Same gate
          (team_leader), so nobody is shown a link they cannot open. */}
      <div className="flex justify-end">
        <Link href="/reports" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <FileBarChart aria-hidden />
          Reports
        </Link>
      </div>
      <AnalyticsFilters departments={departments} allLabel={allLabel} from={from} to={to} />

      {error ? (
        <QueryError what="department analytics" message={error.message} />
      ) : inverted ? (
        // Said plainly rather than swapped, and the filter bar above keeps the
        // dates the reader typed so the fix is one control away.
        <div className="rounded-lg border bg-card grade-surface shadow-raised-lg">
          <EmptyState
            icon={<ChartPie />}
            title="That period runs backwards"
            description={`"Due from" is ${formatDate(from)} and "Due to" is ${formatDate(to)}, so the window is empty. Move one of the two dates, or clear the period to see every task.`}
          />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Tasks"
              value={totals.total}
              hint={
                summary.unassigned > 0
                  ? `${summary.unassigned} with nobody on them`
                  : periodLabel
                    ? `In ${selected ? selected.name : allLabel.toLowerCase()}, ${periodLabel}`
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

          {/*
            * SMALL MULTIPLES — one ring per department, or per team member once
            * the page is down to one department. Each answers "what is this
            * one's work made of" on its own: a part-to-whole of three slices,
            * which is what a ring is good for. Nobody is asked to compare an
            * angle across two rings — the counts are direct-labelled under
            * every one, and the rankings live in the bars and the table below,
            * where a length and a number do that job properly.
            */}
          {rings.length > 0 ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm">
                  {perPerson
                    ? `Tasks by stage, per team member${selected ? ` — ${selected.name}` : ""}`
                    : "Tasks by stage, per department"}
                </CardTitle>
                <CardDescription className="text-xs">
                  {perPerson
                    ? "Everybody on a task counts it, so a shared task appears in more than one ring — these do not add up to the totals above. Hover a slice (or tap it) to see which tasks are in it."
                    : "Every task counts once, in the department it is filed under — so unlike the per-person figures below, these rings add up to the totals above. Hover a slice (or tap it) to see which tasks are in it."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {rings.map((subject) => (
                    <StageDonut key={subject.id} subject={subject} />
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Tasks by stage, per person</CardTitle>
              <CardDescription className="text-xs">
                Everybody on a task counts it, so a shared task appears on each of their bars. Hover
                a band (or tap it) to see which tasks are in it; the exact figures are in the table
                below.
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
                    <PersonBar
                      key={row.id}
                      name={row.name}
                      counts={{
                        notStarted: row.notStarted,
                        active: row.active,
                        completed: row.completed,
                      }}
                      samples={row.samples}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-2">
            <h2 className="text-sm font-semibold">
              Every figure, per person
              {periodLabel ? (
                <span className="ml-1.5 font-normal text-muted-foreground">({periodLabel})</span>
              ) : null}
            </h2>
            <AnalyticsTable rows={rows} />
          </div>
        </>
      )}
    </PageShell>
  );
}
