"use client";

import { useQuery } from "@tanstack/react-query";

import { QueryError } from "@/components/query-error";
import { WeekGridSkeleton } from "@/components/skeletons";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { browserClient } from "@/lib/query/browser-client";
import { fetchLoggableTasks, fetchTimesheetWeek } from "@/lib/query/fetchers/timesheet";
import { qk } from "@/lib/query/keys";
import { isWeekLocked, type OvertimeApproval } from "@/lib/schemas/timesheet";

import { WeekGrid, type PickableTask } from "./week-grid";
import { WeekStatusBar, type WeekState } from "./week-status-bar";

/**
 * P6-02 / P6-03 / P12-23 — the timesheet, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * `page.tsx` was a 517-line RSC: nine queries, then every derivation, all behind
 * ONE cache entry — the route's own render. Typing a number into a cell
 * therefore re-read the whole week, the picker's twenty tasks, the departments,
 * the lists, the week row, the overtime and the four schedule reads, because
 * `revalidatePath` has no smaller unit than a route. The reads are now two query
 * keys and a write invalidates the one it actually moved.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. `requireAuthContext()` — the
 * temporary-password wall, the `app_access` gate, the deactivation check — runs
 * in `page.tsx` beside this, and `userId` arrives from it as a prop. No decision
 * about whose hours these are is made in this file; the `.eq("user_id", …)` in
 * the fetcher NARROWS a policy result and the policy is what enforces it.
 *
 * ⚠️ THE WEEK IS STILL A URL PARAMETER and is still read on the server. A week
 * someone is looking at should survive a refresh and be pasteable into a
 * message. It is read once, in `page.tsx`, and handed down — deliberately NOT
 * re-read here with `useSearchParams`, which is how a key and a query drift by
 * one navigation.
 *
 * ⚠️ AND `monday` IS A BARE `YYYY-MM-DD` STRING ALL THE WAY INTO THE KEY. A
 * `Date` in a query key serialises to an instant, so two identical weeks built a
 * millisecond apart would be two cache entries for one screen. `lib/dates.ts` is
 * the only thing in this repo that makes one of these, and there is no date
 * library.
 * ------------------------------------------------------------------------
 */

