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
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { WeekGrid, type TaskRow } from "./week-grid";

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

  const [entriesResult, tasksResult] = await Promise.all([
    supabase
      .from("vizserve_pms_timesheet_entries")
      .select("id, task_id, work_date, minutes, note, vizserve_pms_tasks!inner(title, status)")
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
      .select("id, title, status")
      .or(`assignee_id.eq.${context.userId},qa_assignee_id.eq.${context.userId}`)
      .order("due_date", { ascending: true, nullsFirst: false }),
  ]);

  type Entry = {
    id: string;
    task_id: string;
    work_date: string;
    minutes: number;
    note: string | null;
    vizserve_pms_tasks: { title: string; status: string } | null;
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
        title: entry.vizserve_pms_tasks?.title ?? "Task",
        // A finished task is dropped from the PICKER but never from the rows
        // already carrying hours — an hour spent on something since completed is
        // still an hour that was spent.
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

  const openTasks = (tasksResult.data ?? [])
    .filter((task) => !isTerminal(task.status as Parameters<typeof isTerminal>[0]))
    .map((task) => ({ id: task.id, title: task.title }));

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
      <div className="flex items-center gap-2 rounded-xl bg-card p-2 ring-1 ring-foreground/10">
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

      <WeekGrid monday={monday} days={days} today={today} rows={taskRows} tasks={openTasks} />
    </PageShell>
  );
}
