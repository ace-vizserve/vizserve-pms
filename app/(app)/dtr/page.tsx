import type { Metadata } from "next";
import Link from "next/link";
import { Clock } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import {
  addDays,
  formatDate,
  formatDuration,
  todayInAppZone,
  workedMinutes,
} from "@/lib/dates";
import {
  deviation as computeDeviation,
  effectiveEnd,
  scheduleFor,
} from "@/lib/dtr-schedule";
import { loadPunchState } from "@/lib/dtr-server";
import {
  TIME_CORRECTION_TYPES,
} from "@/lib/schemas/internal-requests";
import { loadAppSettings } from "@/lib/settings-server";
import {
  expandLeaveDays,
  leaveKey,
  type LeaveDay,
  type LeaveSpan,
} from "@/lib/leave";
import { createClient } from "@/utils/supabase/server";
import { DtrTable, type DayRequest, type Entry, type PunchRow } from "./dtr-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { DtrToolbar } from "./dtr-toolbar";
import { PunchPanel } from "./punch-panel";

export const metadata: Metadata = { title: "DTR" };

/**
 * How many rows the list renders. The query asks for one more, so truncation is
 * detectable without a second count query.
 */
const DTR_PAGE_SIZE = 500;

/**
 * P5-04 — the daily time record.
 *
 * "Default view nyan, pag-click, is yung list view lang ng mga time in, time
 * out" (Amier, 19:10). A list of days, not a calendar and not a chart — this is
 * the screen someone opens to check whether yesterday recorded properly.
 *
 * SCOPE IS RLS'S JOB. This query carries no department filter and no
 * `user_id = me` clause: the policy returns your own rows plus your team's if
 * you lead one. Restating that here would imply the policy is optional, and
 * would drift from it the first time either changed.
 */
