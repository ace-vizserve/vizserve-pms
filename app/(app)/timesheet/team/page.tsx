import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import {
  addDays,
  formatWeekRange,
  startOfWeek,
  todayInAppZone,
  weekDates,
  workedMinutes,
} from "@/lib/dates";
import {
  breakAdjustedPunches,
  type OvertimeApproval,
  type TimesheetWeekStatus,
} from "@/lib/schemas/timesheet";
import { loadAppSettings } from "@/lib/settings-server";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";

import { TeamWeekGrid, type TeamRow, type TeamTaskRow } from "./team-week-grid";

export const metadata: Metadata = { title: "Team week" };

/**
 * P6-05 / slice E1 — the lead's week, and slice C's reviewer screen.
 *
 * These were always one page. A queue of weeks to approve with no view of the
 * hours inside them is a rubber stamp, so the approve buttons live ON the grid
 * rather than on a list that links to it.
 *
 * THE SHAPE IS THE TRANSPOSE of the member's own week: people down the side,
 * the seven days across, totals on both axes. A lead already knows how to read
 * it, because it is the same grid they fill in themselves.
 *
 * NO DEPARTMENT FILTER ON ANY QUERY. Every table here scopes by policy through
 * the person the row belongs to — `20260817090000_p6_01_timesheet.sql:154-164`
 * for entries, and the equivalent on weeks and internal requests. Restating the
 * filter would imply the policy is optional, and it is the only thing standing
 * between one lead and another lead's team.
 */
