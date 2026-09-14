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
import { isWeekLocked, type OvertimeApproval } from "@/lib/schemas/timesheet";
import { loadScheduledWeek } from "@/lib/timesheet-schedule-server";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { loadLoggableTaskLists, loadLoggableTasks } from "@/lib/timesheet-tasks-server";
import { buttonVariants } from "@/components/ui/button";
import { WeekGrid, type PickableTask, type TaskRow } from "./week-grid";
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

  /*
   * P6-02b — last week's bounds, computed HERE rather than beside the other week
   * arithmetic further down, because the "Last week's tasks" shortcut reads that
   * week inside the same batch below.
   *
   * The `!` is safe for the reason the one on `startOfWeek` above is: `monday`
   * came out of `startOfWeek`, so it is a real date and `addDays` cannot fail
   * on it.
   */
  const lastMonday = addDays(monday, -7)!;
  const lastSunday = addDays(monday, -1)!;

  const [
    entriesResult,
    loggable,
    loggableListIds,
    weekResult,
    overtimeResult,
    departmentsResult,
    listsResult,
    schedule,
    lastWeekResult,
  ] = await Promise.all([
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
        "id, task_id, work_date, minutes, note, started_at, ended_at, vizserve_pms_tasks(title, status, list_id, department_id)",
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

    /*
     * The picker's FIRST PAGE — the 20 most recently created tasks this person
     * is on, whoever the PIC is and whatever the status.
     *
     * Twenty rather than everything, because the picker searches the DATABASE
     * now (`searchLoggableTasks`): the list is a starting point, not the set to
     * choose from, so loading every task somebody has ever been on to fill a
     * popover they are about to type into is work thrown away.
     *
     * Scoping lives in `loadLoggableTasks` and is shared with that action, so
     * the list cannot go back to disagreeing with `vizserve_pms_may_log_time`
     * about who is on a task.
     */
    loadLoggableTasks(context.userId),

    // The List filter's options: the lists this person actually has work in.
    // Inside the same batch, so it costs no extra round trip on the wire.
    loadLoggableTaskLists(context.userId),

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

    /*
     * P7-04 / slice D — overtime somebody's lead has already signed off.
     *
     * The eight-hour rule is `480 + approved overtime for that day`, so without
     * this the grid marks a legitimately approved eleven-hour day as over —
     * which trains people to ignore the marker, and the marker is the only
     * thing the rule has.
     *
     * ADVISORY, NEVER ENFORCEMENT. The database caps a day at 1440 minutes and
     * does not care about this figure at all; approved overtime is capped at
     * 960 precisely so `480 + 960` cannot exceed what the trigger allows.
     *
     * `requester_id` narrows a policy result rather than replacing one — a lead
     * can read their team's requests, and this screen is first-person. No RLS
     * change, and no department filter.
     *
     * ⚠️ `id` IS NOT DECORATION. The grid marks a day "OT" or "over +1h" on the
     * strength of a decision somebody made, and until this column came along
     * there was no way to reach that decision from the day it changed. See
     * `OvertimeApproval`: the id is safe to put in a link precisely because it
     * arrived through this policy-scoped read.
     */
    supabase
      .from("vizserve_pms_internal_requests")
      .select("id, work_date, overtime_minutes")
      .eq("requester_id", context.userId)
      .eq("request_type", "OVERTIME")
      .eq("status", "APPROVED")
      .gte("work_date", monday)
      .lte("work_date", days[days.length - 1]!),

    // Names for the location line under each task. Two small reference reads
    // rather than a deeper embed on the entries query: the entries embed is
    // already a LEFT join guarding against a task that left this person's
    // scope, and nesting two more levels under it makes that guard harder to
    // read than the thing it is guarding.
    supabase.from("vizserve_pms_departments").select("id, name"),
    supabase.from("vizserve_pms_lists").select("id, name"),

    /*
     * P8-05 — everything needed to say, BEFORE the button is pressed, whether
     * this week reaches the schedule.
     *
     * `vizserve_pms_submit_timesheet_week` computes the same figure and refuses
     * the submission below it. Without these reads the database's refusal would
     * be the first anybody heard of a shortfall — after they had pressed submit,
     * with a toast, on a week they thought was finished.
     *
     * ⚠️ FOUR READS AND EVERY EXEMPTION NOW LIVE IN ONE PLACE, and this page is
     * no longer that place. `/dashboard` needs the same figure and reached for
     * `STANDARD_DAY_MINUTES * 5` instead — a 40-hour week this repo has never
     * defined. Both screens now call `loadScheduledWeek`; a second copy of this
     * rule is how they start disagreeing about somebody's week.
     *
     * Inside the `Promise.all` rather than before it, so its reads run alongside
     * the five above instead of after them.
     */
    loadScheduledWeek(context.userId, days),

    /*
     * P6-02b — WHAT THIS PERSON WORKED ON LAST WEEK, for the shortcut that puts
     * those same tasks back on this one.
     *
     * ⚠️ THE TASKS, NOT THE HOURS, and the shortcut is built that way on
     * purpose: it adds empty ROWS — the same thing "Add task" adds — so nothing
     * reaches the database until somebody types a duration. Copying the minutes
     * across would have this screen inventing hours for a week nobody has
     * worked yet, on the one screen where every number is a claim somebody
     * signs.
     *
     * A LEFT embed for the same reason the current week's read has one, but it
     * costs something different here. There, a task that has moved out of this
     * person's scope keeps its row and loses its name. Here it loses the OFFER:
     * a task they can no longer read is one `vizserve_pms_may_log_time` will no
     * longer accept, so it is dropped below rather than offered as a row every
     * keystroke would be refused on.
     *
     * A failed read costs the shortcut and nothing else — no banner, because a
     * missing shortcut states nothing false, and "Add task" still reaches every
     * one of these tasks by name.
     */
    supabase
      .from("vizserve_pms_timesheet_entries")
      .select("task_id, vizserve_pms_tasks(title, status, list_id, department_id)")
      .eq("user_id", context.userId)
      .gte("work_date", lastMonday)
      .lte("work_date", lastSunday),
  ]);

  /**
   * Approved overtime per day — the minutes, and the request each came from.
   *
   * NOT COLLAPSED TO A NUMBER, which is what this used to be. Summing is right
   * for raising the day's threshold and useless for checking it: a day marked
   * "OT" is a claim about a decision, and a reader who cannot reach the decision
   * has to take the marker on faith. `overtimeGranted` does the summing at the
   * point of use, so the threshold and the links can never be built from
   * different rows.
   *
   * Two approvals for one day both count — there is deliberately no unique
   * constraint on (requester, work_date, OVERTIME), because that is a legitimate
   * thing that happened and each needed a lead's signature.
   */
  const overtimeApprovals = (overtimeResult.data ?? []).reduce<Record<string, OvertimeApproval[]>>(
    (byDay, row) => {
      if (!row.work_date) return byDay;
      (byDay[row.work_date] ??= []).push({ id: row.id, minutes: row.overtime_minutes ?? 0 });
      return byDay;
    },
    {},
  );

  const departmentName = new Map(
    (departmentsResult.data ?? []).map((row) => [row.id, row.name]),
  );
  const listName = new Map((listsResult.data ?? []).map((row) => [row.id, row.name]));

  /**
   * "Department / List" for a task, from the two reference reads above.
   *
   * ONE IMPLEMENTATION, TWO CALLERS — this week's rows and last week's shortcut.
   * The location line under a task name reading one way in the grid and another
   * in the control that adds it is the kind of difference nobody reports and
   * everybody notices.
   *
   * An id whose name did not come back DROPS OUT rather than rendering as a
   * uuid: both reference reads are policy-scoped, so a missing name means "not
   * yours to read".
   */
  function whereOf(task: { department_id: string | null; list_id: string | null } | null): string {
    return [
      task?.department_id ? departmentName.get(task.department_id) : null,
      task?.list_id ? listName.get(task.list_id) : null,
    ]
      .filter(Boolean)
      .join(" / ");
  }

  /*
   * The List filter's options, named and sorted.
   *
   * A list whose name did not come back is DROPPED rather than shown as its
   * uuid: `listsResult` is scoped by the lists policy, so an id with no name is
   * one this person cannot see, and an unreadable option is worse than a
   * missing one.
   */
  const listOptions = loggableListIds
    .map((id) => ({ id, name: listName.get(id) ?? null }))
    .filter((option): option is { id: string; name: string } => option.name !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  type Entry = {
    id: string;
    task_id: string;
    work_date: string;
    minutes: number;
    note: string | null;
    /**
     * P7-21. Postgres `time` arrives as `HH:MM:SS`; the grid and the
     * `<input type="time">` behind it both work in `HH:MM`, so the seconds are
     * trimmed once here rather than in each of the three places that read them.
     */
    started_at: string | null;
    ended_at: string | null;
    vizserve_pms_tasks: {
      title: string;
      status: string;
      list_id: string | null;
      department_id: string | null;
    } | null;
  };

  const entries = (entriesResult.data ?? []) as unknown as Entry[];

  /**
   * `09:30:00` → `09:30`, and null stays null.
   *
   * `<input type="time">` accepts the seconds form but normalises it away the
   * moment somebody touches the field, which would make an untouched row and a
   * touched-but-unchanged one compare as different and fire a pointless UPDATE
   * on blur. Trimming on the way in removes the difference instead.
   */
  function toClock(value: string | null): string | null {
    return value ? value.slice(0, 5) : null;
  }

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
        where: whereOf(entry.vizserve_pms_tasks),
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
      started_at: toClock(entry.started_at),
      ended_at: toClock(entry.ended_at),
    });
  }

  // Alphabetical. The alternative — first-logged-first — reorders the grid under
  // the cursor as soon as somebody fills a cell on a row that had none.
  const taskRows = [...rows.values()].sort((a, b) => a.title.localeCompare(b.title));

  /**
   * P6-02b — last week's tasks, one entry each, for the shortcut in the grid.
   *
   * A task appears ONCE however many days it ran, which is the same collapse the
   * grid does above: the shortcut adds rows, and a row is a task, not an entry.
   *
   * Tasks already on THIS week are deliberately not filtered out here. The grid
   * also holds the empty rows somebody added by hand — they live in
   * sessionStorage, which this file cannot see — so a filter applied here would
   * be applied against half the picture. The grid does it, where the whole
   * picture is.
   */
  type LastWeekEntry = { task_id: string; vizserve_pms_tasks: Entry["vizserve_pms_tasks"] };

  const lastWeekTasks: PickableTask[] = [
    ...new Map(
      ((lastWeekResult.data ?? []) as unknown as LastWeekEntry[]).flatMap((entry) => {
        const task = entry.vizserve_pms_tasks;
        // Dropped rather than named — see the read. A task this person can no
        // longer see is one they can no longer log against.
        if (!task) return [];

        return [
          [
            entry.task_id,
            {
              id: entry.task_id,
              title: task.title,
              status: task.status as PickableTask["status"],
              where: whereOf(task),
            },
          ] as const,
        ];
      }),
    ).values(),
  ].sort((a, b) => a.title.localeCompare(b.title));

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

  /*
   * P8-05 — what this week was supposed to come to.
   *
   * ⚠️ THE ARITHMETIC IS NO LONGER HERE, AND THAT IS THE POINT. Resolving the
   * break, counting the working days, subtracting approved leave and — the part
   * that matters most — deciding when to state NO figure rather than a wrong one
   * all live in `lib/timesheet-schedule.ts`, because `/dashboard` makes the same
   * claim and used to make it up. See that file's header.
   *
   * `scheduledWeek` is null both when this person is EXEMPT (no schedule, a
   * schedule the break swallows, or a week that expected nothing of them) and
   * when a read failed; `readFailure` is what tells them apart, and it is the
   * only reason the bar and the banner below need two values rather than one.
   */
  const { scheduledWeek, readFailure: scheduleReadFailure } = schedule;
  const scheduleReadFailed = scheduleReadFailure !== null;

  /**
   * Everything this person may log against — INCLUDING finished tasks.
   *
   * This used to drop terminal tasks from the picker. That was stricter than the
   * rule it was supposed to mirror: `vizserve_pms_may_log_time` says nothing
   * about status either way, so the database accepts an entry against a
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
  const loggableTasks = loggable.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status as TaskRow["status"] & string,
    // Already "Department / List" — resolved in `loadLoggableTasks` so the
    // picker's search results, which never pass through this file, carry the
    // same shape.
    where: task.where,
    // Carried for the same reason: the picker shows the window its date
    // filter matches on, and both halves of the list must be able to.
    start_date: task.start_date,
    due_date: task.due_date,
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

      <WeekStatusBar
        weekStart={monday}
        week={week}
        weekTotalMinutes={weekTotalMinutes}
        scheduledWeek={scheduledWeek}
        /* Strictly before this week. It chooses which sentence the bar says, not
           whether it says one: a finished week gets the shortfall warning, a
           week still being worked gets a neutral progress line with the same
           target in it. Either way a submission below the target is confirmed
           first (P8-05b). A FUTURE week cannot be submitted at all
           (`v_week > v_this_week` refuses it), so "not current" and "finished"
           are the same set here. */
        weekHasEnded={thisWeek ? monday < thisWeek : false}
      />

      {/* Said out loud rather than swallowed, the same way the DTR says it when
          its leave query dies. Without this the page would simply stop warning
          about short weeks and nobody would know it had. */}
      {scheduleReadFailed ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
        >
          {scheduleReadFailure} could not be loaded, so this week cannot be checked against your
          schedule before you hand it in. Your hours are unaffected.
        </p>
      ) : null}

      {/*
        P7-13 — THE PICKER IS NARROWER THAN THE DATABASE RIGHT NOW.

        Said out loud rather than swallowed. A failed read of either the join
        table or the task list leaves the picker offering PIC-or-QA tasks only,
        or nothing at all — and the empty state underneath cannot tell that from
        "you are genuinely on no tasks", so it would state the second while the
        first is true. Somebody would go and ask their lead to assign them work
        they already have.

        Advisory, not fatal: whatever the picker did manage to load is still
        offered, and hours already logged are unaffected.
      */}
      {loggable.error ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
        >
          The list of tasks you can log against could not be loaded, so Add task has nothing to
          offer. Anything already on this week is unaffected — try reloading. ({loggable.error})
        </p>
      ) : null}

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
          taskLists={listOptions}
          // One source for the lock, shared with the bar above: `isWeekLocked`
          // is the TypeScript mirror of the status list inside
          // `vizserve_pms_timesheet_week_locked`, and RETURNED is absent from
          // both — which is the whole "unlock when sent back" mechanism.
          locked={isWeekLocked(week?.status ?? null)}
          overtimeApprovals={overtimeApprovals}
          // P6-02b. Offered as empty rows, never as hours — see the read above.
          previousWeekTasks={lastWeekTasks}
        />
      )}
    </PageShell>
  );
}