export function TimesheetView({
  userId,
  monday,
  days,
  today,
  weekHasEnded,
}: {
  /** From `requireAuthContext()` in `page.tsx`. Names the cache entry, nothing more. */
  userId: string;
  monday: string;
  days: string[];
  today: string;
  /**
   * P8-05 — whether the week being shown has finished.
   *
   * Decided on the server, not from a clock here: this is a client component,
   * and a browser in another timezone deciding whether a Manila week is over
   * would disagree with the row the server rendered.
   */
  weekHasEnded: boolean;
}) {
  const weekKey = qk.week(userId, monday);

  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE THE `queryFn`, NEVER IN THIS BODY. A
   * `"use client"` component is still RENDERED ON THE SERVER for its initial
   * HTML, and building a browser Supabase client there reaches for
   * `document.cookie`. See `lib/query/browser-client.ts`.
   */
  const weekQuery = useQuery({
    queryKey: weekKey,
    queryFn: () => fetchTimesheetWeek(browserClient(), { userId, monday }),
  });

  /*
   * ⚠️ ITS OWN KEY, AND NOT KEYED BY WEEK. The picker's twenty most recent tasks
   * are the same list whatever week is on screen; the week is what decides which
   * of them are already ROWS, and that subtraction happens inside `WeekGrid`
   * against the entries. Keying it by week would refetch the picker on every
   * press of the back arrow for a list that did not change.
   */
  const tasksQuery = useQuery({
    queryKey: qk.loggableTasks(),
    queryFn: () => fetchLoggableTasks(browserClient(), userId),
  });

  /*
   * ⚠️ THE FAILED CASE IS FIRST AND IT IS A `QueryError`, NOT A THROW. A failed
   * read used to render as an empty week — indistinguishable from a week nobody
   * worked, on the screen where that distinction decides what somebody is paid.
   * Throwing would take out the whole route including the week navigation, and
   * the person could not even step back to a week that does load.
   */
  if (weekQuery.isError) {
    /* No `PageShell` — `page.tsx` already is one, and it renders the week
       navigation above this. Wrapping again would nest two padded flex columns
       and push the error card off the arrows somebody needs in order to step
       back to a week that does load. */
    return <QueryError what="this week" message={weekQuery.error.message} />;
  }

  /*
   * ⚠️ `isPending` IS "NO DATA YET", NOT "FETCHING". A background refetch after a
   * write must not replace a filled-in grid with a skeleton — the person is
   * usually still typing into it.
   */
  if (weekQuery.isPending) return <WeekGridSkeleton />;

  const { entries, week: weekRow, overtime, departments, lists, schedule } = weekQuery.data;

  /**
   * Approved overtime per day — the minutes, and the request each came from.
   *
   * NOT COLLAPSED TO A NUMBER. Summing is right for raising the day's threshold
   * and useless for checking it: a day marked "OT" is a claim about a decision,
   * and a reader who cannot reach the decision has to take the marker on faith.
   * `overtimeGranted` does the summing at the point of use, so the threshold and
   * the links can never be built from different rows.
   *
   * Two approvals for one day both count — there is deliberately no unique
   * constraint on (requester, work_date, OVERTIME), because that is a legitimate
   * thing that happened and each needed a lead's signature.
   */
  const overtimeApprovals = overtime.reduce<Record<string, OvertimeApproval[]>>((byDay, row) => {
    if (!row.work_date) return byDay;
    (byDay[row.work_date] ??= []).push({ id: row.id, minutes: row.overtime_minutes ?? 0 });
    return byDay;
  }, {});

  const week: WeekState = weekRow
    ? {
        status: weekRow.status,
        submittedAt: weekRow.submitted_at,
        decisionReason: weekRow.decision_reason,
      }
    : null;

  /*
   * Recomputed from the entries rather than trusting the submitted figure:
   * before a week is handed in there is nothing stored to trust, and after it
   * the grid and the bar must agree about the same hours.
   *
   * ⚠️ SUMMED FROM THE SAME ARRAY THE GRID SUMS, which is the whole reason the
   * cache holds entries rather than rows. An optimistic cell moves this figure
   * and the grid's four totals in one patch — the bar cannot fall a keystroke
   * behind the screen it is describing.
   */
  const weekTotalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0);

  /*
   * P8-05 — what this week was supposed to come to.
   *
   * ⚠️ THE ARITHMETIC IS NOT HERE, AND THAT IS THE POINT. Resolving the break,
   * counting the working days, subtracting approved leave and — the part that
   * matters most — deciding when to state NO figure rather than a wrong one all
   * live in `lib/timesheet-schedule.ts`, because `/dashboard` makes the same
   * claim and used to make it up.
   *
   * `scheduledWeek` is null both when this person is EXEMPT and when a read
   * failed; `readFailure` is what tells them apart, and it is the only reason
   * the bar and the banner below need two values rather than one.
   */
  const { scheduledWeek, readFailure: scheduleReadFailure } = schedule;

  /**
   * Everything this person may log against — INCLUDING finished tasks.
   *
   * `vizserve_pms_may_log_time` says nothing about status either way, so the
   * database accepts an entry against a completed task and the picker must offer
   * one: finish a task on Friday, come in on Monday to log Friday's hours. The
   * picker shows each task's status, so a finished one is visibly finished
   * rather than silently offered.
   *
   * ⚠️ THE STATUS IS A `string` ON THE WIRE and is narrowed here. The column is
   * an enum, but `lib/timesheet-tasks.ts` is shared with the search action,
   * which has no opinion on it, so the narrowing happens at the one place that
   * renders a badge from it.
   */
  const loggableTasks: PickableTask[] = (tasksQuery.data?.tasks ?? []).map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status as VizservePmsTaskStatus,
    // Already "Department / List" — resolved in `loadLoggableTasks` so the
    // picker's search results, which never pass through this file, carry the
    // same shape.
    where: task.where,
    // Carried for the same reason: the picker shows the window its date filter
    // matches on, and both halves of the list must be able to.
    start_date: task.start_date,
    due_date: task.due_date,
  }));

  /*
   * The List filter's options, named and sorted.
   *
   * A list whose name did not come back is DROPPED rather than shown as its
   * uuid: the lists read is scoped by the lists policy, so an id with no name is
   * one this person cannot see, and an unreadable option is worse than a missing
   * one.
   */
  const listName = new Map(lists.map((row) => [row.id, row.name]));
  const listOptions = (tasksQuery.data?.listIds ?? [])
    .map((id) => ({ id, name: listName.get(id) ?? null }))
    .filter((option): option is { id: string; name: string } => option.name !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <WeekStatusBar
        weekStart={monday}
        weekKey={weekKey}
        week={week}
        weekTotalMinutes={weekTotalMinutes}
        scheduledWeek={scheduledWeek}
        weekHasEnded={weekHasEnded}
      />

      {/* Said out loud rather than swallowed, the same way the DTR says it when
          its leave query dies. Without this the page would simply stop warning
          about short weeks and nobody would know it had — and the person would
          meet the rule as a refusal at submit time instead. */}
      {scheduleReadFailure ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
          {scheduleReadFailure} could not be loaded, so this week cannot be checked against your
          schedule before you hand it in. Your hours are unaffected — the check still runs when you
          submit.
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

        ⚠️ TWO FAILURES, ONE SENTENCE, AND THEY ARE DIFFERENT FAILURES.
        `tasksQuery.isError` is both halves of the read gone; `.data.error` is
        one half gone, which `loadLoggableTasks` deliberately survives — someone
        who is the PIC on things can still log against them. Either way the
        picker is narrower than the database and the person has to be told, which
        is why the two share a banner rather than one being silent.

        Advisory, not fatal: whatever the picker did manage to load is still
        offered, and hours already logged are unaffected.
      */}
      {tasksQuery.isError || tasksQuery.data?.error ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
          The list of tasks you can log against could not be loaded, so Add task has nothing to
          offer. Anything already on this week is unaffected — try reloading. (
          {tasksQuery.isError ? tasksQuery.error.message : tasksQuery.data?.error})
        </p>
      ) : null}

      <WeekGrid
        monday={monday}
        days={days}
        today={today}
        weekKey={weekKey}
        entries={entries}
        departments={departments}
        lists={lists}
        tasks={loggableTasks}
        taskLists={listOptions}
        // One source for the lock, shared with the bar above: `isWeekLocked` is
        // the TypeScript mirror of the status list inside
        // `vizserve_pms_timesheet_week_locked`, and RETURNED is absent from both
        // — which is the whole "unlock when sent back" mechanism.
        locked={isWeekLocked(week?.status ?? null)}
        overtimeApprovals={overtimeApprovals}
      />
    </>
  );
}
