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
import { scheduledDayMinutes } from "@/lib/dtr-schedule";
import { expandLeaveDays, leaveKey, type LeaveSpan } from "@/lib/leave";
import { isTerminal } from "@/lib/schemas/tasks";
import { isWeekLocked, scheduledWeekMinutes } from "@/lib/schemas/timesheet";
import { loadAppSettings } from "@/lib/settings-server";
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

  /**
   * P7-13 — the tasks this person is on WITHOUT being the accountable name.
   *
   * THE PICKER USED TO ASK FOR PIC-OR-QA AND NOTHING ELSE, which was stricter
   * than the rule it exists to mirror. `vizserve_pms_may_log_time` is
   * `vizserve_pms_is_on_task`, and that is PIC **or** QA **or** a row in
   * `vizserve_pms_task_assignees`. So a second assignee could be handed work,
   * be fully able to move it, comment on it and edit it — and then find the
   * timesheet picker empty, because this one query disagreed with the database
   * about who is on a task. Their hours had nowhere to go.
   *
   * P7-13's own header warned about the mirror image of this ("a second assignee
   * is offered the task in the picker and refused by the INSERT policy") and
   * fixed `may_log_time` accordingly. The picker was never widened to match.
   *
   * Fetched BEFORE the batch below rather than inside it: PostgREST has no way
   * to say "or exists in that other table", so the ids have to be in hand to
   * build the filter. One extra round trip, and it is the honest shape — the
   * alternative is an embed that turns the picker into an inner join and drops
   * the PIC's own tasks.
   */
  const { data: alsoOnRows } = await supabase
    .from("vizserve_pms_task_assignees")
    .select("task_id")
    .eq("user_id", context.userId);

  const alsoOnTaskIds = (alsoOnRows ?? []).map((row) => row.task_id);

  const [
    entriesResult,
    tasksResult,
    weekResult,
    overtimeResult,
    departmentsResult,
    listsResult,
    profileResult,
    holidaysResult,
    leaveResult,
    settings,
  ] = await Promise.all([
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

    // The picker. Every task this person is ON — as the accountable name, as the
    // QA reviewer, or as one of several assignees. This is the same test
    // `vizserve_pms_may_log_time` applies on write, so the list neither offers
    // something the insert would refuse nor hides something it would accept.
    //
    // The three clauses ARE `vizserve_pms_is_on_task`, spelled out because a
    // policy function cannot be called from a PostgREST filter. If that function
    // ever gains a fourth way to be on a task, this is the line that has to
    // learn about it — there is no way to make the two share one definition.
    supabase
      .from("vizserve_pms_tasks")
      .select("id, title, status, list_id, department_id")
      .or(
        [
          `assignee_id.eq.${context.userId}`,
          `qa_assignee_id.eq.${context.userId}`,
          // Omitted entirely when empty: `id.in.()` is a syntax error, not an
          // empty set.
          ...(alsoOnTaskIds.length > 0 ? [`id.in.(${alsoOnTaskIds.join(",")})`] : []),
        ].join(","),
      )
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
     */
    supabase
      .from("vizserve_pms_internal_requests")
      .select("work_date, overtime_minutes")
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
     * the submission below it. Without these four reads the database's refusal
     * would be the first anybody heard of a shortfall — after they had pressed
     * submit, with a toast, on a week they thought was finished.
     *
     * THE DATABASE REMAINS THE AUTHORITY. Nothing here can let a short week
     * through; a disagreement between this and the function shows up as a bar
     * that said "fine" and a submission that was refused, which is annoying and
     * safe, rather than the reverse.
     */
    supabase
      .from("vizserve_pms_users")
      .select("work_start, work_end, break_minutes")
      .eq("id", context.userId)
      .maybeSingle(),

    // The proclaimed holidays inside this week. Read from the TABLE, not from
    // `isBusinessDay` in lib/dates — that helper carries a seeded 2026 list and
    // says so, and a holiday an admin added would be missing from it. The
    // database counts expected days through `vizserve_pms_is_working_day`,
    // which reads this table, so this is the only reading that agrees with it.
    supabase
      .from("vizserve_pms_holidays")
      .select("holiday_date")
      .gte("holiday_date", monday)
      .lte("holiday_date", sunday),

    /*
     * Approved leave OVERLAPPING the week, not contained by it — leave running
     * Thursday to next Tuesday reduces what is expected of both weeks.
     *
     * The halves come along because `expandLeaveDays` needs them, and expanding
     * span → days is also what keeps the clipping right: a half-day marker
     * belongs to the request's own end, so a span that runs out of this week is
     * simply whole on every day inside it. Nothing is clipped, so nothing can
     * carry a marker across a clip.
     *
     * `requester_id` narrows a policy result rather than replacing one.
     */
    supabase
      .from("vizserve_pms_internal_requests")
      .select("requester_id, start_date, end_date, start_half, end_half")
      .eq("requester_id", context.userId)
      .eq("request_type", "LEAVE")
      .eq("status", "APPROVED")
      .lte("start_date", sunday)
      .gte("end_date", monday),

    // `cache()`d, so a page that also renders the punch panel pays once.
    loadAppSettings(),
  ]);

  /**
   * Approved overtime minutes per day.
   *
   * SUMMED, not last-one-wins: there is deliberately no unique constraint on
   * (requester, work_date, OVERTIME), because two separate approvals for one
   * day is a legitimate thing that happened and each needed a lead's signature.
   * Taking one and discarding the other would quietly lower the threshold below
   * what was actually granted.
   */
  const approvedOvertime = (overtimeResult.data ?? []).reduce<Record<string, number>>(
    (byDay, row) => {
      if (!row.work_date) return byDay;
      byDay[row.work_date] = (byDay[row.work_date] ?? 0) + (row.overtime_minutes ?? 0);
      return byDay;
    },
    {},
  );

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
      started_at: toClock(entry.started_at),
      ended_at: toClock(entry.ended_at),
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

  /*
   * P8-05 — what this week was supposed to come to.
   *
   * ⚠️ THE BREAK IS RESOLVED HERE AND NOWHERE ELSE, because this is the only
   * place both rows are in hand. `?? settings.breakMinutes` and not
   * `|| settings.breakMinutes`: a person whose break is deliberately 0 must
   * keep their 0, and `||` would quietly hand them the company hour and demand
   * an hour a day less of them than their schedule actually says. The SQL says
   * the same thing as `coalesce(u.break_minutes, s.break_minutes)`.
   */
  const dayMinutes = scheduledDayMinutes(
    profileResult.data ?? {},
    profileResult.data?.break_minutes ?? settings.breakMinutes,
  );

  const holidays = new Set((holidaysResult.data ?? []).map((row) => row.holiday_date));

  // `user_id` rather than `requester_id`, and `type_name: null` because the
  // type is not read here — `expandLeaveDays` keys days by person, and this
  // page has exactly one. The name is what the DTR's export needs; a shortfall
  // sentence has no room for it and no reason to say it.
  const leaveSpans: LeaveSpan[] = (leaveResult.data ?? [])
    .filter((row) => row.start_date !== null && row.end_date !== null)
    .map((row) => ({
      user_id: row.requester_id,
      start_date: row.start_date!,
      end_date: row.end_date!,
      start_half: row.start_half,
      end_half: row.end_half,
      type_name: null,
    }));

  const leaveByDay = expandLeaveDays(leaveSpans, monday, sunday ?? monday);

  /*
   * Working days in the week, and the approved leave sitting on them.
   *
   * `days.slice(0, 5)` IS the weekend test. `weekDates` is built from
   * `startOfWeek`, which is Monday-anchored and constrained to be so by
   * `vizserve_pms_timesheet_weeks_monday`, so the last two entries are always
   * Saturday and Sunday — no date parsing, and therefore no timezone to get
   * wrong. `vizserve_pms_is_working_day` reaches the same answer from `dow`.
   *
   * A half day of leave removes half a day of expectation, and only ever from a
   * day that was counted in the first place — the loop never deducts a half on
   * a day it did not add.
   *
   * ⚠️ THE DEDUPLICATION IS `expandLeaveDays`, AND IT IS LOAD-BEARING. This
   * counts DAYS, not requests: two approved LEAVE rows both covering Wednesday
   * subtract one day, because a person is absent on a day rather than absent
   * twice. `vizserve_pms_submit_timesheet_week` used to sum per request, so it
   * subtracted that Wednesday twice and asked for 960 minutes where this screen
   * asked for 1440 — a false "you are short" on a week Postgres accepts. The
   * SQL now walks the week's own dates the same way this loop does, and the two
   * agree by construction.
   */
  let workingDays = 0;
  let leaveDays = 0;

  for (const day of days.slice(0, 5)) {
    if (holidays.has(day)) continue;
    workingDays += 1;

    const leave = leaveByDay.get(leaveKey(context.userId, day));
    if (leave) leaveDays += leave.portion === "full" ? 1 : 0.5;
  }

  /*
   * ⚠️ NO MINIMUM WHEN WE COULD NOT WORK ONE OUT — and note which way the error
   * pushes it.
   *
   * Both reads above only ever SUBTRACT: a holiday drops a working day, approved
   * leave drops a day or a half. So `?? []` on a failed read does not degrade the
   * figure gracefully, it INFLATES it — a week with one holiday in it would
   * demand 2400 minutes instead of 1920 and the bar would tell somebody they are
   * eight hours short of a week the database will accept without a murmur, since
   * `vizserve_pms_submit_timesheet_week` recomputes the minimum from its own
   * tables and never sees this arithmetic.
   *
   * A warning that is wrong in the direction of accusing somebody of
   * under-logging is worse than no warning, so the whole claim is withheld
   * rather than guessed at: `scheduledWeek` goes null and `WeekStatusBar`
   * renders no shortfall line at all. The failure is still said out loud below —
   * silently dropping it is what `entriesResult`'s QueryError exists to stop.
   *
   * FOUR INPUTS, NOT TWO. The profile row and the settings row are the other
   * half of the same arithmetic and they fail the same way:
   *
   *   - `profileResult` failing leaves `dayMinutes` computed from `{}`, which is
   *     null and therefore silent — but silently dropping the check is exactly
   *     what the banner below exists to say out loud.
   *   - `loadAppSettings` never throws by design (three other screens depend on
   *     that), so a failed read arrives as the fallback 60. If the company break
   *     is really 30 the minimum comes out 2.5h A DAY too LOW, the bar says
   *     nothing, and the database then refuses the submission with a figure this
   *     screen never mentioned. `fellBack` is how that read owns up.
   *
   * The rule is one line: never show a minimum derived from a value that was not
   * actually read.
   */
  const scheduleReadFailure = holidaysResult.error
    ? "Holidays"
    : leaveResult.error
      ? "Approved leave"
      : profileResult.error
        ? "Your working hours"
        : /* ⚠️ ONLY WHEN THIS PERSON ACTUALLY INHERITS IT. `dayMinutes` above
             reads `break_minutes ?? settings.breakMinutes`, and the SQL says the
             same thing with `coalesce(u.break_minutes, s.break_minutes)` — so
             somebody carrying their own break never touched the company figure
             and a failed settings read tells us nothing about their week.
             Withholding it from them anyway would leave the database computing a
             minimum and refusing the week in silence, which is the exact surprise
             this whole block exists to prevent. `== null` catches undefined too,
             and a deliberate 0 is a real break that keeps its own branch. */
          profileResult.data?.break_minutes == null && settings.fellBack
          ? "The company break setting"
          : null;

  const scheduleReadFailed = scheduleReadFailure !== null;

  // Null when this person is exempt — no schedule, a broken one, or a week that
  // expected nothing of them. The bar renders nothing at all in that case.
  const scheduledWeek = scheduleReadFailed
    ? null
    : scheduledWeekMinutes({
        scheduledDayMinutes: dayMinutes,
        workingDays,
        leaveDays,
      });

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

      <WeekStatusBar
        weekStart={monday}
        week={week}
        weekTotalMinutes={weekTotalMinutes}
        scheduledWeek={scheduledWeek}
        /* Strictly before this week. It chooses which sentence the bar says, not
           whether it says one: a finished week gets the shortfall warning, a
           week still being worked gets a neutral progress line with the same
           target in it. Both matter, because `vizserve_pms_submit_timesheet_week`
           applies the full minimum to the CURRENT week and refuses only a future
           one — so a Thursday submission can be refused, and the target must be
           on screen before it is. A FUTURE week cannot be submitted at all
           (`v_week > v_this_week` refuses it), so "not current" and "finished"
           are the same set here. */
        weekHasEnded={thisWeek ? monday < thisWeek : false}
      />

      {/* Said out loud rather than swallowed, the same way the DTR says it when
          its leave query dies. Without this the page would simply stop warning
          about short weeks and nobody would know it had — and the person would
          meet the rule as a refusal at submit time instead. */}
      {scheduleReadFailed ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
        >
          {scheduleReadFailure} could not be loaded, so this week cannot be checked against your
          schedule before you hand it in. Your hours are unaffected — the check still runs when you
          submit.
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
          // One source for the lock, shared with the bar above: `isWeekLocked`
          // is the TypeScript mirror of the status list inside
          // `vizserve_pms_timesheet_week_locked`, and RETURNED is absent from
          // both — which is the whole "unlock when sent back" mechanism.
          locked={isWeekLocked(week?.status ?? null)}
          approvedOvertime={approvedOvertime}
        />
      )}
    </PageShell>
  );
}
