import { addDays, todayInAppZone, workedMinutes, yesterdayInAppZone } from "@/lib/dates";
import {
  deviation as computeDeviation,
  effectiveEnd,
  scheduleFor,
} from "@/lib/dtr-schedule";
import { expandLeaveDays, leaveKey, type LeaveDay, type LeaveSpan } from "@/lib/leave";
import { parse, parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import { readAppSettings, type TimesheetReadClient } from "@/lib/query/fetchers/timesheet";
import { TIME_CORRECTION_TYPES } from "@/lib/schemas/internal-requests";
import {
  dayRequestRowSchema,
  dtrLeaveSpanRowSchema,
  dtrPersonRowSchema,
  dtrPunchRowSchema,
  ownOvertimeRowSchema,
  ownPunchRowSchema,
  ownScheduleRowSchema,
  type DayRequestRow,
  type DtrPersonRow,
  type DtrPunchRow,
} from "@/lib/schemas/time-records";
import type { Entry as DtrTableEntry } from "@/app/(app)/dtr/dtr-table";
import type { PunchState } from "@/app/(app)/dtr/punch-panel";

/**
 * P12-23 — the reads behind `/dtr` and behind "am I timed in?".
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. `app/(app)/dtr/page.tsx` was a 918-line RSC holding five
 * queries, two Suspense boundaries fed by one promise, and every derivation
 * below. Changing the date range re-rendered the route; a punch went through
 * `revalidatePath("/dtr")` and re-read five hundred days to move one time-in.
 *
 * ⚠️ TWO KEYS, NOT ONE, AND THE SPLIT IS THE POINT OF THE PAGE. `qk.punchState()`
 * is the panel people open this screen to CLICK, and it is four small reads;
 * `qk.dtrView(filters)` is a five-hundred-row read they are only going to
 * scroll. The RSC had already separated them behind boundaries for exactly this
 * reason — "the punch panel is the thing people open this page to click, and it
 * was waiting on a five-hundred-row read it shares nothing with". Two keys is
 * the same separation with the refetches split as well.
 *
 * ⚠️ `qk.punchState()` IS SHARED WITH `/`, `/dashboard` AND THE SHELL. The punch
 * panel renders on three screens and the clock reminder watches the same facts
 * from the app shell, so this is one cache entry per tab rather than four reads
 * per route. P8-12 moved the reminder OUT of the layout because six queries on
 * every authenticated page contributed to a request burst that failed with
 * `TypeError: fetch failed`; this is what stops it coming back.
 *
 * ⚠️ SCOPE IS RLS'S JOB. `vizserve_pms_dtr_entries` is readable by the owner and
 * by department leads, and the same self-or-managed-department shape covers the
 * internal requests. Not one query below carries a department filter and none
 * may grow one — restating it would imply the policy were optional (CLAUDE.md).
 * ------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/* `qk.punchState()` — today's row, yesterday's if it is open, and the rules.  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ THIS IS `loadPunchState` FROM `lib/dtr-server.ts`, MOVED TO THE BROWSER,
 * AND ONE THING CHANGED ON THE WAY: THE `?? []`s ARE GONE.
 *
 * That file argued for them and the argument was honest at the time — "this
 * component renders on `/`, `/dashboard` and `/dtr`, there is no `error.tsx`
 * anywhere in this app (checked), so a throw here is a blank page on three
 * screens for one card" — so it logged the failure and rendered "Not timed in"
 * to somebody who timed in at 08:52. There is an `app/(app)/error.tsx` now, and
 * more to the point a query that throws lands in `isError`, where the PANEL can
 * say "couldn't load" and the three pages around it are untouched. That is the
 * whole of P12-01: a failed read must not be indistinguishable from a legal
 * empty one, and "Not timed in" is the most consequential empty state in the
 * product to get wrong.
 *
 * The SERVER copy stays exactly as it is. `/`, `/dashboard` and `/dtr` still
 * call it to SEED this key — see `PunchPanel` — so its degrade still covers the
 * first paint, and this covers every refetch after it.
 */
export async function fetchPunchState(
  client: TimesheetReadClient,
  userId: string,
): Promise<PunchState> {
  const today = todayInAppZone();
  const yesterday = yesterdayInAppZone();

  // Four reads, no dependencies between them.
  const [entryRows, profileRow, overtimeRows, settings] = await Promise.all([
    read<unknown[]>(
      client
        .from("vizserve_pms_dtr_entries")
        .select("work_date, time_in, time_out")
        .eq("user_id", userId)
        .in("work_date", [today, yesterday]),
    ),

    read<unknown>(
      client
        .from("vizserve_pms_users")
        .select("work_start, work_end")
        .eq("id", userId)
        .maybeSingle(),
    ),

    /**
     * Overtime ALREADY APPROVED for today, which extends the day this person is
     * expected to work. Without it, staying two hours late on a day their lead
     * signed off reads as a deviation and the app asks them to file a correction
     * for the overtime they already filed a request for.
     *
     * Approved only. A pending request is a proposal, and treating it as
     * authorisation would let anyone silence the prompt by asking.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_internal_requests")
        .select("overtime_minutes")
        .eq("requester_id", userId)
        .eq("request_type", "OVERTIME")
        .eq("status", "APPROVED")
        .eq("work_date", today),
    ),

    readAppSettings(client),
  ]);

  const rows = parseAll(ownPunchRowSchema, entryRows, "your punches");
  const todayRow = rows.find((row) => row.work_date === today) ?? null;
  const yesterdayRow = rows.find((row) => row.work_date === yesterday) ?? null;

  // Summed, not "the first one": a day can carry more than one approved overtime
  // request, and taking one of them would under-extend the day.
  const approvedOvertimeMinutes = parseAll(
    ownOvertimeRowSchema,
    overtimeRows,
    "approved overtime",
  ).reduce((total, row) => total + (row.overtime_minutes ?? 0), 0);

  return {
    today: todayRow
      ? { work_date: todayRow.work_date, time_in: todayRow.time_in, time_out: todayRow.time_out }
      : { work_date: today, time_in: null, time_out: null },
    // Open means timed in and not out. A day with neither is not an unfinished
    // shift, it is a day off — offering to "close" it would write a time-out
    // with no time-in, which the punch function refuses anyway.
    openYesterday:
      yesterdayRow?.time_in && !yesterdayRow.time_out
        ? { work_date: yesterdayRow.work_date, time_in: yesterdayRow.time_in }
        : null,
    schedule: scheduleFor(
      profileRow === null ? {} : parse(ownScheduleRowSchema, profileRow, "your working hours"),
    ),
    graceMinutes: settings.graceMinutes,
    approvedOvertimeMinutes,
  };
}

/* -------------------------------------------------------------------------- */
/* `qk.dtrView(filters)` — the record itself.                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many rows the list renders. The query asks for one more, so truncation is
 * detectable without a second count query.
 */
export const DTR_PAGE_SIZE = 500;

/*
 * P7-65 — THE SORT ALLOWLIST.
 *
 * `?sort=` is user input, so it picks a LITERAL column here rather than being
 * interpolated into `.order()`. The range is capped at `DTR_PAGE_SIZE + 1`,
 * which is exactly why the table sets `urlSort` and lets Postgres order:
 * sorting the truncated page in the browser would claim an ordering of days it
 * never received.
 */
export const DTR_SORTS = ["date", "in", "out"] as const;
export type DtrSort = (typeof DTR_SORTS)[number];

/*
 * The order applied when the URL asks for none. Newest day first — a record is
 * read backwards from the most recent day, which is what this screen is opened
 * for. `dtr-table.tsx` passes the same pair to `DataTable` as `defaultSort`, and
 * that is the only reason its header can draw an arrow for an order nobody put
 * in the query string. One fact stated on either side of the wire: change one
 * and change the other, or the header goes back to lying.
 */
export const DTR_DEFAULT_SORT = { sort: "date", ascending: false } as const;

const DTR_ORDER: Record<DtrSort, string> = {
  date: "work_date",
  in: "time_in",
  out: "time_out",
};

/**
 * ⚠️ THE ROW SHAPE IS `dtr-table.tsx`'S `Entry` AND IS DELIBERATELY NOT
 * RE-DECLARED HERE. That component owns the columns and the type travels with
 * them; a second declaration would be the one place a dropped field could hide.
 * It is a TYPE-ONLY import of a `"use client"` module, which is erased at
 * compile time — `lib/dtr-server.ts` reaches for `PunchState` the same way.
 */
export type DtrView = {
  entries: DtrTableEntry[];
  /** Punch rows only, for the "Records" figure. Leave days are not days at work. */
  punchCount: number;
  truncated: boolean;
  totalMinutes: number;
  averageMinutes: number | null;
  stillOpen: number;
  leaveDayCount: number;
  /**
   * The toolbar's person picker, and `nameOf` for the synthesised leave rows.
   * Empty for a plain member: there is nobody else they may look at.
   */
  people: DtrPersonRow[];
  /**
   * ⚠️ THE LEAVE READ IS THE ONE THAT DEGRADES, and this is how it says so. A
   * failed leave query renders as a record with no leave in it, which is
   * indistinguishable from nobody having taken any — the exact "data ?? [] reads
   * as empty" trap that hid a broken embed on this page for months. The punch
   * records are unaffected, so the banner says that and the rows still render.
   */
  leaveError: string | null;
};

export type DtrViewParams = {
  from: string;
  to: string;
  selectedUser: string | null;
  sort: DtrSort;
  ascending: boolean;
  /** A range that runs backwards matches nothing. See the page. */
  rangeInverted: boolean;
  /** Team leader and above. Decided on the server; see `page.tsx`. */
  isLead: boolean;
};

export async function fetchDtrView(
  client: TimesheetReadClient,
  params: DtrViewParams,
): Promise<DtrView> {
  const { from, to, selectedUser, sort, ascending, rangeInverted, isLead } = params;

  const [punchRows, leaveResult, requestRowsRaw, settings, peopleRows] = await Promise.all([
    // ONE MORE THAN WE RENDER.
    //
    // The cap has to exist — an unbounded query over a whole department and an
    // arbitrary date range is how a page falls over. But a silent cap on THIS
    // page is worse than most, because the rail and the footer add up the rows
    // that came back and present the result as "Total in range". A lead looking
    // at sixteen people over thirty days is already near 480 rows; past the cap
    // the total quietly understates, and it is a payroll number.
    //
    // Asking for PAGE_SIZE + 1 makes truncation detectable without a second
    // count query: if the extra row arrives, there is more than we are showing,
    // and the screen has to say so rather than do arithmetic on a slice and call
    // it a total.
    read<unknown[]>(
      (() => {
        // THE FK MUST BE NAMED. `vizserve_pms_dtr_entries` has TWO foreign keys
        // to `vizserve_pms_users` — `user_id` and `corrected_by` — so an
        // unqualified embed is ambiguous and PostgREST refuses the whole query
        // with "more than one relationship was found".
        //
        // This shipped broken and looked empty for months: the page read
        // `data ?? []` and rendered "No entries in this range", which is exactly
        // what an empty record looks like. Naming the constraint is the fix;
        // a throwing `read()` is what makes the next one visible.
        //
        // Left embed rather than `!inner`, for the same reason as the timesheet:
        // a row whose person is out of scope should lose its name, not its hours.
        let query = client
          .from("vizserve_pms_dtr_entries")
          .select(
            "id, work_date, time_in, time_out, corrected_at, user_id, vizserve_pms_users!vizserve_pms_dtr_entries_user_id_fkey(full_name, work_start, work_end)",
          )
          .gte("work_date", from)
          .lte("work_date", to)
          .order(DTR_ORDER[sort], { ascending, nullsFirst: false })
          // A stable tie-break: two people punching on the same day must not
          // swap places between renders.
          .order("work_date", { ascending: false })
          .limit(DTR_PAGE_SIZE + 1);

        if (selectedUser) query = query.eq("user_id", selectedUser);
        return query;
      })(),
    ),

    /*
     * APPROVED LEAVE — the days this list used to have nothing to say about.
     *
     * A day off has no `dtr_entries` row, so it was an invisible gap: the empty
     * state says "days with no punch have no row at all", and somebody scanning
     * their record for a missing punch had no way to tell an approved absence
     * from a day the system lost. Worse, a lead reading a member's record saw a
     * silent hole.
     *
     * The ordinary policy on internal requests, NOT `vizserve_pms_leave_calendar`.
     * The calendar is SECURITY DEFINER and returns every active user; this page
     * is scoped, and borrowing the calendar would show a member days belonging to
     * people whose DTR they cannot read.
     *
     * `reason` is not selected. The absence belongs on this screen; why belongs
     * to the requester and the lead who decided it.
     *
     * ⚠️ TOLERATED RATHER THAN THROWN, WHICH IS THE ONE DEGRADE ON THIS SCREEN.
     * The punch records are what the page is for and they are unaffected by this
     * read; taking them away because the leave half failed would be the worse
     * trade. It is NOT a `?? []`: the failure travels out as `leaveError` and the
     * banner in the rail prints it.
     */
    (async () => {
      try {
        const rows = await read<unknown[]>(
          (() => {
            let query = client
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
        );
        return { rows, error: null as string | null };
      } catch (error) {
        return {
          rows: null,
          error: error instanceof Error ? error.message : "Unknown error.",
        };
      }
    })(),

    /*
     * P7-40 — THE REQUESTS ATTACHED TO THESE DAYS.
     *
     * The visibility rule needs no code — it is already the RLS on
     * `vizserve_pms_internal_requests`, `requester_id = auth.uid() or
     * manages_department(department_id)`, which is the same shape as the DTR's
     * own policy. So this query carries NO user filter beyond the picker's and no
     * role branch, and the two screens agree by construction.
     *
     * Corrections AND approved overtime, in one round trip. They land in the same
     * column because they answer the same question — "is there paperwork on this
     * day?" — and because a second query for at most a handful of rows is latency
     * spent on tidiness.
     *
     * `correction_at` comes back so a pending correction can say what it is
     * asking for. Reading it before anybody decides is the point: a lead scanning
     * the table sees "they say 09:00" beside the 09:26 that was recorded.
     */
    read<unknown[]>(
      (() => {
        let query = client
          .from("vizserve_pms_internal_requests")
          .select(
            "id, request_type, status, work_date, requester_id, correction_at, overtime_minutes",
          )
          .in("request_type", [...TIME_CORRECTION_TYPES, "OVERTIME"])
          .gte("work_date", from)
          .lte("work_date", to)
          .order("created_at", { ascending: false });

        if (selectedUser) query = query.eq("requester_id", selectedUser);
        return query;
      })(),
    ),

    readAppSettings(client),

    /*
     * The picker only makes sense for someone who can see more than themselves.
     * Reads through the same RLS as the list, so it cannot offer a person whose
     * rows would then come back empty.
     */
    isLead
      ? read<unknown[]>(
          client
            .from("vizserve_pms_users")
            .select("id, full_name")
            .eq("is_active", true)
            .order("full_name"),
        )
      : Promise.resolve([] as unknown[]),
  ]);

  const fetched = parseAll(dtrPunchRowSchema, punchRows, "your time record");
  // The extra row is a signal, not data. Drop it before anything is counted.
  const truncated = fetched.length > DTR_PAGE_SIZE;
  const rows: DtrPunchRow[] = truncated ? fetched.slice(0, DTR_PAGE_SIZE) : fetched;

  const people = parseAll(dtrPersonRowSchema, peopleRows, "people");
  const nameOf = new Map(people.map((row) => [row.id, row.full_name] as const));

  const spans: LeaveSpan[] = (leaveResult.rows === null
    ? []
    : parseAll(dtrLeaveSpanRowSchema, leaveResult.rows, "approved leave")
  )
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
  // keeps this honest with the empty state that explains itself on the page.
  const leaveDays = rangeInverted ? new Map<string, LeaveDay>() : expandLeaveDays(spans, from, to);

  const punchedKeys = new Set(rows.map((row) => leaveKey(row.user_id, row.work_date)));

  /*
   * Requests indexed by person and day, the same `user|date` key the leave map
   * uses so both lookups read alike.
   *
   * Approved overtime is pulled out separately because it does two jobs: it
   * shows on the row, AND it extends the day's scheduled end so that working the
   * hours you were authorised to work is not then reported as a deviation.
   * Summed rather than taken singly — one day can carry more than one approved
   * overtime request.
   */
  const requestRows: DayRequestRow[] = parseAll(
    dayRequestRowSchema,
    requestRowsRaw,
    "the requests on these days",
  );

  const requestsByDay = new Map<string, DayRequestRow[]>();
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

  const punchEntries: DtrTableEntry[] = rows.map((row) => {
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
   * Synthetic ids, prefixed so they cannot collide with a real uuid and so a key
   * in the DOM says what it is.
   */
  const leaveEntries: DtrTableEntry[] = [...leaveDays]
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
        // correction or an overtime filed against the same date, and hiding them
        // here would make a row that exists to explain a day explain less of it
        // than a punched row does.
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
  const sortedOn = (entry: DtrTableEntry): string | null =>
    sort === "in" ? entry.time_in : sort === "out" ? entry.time_out : entry.work_date;

  // Ties broken by name so a day with several people on it does not reshuffle
  // between renders.
  const tieBreak = (a: DtrTableEntry, b: DtrTableEntry) =>
    (a.vizserve_pms_users?.full_name ?? "").localeCompare(b.vizserve_pms_users?.full_name ?? "") ||
    a.user_id.localeCompare(b.user_id);

  const entries = [...punchEntries, ...leaveEntries].sort((a, b) => {
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
    return (ascending ? ordered : -ordered) || tieBreak(a, b);
  });

  const totalMinutes = entries.reduce(
    (sum, entry) => sum + (workedMinutes(entry.time_in, entry.time_out) ?? 0),
    0,
  );

  // The average divides by records that actually closed. Dividing by all of them
  // would quietly drag the figure down every time somebody forgot to time out —
  // which is the very thing "Still open" is there to point at.
  const closed = entries.filter((entry) => workedMinutes(entry.time_in, entry.time_out) !== null);
  const stillOpen = entries.filter((entry) => entry.time_in && !entry.time_out).length;

  return {
    entries,
    // Counted apart from the punch records on purpose. Folding leave into
    // "Records" would inflate a figure people read as "days I was at work".
    punchCount: punchEntries.length,
    truncated,
    totalMinutes,
    averageMinutes: closed.length > 0 ? Math.round(totalMinutes / closed.length) : null,
    stillOpen,
    leaveDayCount: leaveEntries.length,
    people,
    leaveError: leaveResult.error,
  };
}

/**
 * The default range, so the page and anything that links into it agree.
 *
 * The last 30 days rather than the calendar month: on the 1st, a month-to-date
 * view is one row and looks broken.
 */
export function defaultDtrRange(today: string): { from: string; to: string } {
  return { from: addDays(today, -29)!, to: today };
}
