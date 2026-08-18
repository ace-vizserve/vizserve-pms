import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import {
  addDays,
  formatWeekRange,
  startOfWeek,
  todayInAppZone,
  weekDates,
} from "@/lib/dates";
import { isTerminal } from "@/lib/schemas/tasks";
import { isWeekLocked } from "@/lib/schemas/timesheet";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";
import { WeekGrid, type TaskRow } from "./week-grid";
import { WeekStatusBar, type WeekState } from "./week-status-bar";

export const metadata: Metadata = { title: "Timesheet" };

/**
 * P6-02 / P6-03 — the timesheet.
 *
 * Time is logged against a task picked from a list, never free text (Amier,
 * 33:20). The grid's rows ARE that list: there is no row without a task behind
 * it, and the picker that adds one offers only tasks the INSERT policy would
 * accept. None of that is the enforcement — `vizserve_pms_may_log_time` runs
 * inside the policy, so a crafted request cannot book hours to somebody else's
 * task by skipping this page.
 *
 * FIRST PERSON ONLY. The RLS policy also lets a department lead READ their
 * team's entries, but there is no person picker here — reading a team's week is
 * a reporting question (P6-05), and answering half of it inside the entry screen
 * is how you end up with a report nobody trusts because it is also an editor.
 *
 * The week is a URL parameter, like every other filter in the app: a week
 * someone is looking at should survive a refresh and be pasteable into a message.
 */
