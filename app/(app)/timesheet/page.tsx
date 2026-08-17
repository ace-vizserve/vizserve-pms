import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Timer } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import {
  addDays,
  formatDate,
  formatDuration,
  formatWeekRange,
  formatWeekday,
  startOfWeek,
  todayInAppZone,
  weekDates,
} from "@/lib/dates";
import { isTerminal } from "@/lib/schemas/tasks";
import { createClient } from "@/utils/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { LogTimeForm } from "./log-time-form";
import { WeekEntries } from "./week-entries";

export const metadata: Metadata = { title: "Timesheet" };

/**
 * P6-02 / P6-03 — the timesheet.
 *
 * Time is logged against a task picked from a list, never free text (Amier,
 * 33:20). The picker below is that list, and it is not the enforcement: the
 * INSERT policy calls `vizserve_pms_may_log_time`, so a crafted request cannot
 * book hours to somebody else's task by skipping this page.
 *
 * FIRST PERSON ONLY. The RLS policy also lets a department lead READ their
 * team's entries, but there is no person picker here — reading a team's week is
 * a reporting question (P6-05), and answering half of it inside the entry
 * screen is how you end up with a report nobody trusts because it is also an
 * editor.
 *
 * The week is a URL parameter, like every other filter in the app: a week
 * someone is looking at should survive a refresh and be pasteable into a
 * message.
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
  // hand-edited ?week=banana falls back to this week rather than erroring: a
  // bad filter should be ignored, not fatal.
  const monday = startOfWeek(params.week ?? today) ?? startOfWeek(today)!;
  const days = weekDates(monday);
  const sunday = days[6];

  const [entriesResult, tasksResult] = await Promise.all([
    supabase
      .from("vizserve_pms_timesheet_entries")
      .select("id, task_id, work_date, minutes, note, vizserve_pms_tasks!inner(title, status)")
      // No `user_id` filter — the SELECT policy returns the caller's own rows
      // plus their team's, and this page shows only their own, which is what
      // the eq below is for. It narrows a policy result; it does not replace it.
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
      .select("id, title, status, due_date")
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

  // Finished tasks are dropped from the PICKER but never from the entries
  // already logged against them — an hour spent on something that has since
  // completed is still an hour that was spent.
  const openTasks = (tasksResult.data ?? []).filter(
    (task) => !isTerminal(task.status as Parameters<typeof isTerminal>[0]),
  );

  const weekMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);

  const byDay = new Map<string, Entry[]>(days.map((day) => [day, []]));
  for (const entry of entries) byDay.get(entry.work_date)?.push(entry);

  const minutesFor = (day: string) =>
    (byDay.get(day) ?? []).reduce((sum, entry) => sum + entry.minutes, 0);

  const previousWeek = addDays(monday, -7);
  const nextWeek = addDays(monday, 7);
  const thisWeek = startOfWeek(today);
  const isCurrentWeek = monday === thisWeek;

  function weekHref(target: string | null) {
    return target && target !== thisWeek ? `/timesheet?week=${target}` : "/timesheet";
  }

  return (
    // Same shape as the DTR: a rail you work from, a wide column you read. The
    // two screens answer "when was I here" and "where did it go", and having
    // them laid out differently makes them feel like different products.
    <PageShell className="gap-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] lg:items-start">
        <div className="flex flex-col gap-3">
          <LogTimeForm
            tasks={openTasks.map((task) => ({ id: task.id, title: task.title }))}
            // Today, unless today is outside the week being viewed — then the
            // week's Monday, because a form that silently defaults to a date
            // the user cannot see on screen is a form that logs to the wrong day.
            defaultDate={days.includes(today) ? today : monday}
            maxDate={today}
          />

          <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <div>
              <dt className="text-2xs tracking-wide text-muted-foreground uppercase">This week</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                {formatDuration(weekMinutes)}
              </dd>
            </div>
            <div>
              <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Entries</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums">{entries.length}</dd>
            </div>
          </dl>

          <p className="px-1 text-xs text-muted-foreground">
            Time is logged against a task, never free text. If the task is not in the list, it is
            either finished or somebody else is on it.
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {/* Week navigation. Plain links rather than a client-side picker: the
              week lives in the URL, so back and forward already work and there
              is no state to keep in step with it. */}
          <div className="flex items-center gap-2 rounded-xl bg-card p-2 ring-1 ring-foreground/10">
            <Button variant="ghost" size="icon-sm" render={<Link href={weekHref(previousWeek)} />}>
              <ChevronLeft />
              <span className="sr-only">Previous week</span>
            </Button>

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

            <Button variant="ghost" size="icon-sm" render={<Link href={weekHref(nextWeek)} />}>
              <ChevronRight />
              <span className="sr-only">Next week</span>
            </Button>
          </div>

          {entries.length === 0 ? (
            <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
              <EmptyState
                className="py-10"
                icon={<Timer />}
                title="Nothing logged this week"
                description="Pick a task on the left and log the time it took. Hours here are what turn a finished task into a real measure of the week."
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {days.map((day) => {
                const dayEntries = byDay.get(day) ?? [];
                const dayMinutes = minutesFor(day);

                // Empty days are dropped rather than rendered as seven headings
                // with nothing under them. The week total above already says
                // what the week came to; a row of zeroes adds nothing but
                // height, and a weekend of them reads as a fault.
                if (dayEntries.length === 0) return null;

                return (
                  <section
                    key={day}
                    className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
                  >
                    <header className="flex items-baseline justify-between gap-3 border-b px-3 py-2">
                      <h2 className="text-sm font-medium">
                        {formatWeekday(day)}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {formatDate(day)}
                          {day === today ? " · today" : null}
                        </span>
                      </h2>
                      <span className="text-xs font-semibold tabular-nums">
                        {formatDuration(dayMinutes)}
                      </span>
                    </header>

                    <WeekEntries
                      entries={dayEntries.map((entry) => ({
                        id: entry.id,
                        task_id: entry.task_id,
                        work_date: entry.work_date,
                        minutes: entry.minutes,
                        note: entry.note,
                        taskTitle: entry.vizserve_pms_tasks?.title ?? "Task",
                      }))}
                      tasks={openTasks.map((task) => ({ id: task.id, title: task.title }))}
                      maxDate={today}
                    />
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