export default async function DtrPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; user?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  /*
   * P7-65 — THE SORT ALLOWLIST.
   *
   * `?sort=` is user input, so it picks a LITERAL column here rather than being
   * interpolated into `.order()`. The range is capped at `DTR_PAGE_SIZE + 1`,
   * which is exactly why the table sets `urlSort` and lets Postgres order:
   * sorting the truncated page in the browser would claim an ordering of days
   * it never received.
   */
  const DTR_SORTS = ["date", "in", "out"] as const;
  type DtrSort = (typeof DTR_SORTS)[number];
  /*
   * The order applied when the URL asks for none. Newest day first — a record is
   * read backwards from the most recent day, which is what this screen is opened
   * for. `dtr-table.tsx` passes the same pair to `DataTable` as `defaultSort`,
   * and that is the only reason its header can draw an arrow for an order nobody
   * put in the query string. One fact stated on either side of the wire: change
   * one and change the other, or the header goes back to lying.
   */
  const DTR_DEFAULT_SORT = { sort: "date", ascending: false } as const;

  /* `undefined` when the URL named no sort we recognise, and that distinction is
     load-bearing: it decides whether `?dir=` is obeyed at all, so it cannot be
     collapsed into `dtrSort` below. */
  const requestedSort: DtrSort | undefined = (DTR_SORTS as readonly string[]).includes(
    params.sort ?? "",
  )
    ? (params.sort as DtrSort)
    : undefined;
  const dtrSort: DtrSort = requestedSort ?? DTR_DEFAULT_SORT.sort;
  const DTR_ORDER: Record<DtrSort, string> = {
    date: "work_date",
    in: "time_in",
    out: "time_out",
  };
  /* ONE SOURCE FOR THE DIRECTION. An explicit sort obeys `?dir=` — ascending
     unless it says otherwise, which is why the table leaves `asc` out of the URL
     — and no explicit sort takes the default's. Deriving the direction from the
     COLUMN NAME, as this did (`dtrSort !== "date"`), meant a click on Date wrote
     `?sort=date` with no `dir`, the header drew ascending and Postgres returned
     descending: the arrow and the rows disagreed, and Date could not be read
     oldest-first at all. */
  const dtrAscending = requestedSort ? params.dir !== "desc" : DTR_DEFAULT_SORT.ascending;

  const today = todayInAppZone();
  // Default to the last 30 days rather than the calendar month: on the 1st, a
  // month-to-date view is one row and looks broken.
  const from = params.from ?? addDays(today, -29)!;
  const to = params.to ?? today;
  const selectedUser = params.user ?? null;

  // A range that runs backwards matches nothing, and "nothing" is exactly what
  // an honestly empty record looks like — so the page has to say which it is.
  // `dtrExportSchema` already refuses `to < from`; this is the screen catching
  // up with the export rather than quietly disagreeing with it.
  const rangeInverted = from > to;

  const isLead = roleAtLeast(context.role, "team_leader");

  const [punchState, entriesResult, leaveResult, peopleResult, requestsResult, settings] =
    await Promise.all([
    loadPunchState(context.userId),
    (() => {
      // ONE MORE THAN WE RENDER.
      //
      // The cap has to exist — an unbounded query over a whole department and
      // an arbitrary date range is how a page falls over. But a silent cap on
      // THIS page is worse than most, because the rail and the footer add up
      // the rows that came back and present the result as "Total in range". A
      // lead looking at sixteen people over thirty days is already near 480
      // rows; past the cap the total quietly understates, and it is a payroll
      // number.
      //
      // Asking for PAGE_SIZE + 1 makes truncation detectable without a second
      // count query: if the extra row arrives, there is more than we are
      // showing, and the screen has to say so rather than do arithmetic on a
      // slice and call it a total.
      let query = supabase
        .from("vizserve_pms_dtr_entries")
      // THE FK MUST BE NAMED. `vizserve_pms_dtr_entries` has TWO foreign keys
      // to `vizserve_pms_users` — `user_id` and `corrected_by` — so an
      // unqualified embed is ambiguous and PostgREST refuses the whole query
      // with "more than one relationship was found".
      //
      // This shipped broken and looked empty for months: the page read
      // `data ?? []` and rendered "No entries in this range", which is exactly
      // what an empty record looks like. Naming the constraint is the fix;
      // surfacing query errors (QueryError) is what made it visible.
      //
      // Left embed rather than `!inner`, for the same reason as the timesheet:
      // a row whose person is out of scope should lose its name, not its hours.
        .select(
          "id, work_date, time_in, time_out, corrected_at, user_id, vizserve_pms_users!vizserve_pms_dtr_entries_user_id_fkey(full_name, work_start, work_end)",
        )
        .gte("work_date", from)
        .lte("work_date", to)
        .order(DTR_ORDER[dtrSort], { ascending: dtrAscending, nullsFirst: false })
        // A stable tie-break: two people punching on the same day must not
        // swap places between renders.
        .order("work_date", { ascending: false })
        .limit(DTR_PAGE_SIZE + 1);

      if (selectedUser) query = query.eq("user_id", selectedUser);
      return query;
    })(),

    /*
     * APPROVED LEAVE — the days this list used to have nothing to say about.
     *
     * A day off has no `dtr_entries` row, so it was an invisible gap: the empty
     * state says "days with no punch have no row at all", and somebody scanning
     * their record for a missing punch had no way to tell an approved absence
     * from a day the system lost. Worse, a lead reading a member's record saw a
     * silent hole.
     *
     * The ordinary policy on internal requests, NOT
     * `vizserve_pms_leave_calendar`. The calendar is SECURITY DEFINER and
     * returns every active user; this page is scoped, and borrowing the
     * calendar would show a member days belonging to people whose DTR they
     * cannot read. `requester_id = auth.uid() or manages_department(...)` is
     * the same shape as the DTR's own policy, so the two agree by construction
     * — and, like the list above, this query carries no department filter.
     *
     * `reason` is not selected. The absence belongs on this screen; why belongs
     * to the requester and the lead who decided it.
     */
    (() => {
      let query = supabase
        .from("vizserve_pms_internal_requests")
        .select(
          "requester_id, start_date, end_date, start_half, end_half, vizserve_pms_leave_types(label)",
        )
        .eq("request_type", "LEAVE")
        .eq("status", "APPROVED")
        // Overlap, not containment — see vizserve_pms_leave_calendar.
        .lte("start_date", to)
        .gte("end_date", from);

      if (selectedUser) query = query.eq("requester_id", selectedUser);
      return query;
    })(),

    // The picker only makes sense for someone who can see more than themselves.
    // Reads through the same RLS as the list, so it cannot offer a person whose
    // rows would then come back empty.
    isLead
      ? supabase
          .from("vizserve_pms_users")
          .select("id, full_name")
          .eq("is_active", true)
          .order("full_name")
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),

    /*
     * P7-40 — THE REQUESTS ATTACHED TO THESE DAYS.
     *
     * Amier asked for the approval to be visible from the record it changes:
     * "user can only see their own approval link, and team manager/leader and
     * admin as well". That visibility rule needs no code — it is already the
     * RLS on `vizserve_pms_internal_requests`, `requester_id = auth.uid() or
     * manages_department(department_id)`, which is the same shape as the DTR's
     * own policy. So this query carries NO user filter and no role branch, and
     * the two screens agree by construction rather than by both remembering.
     *
     * Corrections AND approved overtime, in one round trip. They land in the
     * same column because they answer the same question — "is there paperwork
     * on this day?" — and because a second query for at most a handful of rows
     * is latency spent on tidiness.
     *
     * `correction_at` comes back so a pending correction can say what it is
     * asking for. Reading it before anybody decides is the point: a lead
     * scanning the table sees "they say 09:00" beside the 09:26 that was
     * recorded.
     */
    (() => {
      let query = supabase
        .from("vizserve_pms_internal_requests")
        .select("id, request_type, status, work_date, requester_id, correction_at, overtime_minutes")
        .in("request_type", [...TIME_CORRECTION_TYPES, "OVERTIME"])
        .gte("work_date", from)
        .lte("work_date", to)
        .order("created_at", { ascending: false });

      if (selectedUser) query = query.eq("requester_id", selectedUser);
      return query;
    })(),

    loadAppSettings(),
  ]);

  const fetched = (entriesResult.data ?? []) as unknown as PunchRow[];
  // The extra row is a signal, not data. Drop it before anything is counted.
  const truncated = fetched.length > DTR_PAGE_SIZE;
  const punchRows = truncated ? fetched.slice(0, DTR_PAGE_SIZE) : fetched;

  const people = peopleResult.data ?? [];
  const showPerson = isLead && !selectedUser;
  const nameOf = new Map(people.map((row) => [row.id, row.full_name] as const));

  type LeaveRequestRow = {
    requester_id: string;
    start_date: string | null;
    end_date: string | null;
    start_half: "MORNING" | "AFTERNOON" | null;
    end_half: "MORNING" | "AFTERNOON" | null;
    vizserve_pms_leave_types: { label: string } | null;
  };

  const spans: LeaveSpan[] = ((leaveResult.data ?? []) as unknown as LeaveRequestRow[])
    // The shape constraint guarantees both dates on a LEAVE row; the types do
    // not, and a null would expand into an unbounded walk.
    .filter((row) => row.start_date !== null && row.end_date !== null)
    .map((row) => ({
      user_id: row.requester_id,
      start_date: row.start_date!,
      end_date: row.end_date!,
      start_half: row.start_half,
      end_half: row.end_half,
      type_name: row.vizserve_pms_leave_types?.label ?? null,
    }));

  // An inverted range would otherwise expand into nothing anyway, but the guard
  // keeps this honest with the empty state that explains itself below.
  const leaveDays = rangeInverted ? new Map<string, LeaveDay>() : expandLeaveDays(spans, from, to);

  const punchedKeys = new Set(punchRows.map((row) => leaveKey(row.user_id, row.work_date)));

  /*
   * Requests indexed by person and day, the same `user|date` key the leave map
   * uses so both lookups read alike.
   *
   * Approved overtime is pulled out separately because it does two jobs: it
   * shows on the row, AND it extends the day's scheduled end so that working
   * the hours you were authorised to work is not then reported as a deviation.
   * Summed rather than taken singly — one day can carry more than one approved
   * overtime request.
   */
  const requestRows = (requestsResult.data ?? []) as unknown as DayRequest[];

  const requestsByDay = new Map<string, DayRequest[]>();
  const overtimeByDay = new Map<string, number>();

  for (const row of requestRows) {
    if (!row.work_date) continue;
    const key = leaveKey(row.requester_id, row.work_date);

    const forDay = requestsByDay.get(key) ?? [];
    forDay.push(row);
    requestsByDay.set(key, forDay);

    if (row.request_type === "OVERTIME" && row.status === "APPROVED") {
      overtimeByDay.set(key, (overtimeByDay.get(key) ?? 0) + (row.overtime_minutes ?? 0));
    }
  }

  const punchEntries: Entry[] = punchRows.map((row) => {
    const key = leaveKey(row.user_id, row.work_date);
    const schedule = scheduleFor(row.vizserve_pms_users ?? {});
    const end = effectiveEnd(schedule.workEnd, overtimeByDay.get(key) ?? 0);
    const onLeave = leaveDays.get(key) ?? null;

    return {
      ...row,
      leave: onLeave,
      isLeaveOnly: false,
      requests: requestsByDay.get(key) ?? [],
      /*
       * NOT COMPUTED ON A DAY SOMEBODY WAS APPROVED TO BE AWAY. A half day of
       * leave legitimately shifts when a person clocks in and out, and telling
       * someone on approved leave that they arrived four hours late is both
       * wrong and insulting. The absence is the explanation; the schedule does
       * not apply to it.
       */
      deviationIn: onLeave
        ? null
        : computeDeviation("in", row.time_in, schedule.workStart, settings.graceMinutes),
      deviationOut: onLeave
        ? null
        : computeDeviation("out", row.time_out, end, settings.graceMinutes),
    };
  });

  /*
   * The absences with no punch behind them. These are the rows that did not
   * exist before — and they are the whole point, because a day off is exactly
   * the day that leaves no trace in `dtr_entries`.
   *
   * Synthetic ids, prefixed so they cannot collide with a real uuid and so a
   * key in the DOM says what it is.
   */
  const leaveEntries: Entry[] = [...leaveDays]
    .filter(([key]) => !punchedKeys.has(key))
    .map(([key, day]) => {
      const [userId = "", workDate = ""] = key.split("|");
      return {
        id: `leave:${key}`,
        work_date: workDate,
        time_in: null,
        time_out: null,
        corrected_at: null,
        user_id: userId,
        vizserve_pms_users: nameOf.has(userId)
          ? { full_name: nameOf.get(userId)!, work_start: null, work_end: null }
          : null,
        leave: day,
        isLeaveOnly: true,
        // The requests still show: an approved absence can perfectly well have a
        // correction or an overtime filed against the same date, and hiding
        // them here would make a row that exists to explain a day explain less
        // of it than a punched row does.
        requests: requestsByDay.get(key) ?? [],
        // A day off is never off schedule. There is no punch to judge.
        deviationIn: null,
        deviationOut: null,
      };
    });

  /*
   * ⚠️ THIS MERGE HAS TO SORT THE WAY THE QUERY DID, and it is the last word on
   * screen. Postgres orders the punch rows, but the leave rows are synthesised
   * above and have to be interleaved — so the combined list is sorted here in
   * full, and whatever this says is what the table renders. It used to say
   * "newest first" unconditionally, which quietly overrode `?sort=` and `?dir=`
   * entirely: every header on this table was a control the rows ignored.
   *
   * The comparator reads the same column the query ordered by, so the two agree
   * by construction rather than by both remembering.
   */
  const sortedOn = (entry: Entry): string | null =>
    dtrSort === "in" ? entry.time_in : dtrSort === "out" ? entry.time_out : entry.work_date;

  // Ties broken by name so a day with several people on it does not reshuffle
  // between renders.
  const tieBreak = (a: Entry, b: Entry) =>
    (a.vizserve_pms_users?.full_name ?? "").localeCompare(b.vizserve_pms_users?.full_name ?? "") ||
    a.user_id.localeCompare(b.user_id);

  const entries: Entry[] = [...punchEntries, ...leaveEntries].sort((a, b) => {
    const left = sortedOn(a);
    const right = sortedOn(b);

    /* NULLS LAST IN BOTH DIRECTIONS, matching `nullsFirst: false` on the query.
       A day that was never timed out, and every leave-only row, has no punch to
       compare — those belong at the end of the list rather than at the head of a
       descending one, where they would push the rows somebody came to read off
       the screen. */
    if (left === null || right === null) {
      if (left === right) return tieBreak(a, b);
      return left === null ? 1 : -1;
    }

    const ordered = left.localeCompare(right);
    return (dtrAscending ? ordered : -ordered) || tieBreak(a, b);
  });

  const totalMinutes = entries.reduce(
    (sum, entry) => sum + (workedMinutes(entry.time_in, entry.time_out) ?? 0),
    0,
  );

  // The rail summary. "Records" rather than "Days" on purpose: with the person
  // filter on Everyone, one calendar day is several rows, and calling that a day
  // count would be wrong in exactly the view a team leader uses most.
  //
  // The average divides by records that actually closed. Dividing by all of them
  // would quietly drag the figure down every time somebody forgot to time out —
  // which is the very thing "Still open" is there to point at.
  const closed = entries.filter((entry) => workedMinutes(entry.time_in, entry.time_out) !== null);
  const stillOpen = entries.filter((entry) => entry.time_in && !entry.time_out).length;
  const averageMinutes = closed.length > 0 ? Math.round(totalMinutes / closed.length) : null;

  // Counted apart from the punch records on purpose. Folding leave into
  // "Records" would inflate a figure people read as "days I was at work", and
  // the average below divides by days that closed — a day off is neither.
  const leaveDayCount = leaveEntries.length;

  /**
   * F — whose record is this row?
   *
   * A lead reading their team's DTR must NOT be offered these links. The
   * correction would be filed against their own record, because
   * `vizserve_pms_submit_internal_request` resolves the requester from the
   * caller — so a lead clicking "Time-in missing?" on somebody else's gap would
   * silently raise a request about their own day. Correcting for somebody else
   * is not a thing this system does, and the honest response is to not offer it.
   */


  return (
    /*
      From `lg` up this page does not scroll — it fits the viewport and the
      table scrolls inside its own card.

      The height comes from flexbox, not from `calc(100svh - …)`. The shell is
      already a chain of `flex-1` boxes inside a `min-h-svh` provider, so
      `lg:flex-1 lg:min-h-0` here inherits the exact remaining height with no
      arithmetic to get wrong. Guessing at the header and padding is what put a
      scrollbar on a page that had nothing to scroll to.

      `min-h-0` is the load-bearing half: a flex child's default `min-height:
      auto` refuses to shrink below its content, so without it the table pushes
      the page taller instead of scrolling inside itself.

      Below `lg` this all switches off and the page scrolls normally — a fixed
      viewport with two scroll regions on a phone is a trap.
    */
    <PageShell className="gap-3 lg:overflow-hidden">
      <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        {/*
          The left rail. It used to hold the punch panel alone, which is about
          200px tall against a table that runs thirty rows — the rest of that
          column was empty page for the entire scroll.

          The filters moved into it, so the rail is punch + range + export and
          the table gets the whole width of the right column. That is also the
          better home for them: a date range you are adjusting while reading the
          rows should not be a screen-length scroll away from the rows.

          It scrolls itself rather than sticking to the page now: with the page
          height pinned to the viewport there is no page scroll for a sticky
          element to hold still against, and a short window still has to be able
          to reach the Export button.
        */}
        <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
          <PunchPanel initial={punchState} />

          <DtrToolbar
            people={people}
            from={from}
            to={to}
            userId={selectedUser}
            canExport={isLead}
          />

          {/* Said before the numbers, not after them. Somebody reading a total
              that covers only part of the range needs to know that before they
              act on it — and the CSV export is not capped, so the export and
              this screen will disagree until the range is narrowed. */}
          {truncated ? (
            <p
              role="status"
              className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
            >
              More than {DTR_PAGE_SIZE} records match this range, so the list and the totals below
              cover only the most recent {DTR_PAGE_SIZE}. Narrow the dates, or pick one person, to
              see the rest. Export gives you the whole range.
            </p>
          ) : null}

          {/* Said out loud rather than swallowed. A failed leave query renders
              as a record with no leave in it, which is indistinguishable from
              nobody having taken any — the exact "data ?? [] reads as empty"
              trap that hid the broken embed on this page for months. */}
          {leaveResult.error ? (
            <p
              role="status"
              className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
            >
              Approved leave could not be loaded, so days away are not shown below. The punch
              records are unaffected.
            </p>
          ) : null}

          {/* What fills the rest of the rail. The table already totals itself in
              a footer row, but that footer is at the bottom of thirty rows —
              which is no use to the person who opened this page to find out how
              many hours the range came to. Same number, read without scrolling.

              Only when there is something to summarise: four dashes under an
              empty table is furniture, not information. */}
          {entries.length > 0 ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
              <div>
                <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Records</dt>
                {/* Punch records only. The leave rows below are days in the
                    list but not days at work, and adding them here would
                    overstate the figure people read as attendance. */}
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                  {punchEntries.length}
                </dd>
              </div>
              <div>
                <dt className="text-2xs tracking-wide text-muted-foreground uppercase">
                  {truncated ? "Total shown" : "Total"}
                </dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                  {formatDuration(totalMinutes)}
                </dd>
              </div>
              <div>
                <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Average</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                  {formatDuration(averageMinutes)}
                </dd>
              </div>
              <div>
                <dt className="text-2xs tracking-wide text-muted-foreground uppercase">
                  Still open
                </dt>
                {/* Stated in words as well as colour — a warning-coloured number
                    is not a status on its own. */}
                <dd
                  className={
                    stillOpen > 0
                      ? "mt-0.5 text-sm font-semibold tabular-nums text-warning"
                      : "mt-0.5 text-sm font-semibold tabular-nums"
                  }
                >
                  {stillOpen}
                  {stillOpen > 0 ? <span className="sr-only"> days not timed out</span> : null}
                </dd>
              </div>

              {/* Only when there is leave in the range. A permanent "0" here
                  would be a stat that is furniture on most weeks. */}
              {leaveDayCount > 0 ? (
                <div>
                  <dt className="text-2xs tracking-wide text-muted-foreground uppercase">
                    On leave
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums text-info">
                    {leaveDayCount}
                    <span className="sr-only"> approved days away with no punch</span>
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          {/* Kept from the old page heading. It is not decoration: it is why two
              punches on one day collapse into one row, which is the first thing
              anyone asks about their own record. Beside the rail it explains the
              table without costing the table any height. */}
          <p className="px-1 text-xs text-muted-foreground">
            Times are captured by the server — the earliest time-in and the latest time-out for
            each day are what stand.
          </p>
        </div>

        {/* Density lives here, not in components/ui/table.tsx. The shared table
            is `h-10` headers and `p-2` cells because that suits the six other
            lists in the app; the DTR is the one screen people read thirty rows
            of at a time, so it gets tighter rows without dragging Requests and
            Tasks along with it.

            Descendant selectors rather than a `size` prop on DataTable — one
            page wanting denser rows does not justify a new API on the shared
            component, and the day a second page wants it, that is the moment
            to add one. */}
        <DtrTable
          // The card fills the row and the rows scroll inside it, so five
          // hundred days of DTR never make the page itself longer.
          //
          // `[&>div]` is DataTableShell's inner scroller — it already handles
          // the horizontal axis, so it is the right place to add the vertical
          // one rather than nesting a second scroll container inside it.
          //
          // The header sticks to the top of that scroller. `bg-background` and
          // the inset shadow rather than a border: a sticky `th` keeps its own
          // background but a `border-b` declared on the `tr` does not travel
          // with it, so the rule under the headings vanishes on first scroll.
          //
          // `[&_table]:h-full` ONLY when empty — it stretches the table to the
          // card so the empty state centres in it. Left on with rows present it
          // would stretch the ROWS instead, and a three-row range would render
          // as three 200px-tall bands.
          className={`[&_td]:px-2 [&_td]:py-1 [&_th]:h-8 [&_th]:px-2 lg:h-full lg:min-h-0 lg:[&>div]:h-full lg:[&>div]:overflow-y-auto lg:[&_thead_th]:sticky lg:[&_thead_th]:top-0 lg:[&_thead_th]:z-10 lg:[&_thead_th]:bg-background lg:[&_thead_th]:shadow-[inset_0_-1px_0_var(--border)] ${
            entries.length === 0 ? "lg:[&_table]:h-full" : ""
          }`}
          rows={entries}
          viewerId={context.userId}
          showPerson={showPerson}
          empty={
            entriesResult.error ? (
              <QueryError what="your time record" message={entriesResult.error.message} />
            ) : 
            rangeInverted ? (
              // Deliberately NOT swapped behind their back. Silently answering a
              // different question than the one asked is how somebody ends up
              // trusting a range they never set.
              <EmptyState
                className="py-10"
                icon={<Clock />}
                title="That range runs backwards"
                description={`From is ${formatDate(from)} and To is ${formatDate(to)}, so no day can fall inside it. This is not an empty record — swap the two dates to see what is there.`}
                action={
                  <Link
                    href={`/dtr?from=${to}&to=${from}${selectedUser ? `&user=${selectedUser}` : ""}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Swap the dates
                  </Link>
                }
              />
            ) : (
            <EmptyState
              // No min-height of its own any more. The table above is stretched
              // to the card while the list is empty, and TableCell's
              // `align-middle` does the centring — which cannot drift out of
              // step with the layout the way a hardcoded viewport figure did.
              className="py-10"
              icon={<Clock />}
              title="No entries in this range"
              description="Days with no punch have no row at all, apart from approved leave, which is listed. Widen the date range first — if a day is genuinely missing that should not be, raise the correction from here."
              action={
                // F. It carries `from`, the first day of the range being looked
                // at, because that is the only day this screen can name — an
                // empty range has no row to take a date off. The dialog opens on
                // it and the person changes it if they meant another day, which
                // is still one field instead of four steps.
                <Link
                  href={`/approvals?type=NO_TIME_IN&date=${from}`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Raise a No Time-In request
                </Link>
              }
            />
            )
          }
          totalLabel={truncated ? `Total of the first ${DTR_PAGE_SIZE} shown` : "Total in range"}
          totalMinutes={totalMinutes}
        />
      </div>
    </PageShell>
  );
}

/**
 * F — a link from a gap in the DTR to the request that fixes it.
 *
 * NOT a new request type, a new table or a new approval path. Phase 5 already
 * shipped `NO_TIME_IN` and `NO_TIME_OUT`, and
 * `vizserve_pms_decide_internal_request` is the only path allowed to overwrite an
 * earliest time-in on approval — which is what makes an un-overwritable punch
 * safe to insist on. Building a second route would mean building the one without
 * the DTR write-back.
 *
 * What was missing was the way in. Somebody looking at the gap was told to
 * "raise a No Time-In request from Approvals", so they left the screen showing
 * the problem, opened a dialog, chose the type and retyped the date they had
 * just been reading. Every one of those steps is a chance to file the correction
 * against the wrong day.
 *
 * A LINK, not a button — it navigates (§2.1). The two parameters are narrowed
 * again on arrival by `narrowRequestPrefill`, so this and a hand-typed URL are
 * treated identically.
 */