export default async function TimesheetPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  const today = todayInAppZone();
  // Anything in the week works as an anchor — startOfWeek normalises it. A
  // hand-edited ?week=banana falls back to this week rather than erroring: a bad
  // filter should be ignored, not fatal.
  const monday = startOfWeek(params.week ?? today) ?? startOfWeek(today)!;
  const days = weekDates(monday);
  const sunday = days[6];

  const [entriesResult, tasksResult, weekResult, departmentsResult, listsResult] =
    await Promise.all([
    // NOTE: the third query is at the bottom of this array — the week row.
    supabase
      .from("vizserve_pms_timesheet_entries")
      // A LEFT embed, deliberately not `!inner`.
      //
      // The entries policy returns a row on `user_id = auth.uid()`. The TASKS
      // policy is narrower — PIC, QA, or department lead — so the two diverge
      // the moment a task is reassigned away from somebody who already logged
      // time against it. An inner join turns "I cannot see that task" into
      // "that row does not exist", and their hours disappear from their own
      // week, from the day totals, and from anything derived from them.
      //
      // Pinned by a test: tests/db/timesheet.test.ts, "entries survive losing
      // sight of their task".
      .select(
        "id, task_id, work_date, minutes, note, vizserve_pms_tasks(title, status, list_id, department_id)",
      )
      // No `user_id` filter would still be correct — the SELECT policy returns
      // the caller's own rows plus their team's — and this page shows only their
      // own, which is what the eq is for. It narrows a policy result; it does
      // not replace it.
      .eq("user_id", context.userId)
      .gte("work_date", monday)
      .lte("work_date", sunday)
      .order("work_date")
      .order("created_at"),

    // The picker. Tasks this person is the PIC or the QA reviewer on — the same
    // test `vizserve_pms_may_log_time` applies on write, so the list cannot
    // offer something the insert would then refuse.
    supabase
      .from("vizserve_pms_tasks")
      .select("id, title, status, list_id, department_id")
      .or(`assignee_id.eq.${context.userId},qa_assignee_id.eq.${context.userId}`)
      .order("due_date", { ascending: true, nullsFirst: false }),

    // P7-05 — this week, if it has been handed in.
    //
    // `maybeSingle`, because NO ROW IS THE DRAFT STATE. The migration
    // deliberately has no DRAFT enum member: "not submitted" is an absence, so
    // a missing row is the normal case and must not read as an error.
    //
    // The `user_id` eq narrows a policy result rather than replacing it — a
    // lead can read their team's weeks, and this screen is first-person only.
    supabase
      .from("vizserve_pms_timesheet_weeks")
      .select("id, status, submitted_at, decision_reason")
      .eq("user_id", context.userId)
      .eq("week_start", monday)
      .maybeSingle(),

    // Names for the location line under each task. Two small reference reads
    // rather than a deeper embed on the entries query: the entries embed is
    // already a LEFT join guarding against a task that left this person's
    // scope, and nesting two more levels under it makes that guard harder to
    // read than the thing it is guarding.
    supabase.from("vizserve_pms_departments").select("id, name"),
    supabase.from("vizserve_pms_lists").select("id, name"),
  ]);

  const departmentName = new Map(
    (departmentsResult.data ?? []).map((row) => [row.id, row.name]),
  );
  const listName = new Map((listsResult.data ?? []).map((row) => [row.id, row.name]));

  type Entry = {
    id: string;
    task_id: string;
    work_date: string;
    minutes: number;
    note: string | null;
    vizserve_pms_tasks: {
      title: string;
      status: string;
      list_id: string | null;
      department_id: string | null;
    } | null;
  };

  const entries = (entriesResult.data ?? []) as unknown as Entry[];

  // Entries into grid rows. A task appears once, however many days it spans —
  // that collapse is the difference between a week grid and a list of entries,
  // and it is the reason the shape was asked for.
  const rows = new Map<string, TaskRow>();

  for (const entry of entries) {
    let row = rows.get(entry.task_id);

    if (!row) {
      row = {
        taskId: entry.task_id,
        // Null when the task has moved out of this person's scope — reassigned,
        // or they were dropped as QA. The hours stay theirs and stay counted;
        // only the name of the work is no longer theirs to read.
        title: entry.vizserve_pms_tasks?.title ?? "Task no longer visible to you",
        // Null for the same reason the title is: the task moved out of scope.
        // The row still carries its hours; it just cannot say what they were for.
        status: (entry.vizserve_pms_tasks?.status ?? null) as TaskRow["status"],
        where: [
          entry.vizserve_pms_tasks?.department_id
            ? departmentName.get(entry.vizserve_pms_tasks.department_id)
            : null,
          entry.vizserve_pms_tasks?.list_id
            ? listName.get(entry.vizserve_pms_tasks.list_id)
            : null,
        ]
          .filter(Boolean)
          .join(" / "),
        // Marks the row, nothing more. An hour spent on something since
        // completed is still an hour that was spent, and the picker offers
        // finished tasks too — see `loggableTasks`.
        finished: isTerminal(
          (entry.vizserve_pms_tasks?.status ?? "OPEN") as Parameters<typeof isTerminal>[0],
        ),
        cells: {},
      };
      rows.set(entry.task_id, row);
    }

    (row.cells[entry.work_date] ??= []).push({
      id: entry.id,
      minutes: entry.minutes,
      note: entry.note,
    });
  }

  // Alphabetical. The alternative — first-logged-first — reorders the grid under
  // the cursor as soon as somebody fills a cell on a row that had none.
  const taskRows = [...rows.values()].sort((a, b) => a.title.localeCompare(b.title));

  const weekRow = weekResult.data;
  const week: WeekState = weekRow
    ? {
        status: weekRow.status,
        submittedAt: weekRow.submitted_at,
        decisionReason: weekRow.decision_reason,
      }
    : null;

  // Recomputed here rather than trusting the submitted figure: before a week is
  // handed in there is nothing stored to trust, and after it the grid and the
  // bar must agree about the same hours.
  const weekTotalMinutes = taskRows.reduce(
    (total, row) =>
      total +
      Object.values(row.cells)
        .flat()
        .reduce((cell, entry) => cell + entry.minutes, 0),
    0,
  );

  /**
   * Everything this person may log against — INCLUDING finished tasks.
   *
   * This used to drop terminal tasks from the picker. That was stricter than the
   * rule it was supposed to mirror: `vizserve_pms_may_log_time` tests PIC-or-QA
   * and says nothing about status, so the database accepts an entry against a
   * completed task and the picker was refusing to offer one.
   *
   * The scenario is ordinary and the old behaviour made it impossible: finish a
   * task on Friday, come in on Monday to log Friday's hours, and the task is
   * gone from the list. Hours already logged always kept their row — it was only
   * the FIRST entry against a finished task that could not be made.
   *
   * The picker shows each task's status, so a finished one is visibly finished
   * rather than silently offered.
   */
  const loggableTasks = (tasksResult.data ?? [])
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status as TaskRow["status"] & string,
      where: [
        task.department_id ? departmentName.get(task.department_id) : null,
        task.list_id ? listName.get(task.list_id) : null,
      ]
        .filter(Boolean)
        .join(" / "),
    }));

  const previousWeek = addDays(monday, -7);
  const nextWeek = addDays(monday, 7);
  const thisWeek = startOfWeek(today);
  const isCurrentWeek = monday === thisWeek;

  function weekHref(target: string | null) {
    return target && target !== thisWeek ? `/timesheet?week=${target}` : "/timesheet";
  }

  return (
    <PageShell className="gap-3">
      {/* Week navigation. Plain links rather than a client-side picker: the week
          lives in the URL, so back and forward already work and there is no
          state to keep in step with it. */}
      <div className="flex items-center gap-2 rounded-lg border bg-card grade-surface p-2 shadow-raised-lg">
        {/* A LINK styled as a button, not a Button rendering a link. Base UI's
            Button is a native <button> unless told otherwise, so
            `render={<Link/>}` hands it an <a> and it warns that the native
            button semantics it promised are gone. The repo settled this at the
            inbox's Clear filters: if it navigates, it is a link, and
            `buttonVariants` is how a link borrows the styling.

            aria-label rather than an sr-only span — the accessible name of a
            link with no text belongs on the link itself. */}
        <Link
          href={weekHref(previousWeek)}
          aria-label="Previous week"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <ChevronLeft />
        </Link>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-medium">{formatWeekRange(monday)}</p>
          {!isCurrentWeek ? (
            <Link href="/timesheet" className="text-2xs text-muted-foreground hover:underline">
              Back to this week
            </Link>
          ) : (
            <p className="text-2xs text-muted-foreground">This week</p>
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

      <WeekStatusBar weekStart={monday} week={week} weekTotalMinutes={weekTotalMinutes} />

      {/* A failed query used to render as an empty week — indistinguishable
          from a week nobody worked, on the screen where that distinction
          matters most. */}
      {entriesResult.error ? (
        <QueryError what="this week" message={entriesResult.error.message} />
      ) : (
        <WeekGrid
          monday={monday}
          days={days}
          today={today}
          rows={taskRows}
          tasks={loggableTasks}
          // One source for the lock, shared with the bar above: `isWeekLocked`
          // is the TypeScript mirror of the status list inside
          // `vizserve_pms_timesheet_week_locked`, and RETURNED is absent from
          // both — which is the whole "unlock when sent back" mechanism.
          locked={isWeekLocked(week?.status ?? null)}
        />
      )}
    </PageShell>
  );
}