export default async function TeamWeekPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const context = await requireAuthContext();

  // A member has nobody to review. The policies would return only their own
  // rows anyway, so this is about not offering a page that can only ever show
  // one person their own week twice.
  if (!roleAtLeast(context.role, "team_leader")) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">
          This page is for team leaders. Your own week is on{" "}
          <Link href="/timesheet" className="underline">
            the timesheet
          </Link>
          .
        </p>
      </PageShell>
    );
  }

  const supabase = await createClient();
  const params = await searchParams;

  const today = todayInAppZone();
  // Any day in the week works as an anchor and is normalised here, mirroring
  // `/timesheet` and `vizserve_pms_submit_timesheet_week`. `?week=banana`
  // falls back to this week rather than erroring.
  const monday = startOfWeek(params.week ?? today) ?? startOfWeek(today)!;
  const days = weekDates(monday);
  const lastDay = days[days.length - 1]!;

  const [
    entriesResult,
    weeksResult,
    overtimeResult,
    leaveResult,
    peopleResult,
    dtrResult,
    departmentsResult,
    listsResult,
    groupsResult,
    settings,
  ] = await Promise.all([
    /*
     * Every entry the policy will show this lead, for this week — and P8-07,
     * WHAT THE HOURS WENT TO.
     *
     * This used to select `user_id, work_date, minutes` and nothing else, so
     * the reviewer got a number per day and no way to check it. The page's own
     * header calls itself a defence against a rubber stamp; a total with no
     * breakdown is the rubber stamp.
     *
     * NO POLICY CHANGE AND NO MIGRATION. "timesheet readable by owner and
     * department leads" (`20260817090000_p6_01_timesheet.sql:154-164`) is
     * row-level and names no columns — a lead who could read the minutes could
     * always read the note and the clocks beside them.
     *
     * ⚠️ THE EMBED IS LEFT, NOT `!inner`, and the reason is on the member's own
     * page at `app/(app)/timesheet/page.tsx:104-120`. The entries policy is
     * wider than the TASKS policy, so the two diverge the moment a task is
     * reassigned away from somebody who already logged against it. An inner
     * join turns "I cannot see that task" into "that row does not exist" and
     * takes a person's whole week with it. Pinned by
     * tests/db/timesheet.test.ts, "entries survive losing sight of their task".
     */
    supabase
      .from("vizserve_pms_timesheet_entries")
      .select(
        "id, user_id, task_id, work_date, minutes, note, started_at, ended_at, vizserve_pms_tasks(title, status, list_id, department_id)",
      )
      .gte("work_date", monday)
      .lte("work_date", lastDay),

    supabase
      .from("vizserve_pms_timesheet_weeks")
      .select("id, user_id, status, submitted_minutes, submitted_at, decision_reason")
      .eq("week_start", monday),

    // The team's approved overtime, not just the viewer's. This widens from
    // the member's page with NO policy change: the SELECT policy on internal
    // requests already returns `requester_id = auth.uid() or
    // vizserve_pms_manages_department(department_id)`.
    supabase
      .from("vizserve_pms_internal_requests")
      .select("id, requester_id, work_date, overtime_minutes")
      .eq("request_type", "OVERTIME")
      .eq("status", "APPROVED")
      .gte("work_date", monday)
      .lte("work_date", lastDay),

    /*
     * P7-10 — who was away.
     *
     * WITHOUT THIS THE PAGE LIBELS PEOPLE. Slice C refuses to submit an empty
     * week ("an approved empty week is a signed statement that somebody did
     * nothing"), so a person on approved leave all week has no week row at
     * all — and on this grid that is indistinguishable from somebody who has
     * simply not filed. A lead would chase someone who was on holiday, which
     * is the exact manual process this module exists to remove.
     *
     * The function returns name and dates and no reason and no type, so the
     * grid can say "on leave" and nothing more. That is all a lead needs and
     * all they are entitled to.
     */
    supabase.rpc("vizserve_pms_leave_calendar", { p_from: monday, p_to: lastDay }),

    /*
     * Names, and — P8-07 — each person's unpaid break.
     *
     * `break_minutes` is nullable and NULL MEANS "INHERIT THE COMPANY FIGURE",
     * never zero. It is read here because the punched span between two clocks
     * includes the break and a logged minute does not, so nothing on this page
     * may compare the two without it. See `breakAdjustedPunches`.
     */
    /*
     * ⚠️ NO `is_active` FILTER, AND THAT IS DELIBERATE. This is a LOOKUP —
     * `userIds` below is built from entries, weeks, leave and punches, never
     * from here — so filtering only ever removes a name and a break from
     * somebody whose rows are on the grid regardless. A person deactivated
     * part-way through the week is exactly that case, and it is the week a
     * lead most needs to read: they would otherwise have shown up nameless and
     * marked "not compared", blaming a break setting nobody failed to read.
     * RLS still scopes this to the caller's own department.
     */
    supabase.from("vizserve_pms_users").select("id, full_name, break_minutes"),

    /*
     * P8-07 — what the clock says, beside what the timesheet says.
     *
     * A lead could not previously see that somebody punched nine hours and
     * logged four. Both facts already existed; nothing put them on one screen.
     *
     * ⚠️ A READ, NOT A RELATION. There is deliberately no foreign key, join
     * table or derivation between the DTR and the timesheet — `p6_01:15-19`
     * and `p7_21:12-24` both argue it: the DTR owns "when somebody was at
     * work", the timesheet owns "where the day went", and two tables claiming
     * the same fact will disagree. This page shows both figures and names the
     * difference. It asserts nothing about which one is right, and nothing
     * downstream may treat the gap as an error.
     *
     * ⚠️ NO USER FILTER AND NO ROLE BRANCH. "dtr readable by owner and
     * department leads" (`20260804150000_p5_01_dtr.sql:243-253`) is the same
     * self-or-managed-department shape as the entries policy, so the rows that
     * arrive are exactly the rows this viewer may see. P7-40 made the point:
     * restating the scope implies the policy is optional.
     *
     * ⚠️ NO EMBED OF `vizserve_pms_users` HERE. That table has TWO foreign
     * keys into it from this one — `user_id` and `corrected_by` — and an
     * unqualified embed is refused by PostgREST every time. It shipped once as
     * "DTR is empty", because the page swallowed the error with `data ?? []`.
     * Names come from `peopleResult` above, which needs no embed at all.
     */
    supabase
      .from("vizserve_pms_dtr_entries")
      .select("user_id, work_date, time_in, time_out")
      .gte("work_date", monday)
      .lte("work_date", lastDay),

    /*
     * P8-08 — WHERE the work sat: department, folder, list.
     *
     * A reviewer reading "Client QA · 7h" on somebody's week had no way to tell
     * which Client QA it was — two lists in two departments produce two rows that
     * read identically — and no way to open the task and find out. The title is
     * now a link and these three reads are the line under it.
     *
     * ⚠️ THREE SMALL LOOKUPS, NOT A DEEPER EMBED. The entries embed above is a
     * LEFT join whose whole job is to survive a task leaving this lead's scope;
     * hanging `vizserve_pms_lists(name, vizserve_pms_task_groups(name))` off it
     * buries that guard two levels down in a select string, which is the one
     * thing on this page nobody should have to squint at. The member's own page
     * made the same call for the same reason.
     *
     * ⚠️ NO DEPARTMENT FILTER AND NO ROLE BRANCH. `lists readable in department`
     * and `task groups readable in department` scope these to the departments
     * this person leads or belongs to, so what arrives is exactly what they may
     * read. A task whose list they cannot see simply resolves to a shorter
     * breadcrumb — see `where` below, which drops what it cannot name rather than
     * printing a gap.
     */
    supabase.from("vizserve_pms_departments").select("id, name"),
    supabase.from("vizserve_pms_lists").select("id, name, group_id"),
    supabase.from("vizserve_pms_task_groups").select("id, name"),

    // `cache()`d, so a request that also renders the punch panel pays once.
    // Degrades to the default break rather than throwing, and says so through
    // `fellBack` — which is the only thing this page trusts it for.
    loadAppSettings(),
  ]);

  const nameOf = new Map((peopleResult.data ?? []).map((row) => [row.id, row.full_name]));

  /*
   * P8-07 — each person's resolved unpaid break, or null when it is not known.
   *
   * ⚠️ `?? settings.breakMinutes` AND NOT `|| settings.breakMinutes`, the same
   * distinction the member's own page draws at `app/(app)/timesheet/page.tsx`:
   * a person whose break is deliberately 0 must keep their 0, and `||` would
   * hand them the company hour and quietly take an hour a day off their punched
   * figure. This is `coalesce(u.break_minutes, s.break_minutes)`, in TypeScript.
   *
   * ⚠️ NULL WHEN THE COMPANY SETTING FELL BACK. `loadAppSettings` never throws —
   * three other screens depend on that — so a failed read arrives as the default
   * 60 rather than as an error. Deducting 60 that nobody read, and then telling a
   * lead somebody was "2h more on the clock than on the timesheet", is asserting
   * a figure this page never obtained. A person with their OWN break is still
   * comparable: their figure was read, whatever happened to the company row.
   */
  const breakOf = new Map<string, number | null>(
    (peopleResult.data ?? []).map((row) => [
      row.id,
      row.break_minutes ?? (settings.fellBack ? null : settings.breakMinutes),
    ]),
  );

  const departmentName = new Map((departmentsResult.data ?? []).map((row) => [row.id, row.name]));
  const listRow = new Map((listsResult.data ?? []).map((row) => [row.id, row]));
  const groupName = new Map((groupsResult.data ?? []).map((row) => [row.id, row.name]));

  /**
   * P8-08 — "Marketing / Campaigns / Client QA", or as much of it as resolves.
   *
   * ⚠️ EVERY PART IS OPTIONAL AND A MISSING PART IS DROPPED, NEVER PLACEHOLDERED.
   * A list with no folder is a ClickUp "Folderless List" and is the state of
   * every list made before P7-18, so a rendered "—" in the middle would be
   * decorating the ordinary case as a fault. A department or list this viewer's
   * policies do not return is the same shape: the breadcrumb simply says less.
   * Empty string when nothing resolves at all, which the grid renders as no line.
   */
  function whereTaskSat(task: { list_id: string | null; department_id: string | null }): string {
    const list = task.list_id ? listRow.get(task.list_id) : null;

    return [
      task.department_id ? departmentName.get(task.department_id) : null,
      list?.group_id ? groupName.get(list.group_id) : null,
      list?.name ?? null,
    ]
      .filter(Boolean)
      .join(" / ");
  }

  type Entry = {
    id: string;
    user_id: string;
    task_id: string;
    work_date: string;
    minutes: number;
    note: string | null;
    /** Postgres `time` arrives as `HH:MM:SS`; the grid reads `HH:MM`. Trimmed once, below. */
    started_at: string | null;
    ended_at: string | null;
    /** Null when the task has left THIS LEAD's scope. The hours are still real. */
    vizserve_pms_tasks: {
      title: string;
      status: VizservePmsTaskStatus;
      list_id: string | null;
      department_id: string | null;
    } | null;
  };

  const entries = (entriesResult.data ?? []) as unknown as Entry[];

  // Minutes per person per day — the collapsed grid, unchanged.
  const cells = new Map<string, Record<string, number>>();
  // Person → task → the task's row, with its entries filed under the day they
  // were logged on. Built in one pass over the same entries the totals come
  // from, so the breakdown and the total cannot disagree about a day.
  const tasksByUser = new Map<string, Map<string, TeamTaskRow>>();

  for (const entry of entries) {
    const row = cells.get(entry.user_id) ?? {};
    row[entry.work_date] = (row[entry.work_date] ?? 0) + entry.minutes;
    cells.set(entry.user_id, row);

    const byTask = tasksByUser.get(entry.user_id) ?? new Map<string, TeamTaskRow>();
    let task = byTask.get(entry.task_id);

    if (!task) {
      task = {
        taskId: entry.task_id,
        /*
         * ⚠️ THE ROW STAYS EVEN WHEN THE EMBED CAME BACK NULL. That is the whole
         * reason the embed is a LEFT join: a task reassigned away from this lead
         * — or deleted — must not delete somebody's hours from the review. The
         * placeholder says what happened; the minutes are unaffected and still
         * counted in every total on this page.
         */
        title: entry.vizserve_pms_tasks?.title ?? "Task no longer visible to you",
        status: entry.vizserve_pms_tasks?.status ?? null,
        /*
         * ⚠️ EMPTY WHEN THE EMBED CAME BACK NULL, and it must stay empty. There
         * is no task row to ask where it sat, and inventing "—" or guessing from
         * the person's own department would be putting a location on hours whose
         * work this viewer is explicitly not allowed to see. The grid renders the
         * placeholder title and no breadcrumb, and offers no link.
         */
        where: entry.vizserve_pms_tasks ? whereTaskSat(entry.vizserve_pms_tasks) : "",
        cells: {},
      };
      byTask.set(entry.task_id, task);
    }

    (task.cells[entry.work_date] ??= []).push({
      id: entry.id,
      minutes: entry.minutes,
      note: entry.note,
      started_at: entry.started_at ? entry.started_at.slice(0, 5) : null,
      ended_at: entry.ended_at ? entry.ended_at.slice(0, 5) : null,
    });

    tasksByUser.set(entry.user_id, byTask);
  }

  /*
   * P8-07 — punched minutes per person per day.
   *
   * ⚠️ THREE STATES, NOT TWO, and flattening them is the bug this guards
   * against. A key with a number is a closed shift. A key with NULL is a day
   * punched in and never out — `workedMinutes` refuses to guess its length, and
   * so does this. A key that is ABSENT is a day nobody punched at all, which is
   * not the same statement as "punched and worked nothing" and must never render
   * as 0 beside somebody's logged hours.
   *
   * ⚠️ RAW SPANS AT THIS POINT, AND RAW SPANS ARE NOT COMPARABLE TO LOGGED
   * HOURS. `workedMinutes` is the whole distance between the two punches, break
   * and all; a timesheet minute is working time. `breakAdjustedPunches` below is
   * what makes the two figures the same kind of number, and NOTHING may reach
   * the grid without going through it.
   */
  const spans = new Map<string, Record<string, number | null>>();
  for (const row of dtrResult.data ?? []) {
    const byDay = spans.get(row.user_id) ?? {};
    byDay[row.work_date] = workedMinutes(row.time_in, row.time_out);
    spans.set(row.user_id, byDay);
  }

  /*
   * The same spans, less each person's unpaid break — or null for somebody whose
   * break could not be worked out at all.
   *
   * Null travels to the grid as `punchesComparable: false` and prints a sentence
   * instead of a figure. It does NOT print "no punch", which would accuse
   * somebody of failing to clock in on the strength of an unread settings row.
   */
  const punched = new Map<string, Record<string, number | null> | null>();
  for (const userId of spans.keys()) {
    const byDay = spans.get(userId)!;
    punched.set(userId, breakAdjustedPunches({ punched: byDay, breakMinutes: breakOf.get(userId) ?? null }));
  }

  /*
   * Approved overtime per person per day — the requests, not just their total.
   *
   * Two approvals for one day both count, for the same reason they do on the
   * member's page: there is no unique constraint on (requester, work_date,
   * OVERTIME), and each of the two needed a lead's signature. `overtimeGranted`
   * sums them at the point of use.
   *
   * ⚠️ THE IDS ARE ONLY OFFERED AS LINKS BECAUSE THIS READ IS POLICY-SCOPED.
   * `requester_id = auth.uid() or manages_department(department_id)` is the
   * SELECT policy, so a lead who may not read somebody's overtime request gets
   * no row for it here and therefore no link to a page that would refuse them —
   * the day simply keeps the plain 480 threshold, exactly as it did before.
   */
  const overtime = new Map<string, Record<string, OvertimeApproval[]>>();
  for (const row of overtimeResult.data ?? []) {
    if (!row.work_date) continue;
    const byDay = overtime.get(row.requester_id) ?? {};
    (byDay[row.work_date] ??= []).push({ id: row.id, minutes: row.overtime_minutes ?? 0 });
    overtime.set(row.requester_id, byDay);
  }

  // Leave days per person. Expanded from spans to individual dates here so the
  // grid can ask a flat question per cell.
  const leave = new Map<string, Set<string>>();
  for (const span of (leaveResult.data ?? []) as {
    user_id: string;
    start_date: string;
    end_date: string;
  }[]) {
    const taken = leave.get(span.user_id) ?? new Set<string>();
    for (const day of days) {
      if (day >= span.start_date && day <= span.end_date) taken.add(day);
    }
    leave.set(span.user_id, taken);
  }

  const weekByUser = new Map((weeksResult.data ?? []).map((row) => [row.user_id, row]));

  // Everyone the lead can see anything about this week: somebody with hours,
  // somebody with a submitted week, or somebody who was away. Built from the
  // policy-scoped results rather than from a department list, so the page shows
  // exactly what the database is willing to show and never an empty row for
  // somebody out of scope.
  const userIds = new Set<string>([
    ...cells.keys(),
    ...weekByUser.keys(),
    ...leave.keys(),
    // P8-07. Somebody who punched all week and logged nothing had no row here at
    // all, so the one case the comparison exists to surface was the one case the
    // page could not show. Policy-scoped like every other source above.
    ...punched.keys(),
  ]);

  const rows: TeamRow[] = [...userIds]
    .map((userId) => {
      const week = weekByUser.get(userId);
      /*
       * ⚠️ COMPARABILITY IS ASKED OF THE BREAK, NOT OF THE PUNCHES. A person
       * with no DTR rows at all still has an empty record here, and "nobody
       * punched" is a true thing to show them; what decides whether any FIGURE
       * may be put beside their logged hours is whether their break was read.
       * Deriving it from `adjusted === null` instead would have said "not
       * compared" for one person and "no punch" for another in identical
       * circumstances.
       */
      const comparable = typeof breakOf.get(userId) === "number";
      const adjusted = punched.get(userId) ?? null;

      return {
        userId,
        name: nameOf.get(userId) ?? "Someone no longer active",
        cells: cells.get(userId) ?? {},
        overtime: overtime.get(userId) ?? {},
        leaveDays: [...(leave.get(userId) ?? [])],
        // Alphabetical, like the member's own grid — first-logged-first would
        // reorder the breakdown under the reviewer's cursor between refreshes.
        tasks: [...(tasksByUser.get(userId)?.values() ?? [])].sort((a, b) =>
          a.title.localeCompare(b.title),
        ),
        // Empty is "no DTR rows this week", which the grid says out loud as "no
        // punch". The flag is separate and is the thing that stops a settings
        // failure turning into an accusation.
        punched: adjusted ?? {},
        punchesComparable: comparable,
        weekId: week?.id ?? null,
        status: (week?.status ?? null) as TimesheetWeekStatus | null,
        submittedMinutes: week?.submitted_minutes ?? null,
        decisionReason: week?.decision_reason ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const previousWeek = addDays(monday, -7);
  const nextWeek = addDays(monday, 7);
  const thisWeek = startOfWeek(today);

  function weekHref(target: string | null) {
    return target && target !== thisWeek ? `/timesheet/team?week=${target}` : "/timesheet/team";
  }

  return (
    <PageShell className="gap-3">
      <div className="flex items-center gap-2 rounded-lg border bg-card grade-surface p-2 shadow-raised-lg">
        <Link
          href={weekHref(previousWeek)}
          aria-label="Previous week"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <ChevronLeft />
        </Link>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-medium">{formatWeekRange(monday)}</p>
          {monday === thisWeek ? (
            <p className="text-2xs text-muted-foreground">This week</p>
          ) : (
            <Link href="/timesheet/team" className="text-2xs text-muted-foreground hover:underline">
              Back to this week
            </Link>
          )}
        </div>

        <Link
          href={weekHref(nextWeek)}
          aria-label="Next week"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <ChevronRight />
        </Link>
      </div>

      {/* P8-07 — a dead DTR read must not read as "nobody punched".
          `dtrResult.data ?? []` would put an empty punch record beside a full
          week of logged hours, which is an accusation the page has no evidence
          for. Said out loud here, and `punchesLoaded={false}` stops the grid
          printing "no punch" in fourteen cells underneath it.

          Not a QueryError: the hours themselves loaded, and withholding the
          whole review because one comparison failed would be the worse trade. */}
      {dtrResult.error ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
        >
          Punched hours could not be loaded, so this week cannot be compared against the DTR. This is
          a fault, not an empty record — nobody is shown as having failed to punch. Give whoever is
          on support this message: <code className="text-2xs">{dtrResult.error.message}</code>
        </p>
      ) : null}

      {/* P8-07 — the break the punched figures are compared with, when it could
          not be read.

          `loadAppSettings` degrades to 60 instead of throwing, on purpose: three
          other screens would go down otherwise. But a punched span less a break
          NOBODY READ is a fabricated number, and it would be printed beside
          somebody's logged hours as a difference their lead is invited to act
          on. So the comparison is withheld for everyone inheriting that figure
          and the reason is said out loud — the same posture, and the same
          sentence shape, as the shortfall banner on `/timesheet`.

          Anyone with their OWN break on their user row is unaffected: that
          figure was read, and their row still compares. */}
      {settings.fellBack && !dtrResult.error ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
        >
          The company break setting could not be loaded, so punched hours are not compared against
          logged hours for anyone who inherits it. The hours on both records are unaffected —
          nobody is shown as having failed to punch.
        </p>
      ) : null}

      {/* A failed read rendering as "nobody logged anything" is the specific
          failure this app keeps having. Named rather than swallowed. */}
      {entriesResult.error ? (
        <QueryError what="this week" message={entriesResult.error.message} />
      ) : (
        <TeamWeekGrid
          monday={monday}
          days={days}
          today={today}
          rows={rows}
          punchesLoaded={!dtrResult.error}
        />
      )}
    </PageShell>
  );
}
