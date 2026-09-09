import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Clock, LayoutDashboard, LogOut, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import type { DayHalf } from "@/lib/leave";
import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import { listWaitingOnYou } from "@/lib/approvals-queue-server";
import { loadPunchState } from "@/lib/dtr-server";
import {
  addMonths,
  formatAppTime,
  formatDate,
  isOverdue,
  relativeDays,
  todayInAppZone,
} from "@/lib/dates";
import { BrandLockup } from "@/components/brand-lockup";
import { PageShell } from "@/components/page-shell";
import { ThemeToggle } from "@/components/theme-toggle";
import { Chip, TaskStatusBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { createClient } from "@/utils/supabase/server";
import { signOut } from "@/app/login/actions";

import { PunchPanel } from "@/app/(app)/dtr/punch-panel";
import { eventScopeLabel, type EventCategory } from "@/lib/schemas/events";
import {
  LeaveCalendar,
  type CalendarEvent,
  type Holiday,
  type LeaveSpan,
} from "./_home/leave-calendar";
import { LeaveTooltip } from "./_home/leave-entry";
import { Cell, CellBody, CellHead, StatStrip, initials } from "./_home/home-widgets";
import { HomeNewTaskAction } from "./_home/new-task-action";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Home" };


/**
 * ⚠️ A SUSPENSE FALLBACK IS ANNOUNCED BY NOBODY.
 *
 * `components/skeletons.tsx` hides its skeletons from assistive technology, and
 * the reason it gives belongs to `loading.tsx`: the ROUTER announces that
 * navigation, so a second announcement would interrupt it. Nothing announces a
 * boundary that streams inside a page which has already rendered — so every
 * fallback below is a `role="status"` region carrying `aria-busy` and a label
 * that names its tile, and only the grey bars inside stay `aria-hidden`. Six of
 * them are on screen at once on this page, which is exactly why each one says
 * which tile it is rather than "Loading".
 */
function Streaming({
  label,
  className,
  inline = false,
  children,
}: {
  label: string;
  className?: string;
  /** A `<span>` rather than a `<div>`, for the two fallbacks that sit inside
      running text — a block element inside a `<p>` is invalid HTML. */
  inline?: boolean;
  children: React.ReactNode;
}) {
  const Tag = inline ? "span" : "div";

  return (
    <Tag role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </Tag>
  );
}

/**
 * The inline bar. `Skeleton` renders a `<div>`, which cannot go inside the
 * greeting's `<p>`, so this is the same three classes on a span.
 */
function InlineBar({ className }: { className: string }) {
  return (
    <span aria-hidden className={cn("inline-block animate-pulse rounded-sm bg-track", className)} />
  );
}

/**
 * A cell's frame with grey bars in it.
 *
 * The FRAME is not a placeholder — `Cell` and `CellHead` are the real ones, so
 * the bento's shape is correct from the first paint and only the contents
 * arrive late. That is the difference between a page that fills in and a page
 * that rearranges itself.
 *
 * The head carries no `count`: a zero that turns into a seven is a worse lie
 * than a heading with no badge yet.
 */
function CellFallback({
  span,
  label,
  title,
  rows = 3,
}: {
  span: string;
  label: string;
  title: string;
  rows?: number;
}) {
  return (
    <Cell span={span} label={label}>
      <CellHead title={title} />
      <CellBody className="p-3">
        <Streaming label={`Loading ${label.toLowerCase()}…`} className="flex-1 space-y-2.5">
          {Array.from({ length: rows }, (_, index) => (
            <Skeleton key={index} className="h-6 w-full" aria-hidden />
          ))}
        </Streaming>
      </CellBody>
    </Cell>
  );
}

/**
 * The calendar's own frame, which is NOT a `Cell` — it is the section
 * `leave-calendar.tsx` draws, repeated here so the six-column row keeps its
 * height while the three-month RPC is still running. The `min-h` is the ~430px
 * the grid comment above says six week rows need; anything shorter and the page
 * visibly grows under the reader's cursor when the days land.
 */
function CalendarFallback() {
  return (
    <section
      aria-label="Leave and vacation"
      className="flex flex-col overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg sm:col-span-6"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3.5 py-1.5">
        <h2 className="text-sm font-semibold tracking-[-0.012em]">Leave &amp; vacation</h2>
      </div>
      <Streaming label="Loading the leave calendar…" className="flex-1 p-2.5">
        <Skeleton className="h-full min-h-[26rem] w-full" aria-hidden />
      </Streaming>
    </section>
  );
}

/**
 * EVERYONE'S APPROVED LEAVE PLUS YOUR OWN PENDING, read once for the two places
 * that paint it. "Out today" and the calendar are built from this one array on
 * purpose — see the widget's own comment — so this is one promise awaited twice
 * rather than two boundaries each running the RPC.
 */
async function loadHomeSpans({
  supabase,
  context,
  gridFrom,
  gridTo,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof requireAuthContext>>;
  gridFrom: string;
  gridTo: string;
}) {
  const [approvedLeave, myPendingLeave] = await Promise.all([
    /*
     * P7-10 — everyone's approved leave, through the SECURITY DEFINER function.
     *
     * NOT a select on `vizserve_pms_internal_requests`: that table's policy
     * scopes rows to the requester and to leads of the department, so a member
     * reading it directly would see a calendar containing only themselves. The
     * function returns name and dates and withholds the reason, which is the
     * one thing RLS cannot express — a policy grants a row, not a column.
     *
     * A month either side, so a span that starts in July and ends in August
     * still paints its August days.
     */
    supabase.rpc("vizserve_pms_leave_calendar", { p_from: gridFrom, p_to: gridTo }),

    // Your OWN pending leave, through the ordinary policy. Nobody else's
    // pending appears anywhere: a request that has not been decided is not yet
    // a fact, and broadcasting it tells the company you asked for time off
    // before your own lead has seen it.
    //
    // P7-42 — the halves and the type come too, and NO MASKING APPLIES. These
    // are your own rows, reaching you through the ordinary policy rather than
    // through the calendar function, so the rule that hides a confidential type
    // from your colleagues has nothing to say about showing it to you. The
    // embedded select mirrors the one already proven in app/(app)/dtr/page.tsx.
    supabase
      .from("vizserve_pms_internal_requests")
      .select("id, start_date, end_date, start_half, end_half, vizserve_pms_leave_types(label)")
      .eq("requester_id", context.userId)
      .eq("request_type", "LEAVE")
      .eq("status", "PENDING_REVIEW"),
  ]);

  /*
   * ⚠️ P12-01 — LOGGED, AND THE `?? []` BELOW SURVIVES ON PURPOSE.
   *
   * Both reads feed ONE array that two surfaces paint: the "Out today" widget
   * and the three-month calendar. A failure in either currently renders as
   * "Nobody is out today" over an empty grid — a claim about the company, not
   * an absence of data — and until this log there was no trace of it anywhere.
   *
   * It is a log rather than an `unavailable` state because saying so properly
   * means giving `loadHomeSpans` a return shape and teaching both
   * `leave-calendar.tsx` and the widget to render it, which is a larger change
   * than this sweep should make on its own. It is written up as a
   * recommendation instead. What is NOT acceptable is the third option, which
   * was silence.
   */
  const leaveFailure = approvedLeave.error ?? myPendingLeave.error ?? null;

  if (leaveFailure) {
    console.error(`[home] the leave calendar could not be read — ${leaveFailure.message}`);
  }

  // ----------------------------------------------------------------- leave
  //
  // P7-42. `type_label` arrives null for two reasons this page cannot tell apart
  // and must not try to — leave filed before P7-12 had no type, and a
  // LABEL_HIDDEN type is withholding one. Both read "On leave" downstream. A
  // HIDDEN type never appears in `approvedLeave` at all unless it is yours.
  const spans: LeaveSpan[] = [
    ...(
      (approvedLeave.data ?? []) as {
        user_id: string;
        full_name: string;
        start_date: string;
        end_date: string;
        start_half: DayHalf | null;
        end_half: DayHalf | null;
        type_label: string | null;
      }[]
    ).map((row) => ({
      userId: row.user_id,
      name: row.full_name,
      start: row.start_date,
      end: row.end_date,
      startHalf: row.start_half,
      endHalf: row.end_half,
      typeLabel: row.type_label,
    })),
    ...(myPendingLeave.data ?? [])
      .filter((row) => row.start_date && row.end_date)
      .map((row) => ({
        userId: context.userId,
        name: context.fullName,
        start: row.start_date!,
        end: row.end_date!,
        startHalf: row.start_half,
        endHalf: row.end_half,
        // An object, not an array: `leave_type_id` is a single FK, and PostgREST
        // embeds a to-one relationship as one row.
        typeLabel: row.vizserve_pms_leave_types?.label ?? null,
        pending: true,
      })),
  ];

  return spans;
}

/** The chip in the DTR cell's head. */
async function PunchChip({ punchState }: { punchState: ReturnType<typeof loadPunchState> }) {
  const timeIn = (await punchState).today?.time_in ?? null;

  return (
    <Chip
      tone={timeIn ? "success" : "neutral"}
      label={timeIn ? "Timed in" : "Not timed in"}
      className="ml-auto"
    />
  );
}

/** The DTR cell's body. The "My DTR" link beside it never waited for anything. */
async function HomePunch({
  punchState,
  viewerId,
}: {
  punchState: ReturnType<typeof loadPunchState>;
  /** P12-23 — names the `qk.punchState()` entry this panel shares with `/dtr`. */
  viewerId: string;
}) {
  return <PunchPanel initial={await punchState} viewerId={viewerId} compact />;
}

/** The greeting's second half. `formatDate(today)` beside it needs no read at all. */
async function TimedInLine({ punchState }: { punchState: ReturnType<typeof loadPunchState> }) {
  const timeIn = (await punchState).today?.time_in ?? null;

  return <>{timeIn ? ` · timed in at ${formatAppTime(timeIn)}` : " · not timed in yet"}</>;
}

/** Row 1, right — the approver's queue. */
async function WaitingCell({
  supabase,
  context,
  isApprover,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof requireAuthContext>>;
  isApprover: boolean;
}) {
  /*
   * THREE QUEUES, NOT ONE — and the mapping lives in ONE place now.
   *
   * This was forty lines of inline query-and-map here, and slice I's dashboard
   * needed the same rows. Two copies of "what is in a lead's queue" is the
   * divergence `lib/approvals-queue-server.ts` was extracted to stop, so the
   * listing moved in beside the counting.
   *
   * None of the three carries a department filter: all three tables scope by
   * policy through `vizserve_pms_manages_department`, and restating it would
   * imply the policy is optional.
   */
  const { rows: waiting, error: waitingError } = await listWaitingOnYou(
    supabase,
    context,
    isApprover,
    5,
  );

  // ---------------------------------------------------------------- waiting
  // Built by `listWaitingOnYou`. Nothing left to do here but count it — the
  // shaping that used to live in this block is shared with /dashboard.
  //
  // ⚠️ P12-01 — `null` WHEN A QUEUE COULD NOT BE READ, and `waiting.length` is
  // then a floor rather than a total. `CellHead` draws a dash for null; a badge
  // reading "0" over a queue nobody could read is the wrong zero this whole
  // module exists to prevent.
  const waitingTotal = waitingError ? null : waiting.length;

  return (
    <Cell span="sm:col-span-3" label="Waiting on you">
      <CellHead
        title="Waiting on you"
        count={waitingTotal}
        tone="warning"
        action={
          <Link
            href="/approvals"
            aria-label="Open approvals"
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ArrowRight />
          </Link>
        }
      />
      <CellBody>
        {/*
          ⚠️ P12-01 — THE FAILED READ GETS ITS OWN SENTENCE, and it goes FIRST.

          "Nothing awaiting your decision" is written to reassure, and that is
          exactly what makes it dangerous over a queue that failed to load: a
          lead holding four leave requests and three handed-in weeks reads it,
          believes it and closes the tab. The rows that DID arrive are still
          listed underneath — a partial queue plus an admission is more than
          either half — so this is a line above them rather than a takeover.

          `role="status"`, not `alert`: this is a cell on a landing page, and
          the whole surface is furniture people scan. Same call as the rail.
        */}
        {waitingError ? (
          <p
            role="status"
            className="border-b px-4 py-2 text-2xs text-balance text-muted-foreground"
          >
            Some of your queue couldn&rsquo;t be loaded, so this may be short.
            Open <span className="font-medium text-foreground">Approvals</span> for the
            full list.
          </p>
        ) : null}

        {waiting.length === 0 && !waitingError ? (
          <p className="m-auto px-4 py-3 text-center text-xs text-balance text-muted-foreground">
            Nothing awaiting your decision. Requests appear here the moment somebody files
            one.
          </p>
        ) : (
          waiting.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className="flex flex-1 items-center gap-2.5 border-b px-4 py-2 last:border-b-0 hover:bg-muted/50"
            >
              <Chip tone={item.tone} label={item.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{item.title}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {item.who}
                </span>
              </span>
              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                {/* The module returns a DATE; the tense is this page's
                    choice. "3 days ago" is what a queue wants. */}
                {relativeDays(item.since)}
              </span>
            </Link>
          ))
        )}
      </CellBody>
    </Cell>
  );
}

/** Row 1, right — what a member gets in the same slot. */
async function YoursToMoveCell({
  supabase,
  context,
  myTasks: myTasksPromise,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof requireAuthContext>>;
  myTasks: Promise<{ count: number | null; error: { message: string } | null }>;
}) {
  const [myTasks, myOpenTasks] = await Promise.all([
    myTasksPromise,

    // The member's own open work, as ROWS. The cell that used to sit here held
    // a count and a sentence telling you to go and look somewhere else, which
    // is a cell that has not earned its half of the row.
    supabase
      .from("vizserve_pms_tasks")
      .select("id, title, status, due_date")
      .eq("assignee_id", context.userId)
      .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(5),
  ]);

  /*
   * ⚠️ P12-01 — NULL, NOT `?? 0`, AND A DIFFERENT SENTENCE UNDER IT.
   *
   * A failed head count arrives as `{ count: null, error }` and a failed row
   * read as `{ data: null, error }`. Both used to end in a fallback, so the
   * cell drew a `0` badge over "Nothing is assigned to you right now. Work
   * lands here when a Team Leader approves a request…" — a complete, plausible,
   * reassuring account of a broken query, told to somebody holding twenty-two
   * open tasks. That is the exact pair of bugs `lib/query/read.ts` was written
   * for, in the place a person looks first every morning.
   */
  const myTasksCount = myTasks.error ? null : (myTasks.count ?? 0);
  const openRows = myOpenTasks.data ?? [];

  return (
    <Cell span="sm:col-span-3" label="Your work">
      <CellHead
        title="Yours to move"
        count={myTasksCount}
        tone="brand"
        action={
          <Link
            href="/tasks?view=mine"
            aria-label="Open my tasks"
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ArrowRight />
          </Link>
        }
      />
      <CellBody>
        {myOpenTasks.error ? (
          // The honest short sentence, not the PostgREST code — this is a cell
          // on a landing page and the message belongs in the dev log, which now
          // has it. Same posture the rail takes in `nav-projects.tsx`.
          <p
            role="status"
            className="m-auto px-4 py-3 text-center text-xs text-balance text-muted-foreground"
          >
            Your work couldn&rsquo;t be loaded. This is a fault, not an empty
            plate — open <span className="font-medium text-foreground">My tasks</span> to
            try again.
          </p>
        ) : openRows.length === 0 ? (
          <p className="m-auto px-4 py-3 text-center text-xs text-balance text-muted-foreground">
            Nothing is assigned to you right now. Work lands here when a Team Leader
            approves a request or hands you something directly.
          </p>
        ) : (
          openRows.map((task) => {
            // Overdue matters on live work only, and every one of these
            // is live by construction — the query excludes both
            // terminal statuses.
            const late = isOverdue(task.due_date);

            return (
              <Link
                key={task.id}
                href={`/tasks/${task.id}`}
                className="flex flex-1 items-center gap-2.5 border-b px-4 py-2 last:border-b-0 hover:bg-muted/50"
              >
                <TaskStatusBadge status={task.status} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {task.title}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-2xs tabular-nums",
                    late ? "font-semibold text-destructive" : "text-muted-foreground",
                  )}
                >
                  {/* Never colour alone. */}
                  {task.due_date ? formatDate(task.due_date) : "No date"}
                  {late ? " · overdue" : null}
                </span>
              </Link>
            );
          })
        )}
      </CellBody>
    </Cell>
  );
}

/** Row 2, left — three counts in one cell. */
async function StatStripSection({
  supabase,
  context,
  myTasks: myTasksPromise,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof requireAuthContext>>;
  myTasks: Promise<{ count: number | null; error: { message: string } | null }>;
}) {
  const [unread, myTasks, myQa] = await Promise.all([
    supabase
      .from("vizserve_pms_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),

    myTasksPromise,

    supabase
      .from("vizserve_pms_tasks")
      .select("id", { count: "exact", head: true })
      .eq("qa_assignee_id", context.userId)
      .in("status", ["FOR_QA", "QA_IN_PROGRESS"]),
  ]);

  /*
   * ⚠️ P12-01 — THREE COUNTS, THREE INDEPENDENT ANSWERS, AND `?? 0` GAVE THE
   * SAME ONE TO A FAILURE AND TO A QUIET WEEK.
   *
   * `head: true` ships no rows, so a successful count arrives as
   * `{ count: n, data: null }` and a failed one as `{ count: null, error }` —
   * the fallback could not tell them apart, and three zeroes side by side is
   * the most confident thing this page says. Each is folded separately rather
   * than as a group: two counts that came back are still worth reading, and
   * blanking all three because one failed would hide facts we have.
   *
   * `StatStrip` draws a dash with `count unavailable` for null.
   */
  const countOf = (result: { count: number | null; error: unknown }) =>
    result.error ? null : (result.count ?? 0);

  return (
    <StatStrip
      span="sm:col-span-2"
      stats={[
        { label: "My tasks", value: countOf(myTasks), href: "/tasks?view=mine" },
        { label: "On my QA", value: countOf(myQa), href: "/tasks?view=qa" },
        { label: "Unread", value: countOf(unread), href: "/inbox" },
      ]}
    />
  );
}

/** Row 2, right — who is away, from the same spans the calendar paints. */
async function OutTodayCell({
  spans: spansPromise,
  today,
}: {
  spans: ReturnType<typeof loadHomeSpans>;
  today: string;
}) {
  const spans = await spansPromise;

  // Out today comes from the SAME spans the calendar paints, so the widget and
  // the grid can never disagree about who is away.
  const outToday = spans.filter(
    (span) => !span.pending && span.start <= today && span.end >= today,
  );

  return (
    <Cell span="sm:col-span-2" label="Out of office today">
      <CellHead title="Out today" count={outToday.length} tone="info" />
      <CellBody>
        {outToday.length === 0 ? (
          <p className="m-auto px-4 py-3 text-center text-xs text-balance text-muted-foreground">
            Everybody is in today.
          </p>
        ) : (
          outToday.slice(0, 4).map((span) => (
            <div
              key={`${span.userId}-${span.start}`}
              className="flex flex-1 items-center gap-2.5 border-b px-3.5 py-2 last:border-b-0"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent text-2xs font-semibold text-accent-foreground grade-chip">
                {initials(span.name)}
              </span>
              {/* P7-42. The same hover card as the calendar cell below,
                  from the same component — the two are built from one
                  `spans` array, and sharing the card is what stops them
                  wording one absence two ways. */}
              <LeaveTooltip span={span} day={today} className="block min-w-0">
                <span className="block truncate text-sm font-medium">{span.name}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {span.start === span.end
                    ? "Today only"
                    : `${formatDate(span.start)} – ${formatDate(span.end)}`}
                </span>
              </LeaveTooltip>
            </div>
          ))
        )}
        {outToday.length > 4 ? (
          <p className="border-t px-3.5 py-1.5 text-2xs text-muted-foreground">
            +{outToday.length - 4} more on the calendar below
          </p>
        ) : null}
      </CellBody>
    </Cell>
  );
}

/** Row 3 — the heaviest read on the page, and now the only thing waiting on it. */
async function LeaveCalendarSection({
  supabase,
  spans: spansPromise,
  month,
  today,
  gridFrom,
  gridTo,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  spans: ReturnType<typeof loadHomeSpans>;
  month: string;
  today: string;
  gridFrom: string;
  gridTo: string;
}) {
  const [spans, holidayRows, eventRows] = await Promise.all([
    spansPromise,

    /*
     * P7-35 — the holidays, maintained by an admin at /admin/holidays.
     *
     * A PLAIN SELECT, not a function, and the contrast with the leave query
     * above is the point: that one needs SECURITY DEFINER because a leave row
     * carries a reason it must withhold. A holiday has nothing private in it —
     * the policy on `vizserve_pms_holidays` already lets every active user read
     * it, which is exactly the audience of this calendar.
     *
     * The same month-either-side window as the leave spans, because the grid
     * shows trailing days of the previous month and leading days of the next,
     * and a holiday landing on one of those cells still has to paint it.
     */
    supabase
      .from("vizserve_pms_holidays")
      .select("holiday_date, name")
      .gte("holiday_date", gridFrom)
      .lte("holiday_date", gridTo),

    /*
     * P7-46 — events, maintained by an admin at /admin/events.
     *
     * OVERLAP, not containment, and the same window the leave spans use. An
     * offsite running 28 Aug – 3 Sep belongs on both months'' grids;
     * `start_date >= gridFrom` would drop it from September, where people are
     * still living through it.
     *
     * A plain select, like the holidays above and unlike the leave RPC: an
     * event has nothing private in it, so the policy "any active user reads" is
     * exactly the audience of this calendar.
     */
    supabase
      .from("vizserve_pms_events")
      .select("id, title, category, department_id, start_date, end_date, vizserve_pms_departments(name)")
      .lte("start_date", gridTo)
      .gte("end_date", gridFrom)
      .order("start_date"),
  ]);

  /*
   * ⚠️ P12-01 — LOGGED, for the same reason and with the same limits as the
   * leave reads in `loadHomeSpans`.
   *
   * A failed holiday read paints a public holiday as an ordinary working day on
   * the shared calendar; a failed event read hides the offsite. Neither can be
   * told from "there is nothing on in September" by looking, and neither left a
   * trace. The grid keeps rendering — a calendar missing its decorations is
   * still a calendar — but the fact now reaches the dev log.
   */
  const calendarFailure = holidayRows.error ?? eventRows.error ?? null;

  if (calendarFailure) {
    console.error(
      `[home] the calendar's holidays or events could not be read — ${calendarFailure.message}`,
    );
  }

  const holidays: Holiday[] = (holidayRows.data ?? []).map((row) => ({
    date: row.holiday_date,
    name: row.name,
  }));

  // The department name is embedded rather than fetched separately, because
  // `eventScopeLabel` needs it to print "VizMedia" instead of the useless word
  // "Department" on a cell.
  const calendarEvents: CalendarEvent[] = (
    (eventRows.data ?? []) as unknown as Array<{
      id: string;
      title: string;
      category: EventCategory;
      start_date: string;
      end_date: string;
      vizserve_pms_departments: { name: string } | null;
    }>
  ).map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    scope: eventScopeLabel(row.category, row.vizserve_pms_departments?.name),
    start: row.start_date,
    end: row.end_date,
  }));

  return (
    <LeaveCalendar
      month={month}
      today={today}
      spans={spans}
      holidays={holidays}
      events={calendarEvents}
      className="sm:col-span-6"
    />
  );
}

/**
 * P0-08 / P7-10 — the staff home.
 *
 * THIS IS `/`, AND IT IS NOT IN THE `(app)` SHELL. No sidebar, no breadcrumb —
 * it is a page in its own right, which is why it lives at `app/page.tsx` rather
 * than inside the route group. It carries its own greeting and its own sign-out
 * because there is no nav around it to carry them.
 *
 * It is not the dashboard. `/dashboard` is untouched and still its own route:
 * that page is the NUMBERS. This one is the day's shape — am I timed in, what
 * is waiting on me, who is out, what can I start in one click.
 *
 * `/` used to be a public marketing page arguing the product's case to someone
 * deciding whether to adopt it. Nobody who works at VizServe is that person, so
 * the root is now the first screen of the tool and `PUBLIC_EXACT` is empty —
 * the proxy sends an anonymous visitor to /login before this file runs. The old
 * landing page is kept verbatim under docs/archive/landing-page/.
 *
 * Its parts live in `_home/`: the underscore opts that folder out of routing,
 * so they sit beside the page they belong to without `/leave-calendar`
 * becoming a URL.
 *
 * A BENTO, and the two rules that make it one rather than a grid of floating
 * cards:
 *
 *   1. Every row's spans sum to six. A cell with nothing beside it leaves half
 *      a row of nothing, which is what the first pass shipped.
 *   2. Cells are paired by CONTENT VOLUME. Grid rows stretch, so a three-line
 *      cell next to a ten-line cell has to invent seven lines of white space —
 *      no amount of alignment fixes that, only pairing does.
 *
 * The layout collapses to one column below `sm` and to three at `sm`, so the
 * same cells reflow rather than a second layout existing for phones.
 *
 * What a MEMBER sees is a subset, not a different page: no "Waiting on you"
 * cell at all, because they approve nothing and a permanent zero teaches people
 * to stop reading a tile.
 *
 * P8 — AND IT STREAMS. Nineteen reads, one of them a three-month leave-calendar
 * RPC, and until now the page rendered nothing at all until the last of them
 * came back. They still all START before anything is awaited — nothing here runs
 * in sequence — but each tile is now its own `<Suspense>` boundary, so the punch
 * panel, the quick actions and the page chrome are on screen while the calendar
 * is still being counted.
 *
 * ONE BOUNDARY PER SLOW THING, NOT ONE PER CELL. "Out today" and the calendar are
 * built from the same `spans` array — deliberately, so the widget and the grid
 * can never disagree about who is away — so they share one promise, created once
 * here and awaited in both. Splitting the query to match the layout would have
 * bought a faster-feeling page by paying for the leave RPC twice.
 *
 * ⚠️ A SHARED PROMISE MUST BE A REAL PROMISE. `loadHomeSpans` and
 * `loadPunchState` are async functions, so awaiting what they return twice
 * resolves twice and queries once. A PostgREST builder is NOT a promise: its
 * `.then()` fires a fresh request every time it is called, which is why the
 * open-task count — read by the stat strip AND by a member's own cell — is
 * wrapped in `Promise.resolve` before it is shared.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  const isApprover = roleAtLeast(context.role, "team_leader");
  const firstName = context.fullName.trim().split(" ")[0] || "there";
  const today = todayInAppZone();

  // The month the calendar is showing. Validated rather than trusted — it comes
  // from the URL, and an unparseable value would otherwise reach Postgres as a
  // date literal and turn a mistyped link into a 500.
  const month = /^\d{4}-\d{2}-\d{2}$/.test(params.month ?? "") ? params.month! : today;
  const gridFrom = addMonths(month, -1) ?? month;
  const gridTo = addMonths(month, 1) ?? month;

  /* EVERY READ STARTS HERE, BEFORE THE FIRST AWAIT, and nothing below this point
     awaits at all — the page returns its markup and the boundaries fill in. That
     is the same parallelism the one `Promise.all` had; what it no longer does is
     make the punch panel wait for the calendar. */
  const punchState = loadPunchState(context.userId);

  // "Not finished" rather than a list of active statuses, so a status added
  // later is counted without anyone remembering to come back here.
  //
  // ⚠️ Wrapped, because TWO tiles read it — the stat strip and, for a member,
  // "Yours to move". A PostgREST builder fires a fresh request on every
  // `.then()`, so sharing the bare builder would run this count twice.
  const myTasksPromise = Promise.resolve(
    supabase
      .from("vizserve_pms_tasks")
      .select("id", { count: "exact", head: true })
      .eq("assignee_id", context.userId)
      .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)")
  );

  const spansPromise = loadHomeSpans({ supabase, context, gridFrom, gridTo });

  /*
    "New task" IS NOT IN THIS LIST ANY MORE, and that is the point of the
    change. It was `href: "/tasks"` — a route that redirects to `/tasks/lists`
    when it carries no `?list=`, so the one action here that says "new" landed
    the reader on a directory of folders with nothing created and no form open.
    It is a dialog now, rendered first in the grid below.
  */
  const QUICK = [
    /*
      `?type=`, not `?new=`. These four were written against a parameter nothing
      ever read, so every one of them landed on /approvals with the dialog shut —
      four quick actions that were four ordinary links to the same page. Slice F
      gave `/approvals` a real prefill contract (`narrowRequestPrefill`) and these
      now use it.
    */
    { label: "File leave", href: "/approvals?type=LEAVE" },
    { label: "Log overtime", href: "/approvals?type=OVERTIME" },
    // Still the MISSING-punch type, not the P7-39 correction pair. Somebody
    // reaching for this from the home page has no row in front of them, and the
    // ordinary reason to go looking is a gap. A wrong recorded time is found by
    // reading the DTR, which is where the correction links live.
    { label: "Time correction", href: "/approvals?type=NO_TIME_IN" },
    { label: "Reimbursement", href: "/approvals?type=REIMBURSEMENT" },
    { label: "My timesheet", href: "/timesheet" },
  ];
  return (
    /*
      ONE SCREEN, NO PAGE SCROLL from `lg` up.

      This is the page you land on after signing in, and everything on it is a
      glance: am I timed in, what is waiting, who is out. A glance that needs
      scrolling is not one — the calendar was pushing the whole bento off the
      bottom of a 1080p screen.

      THE PAGE SCROLLS NOW, and that reverses the paragraph above.

      It used to be bounded to `h-svh` with `overflow-hidden`, and every
      descendant that had to shrink carried `min-h-0`. The bento above the
      calendar is sized by its content, so all of that pressure landed on the
      calendar: it was handed "whatever is left" and squashed its six week rows
      into it. On a 1080p window that left roughly 245px for a grid that needs
      about 430px to draw a date and two names per cell, and `auto-rows-fr` is
      `minmax(0,1fr)` — rows shrink BELOW their content rather than overflowing —
      so the shortfall was spent clipping names through the middle of the glyphs.

      A calendar that has to hide who is out is not doing the job the calendar
      exists for, so the height clamp lost the argument. `min-h-svh` still makes
      a short page fill the window; nothing caps it any more.

      `svh`, not `vh`: on a phone `vh` measures the viewport with the browser
      chrome hidden. The sticky header keeps the way out reachable at any scroll
      depth, which is what its own comment below already anticipated.
    */
    <div className="flex min-h-svh flex-col grade-ambient bg-background bg-no-repeat">
      {/*
        ITS OWN HEADER, because there is no shell around this page to supply one.

        Same object as the app’s top bar: 56px, frosted `bg-panel` behind a
        blur with `shadow-chrome` and a hairline, so cells visibly pass UNDER it
        rather than being hidden by it. Sticky for the same reason — the way out
        of the page should not scroll away with the calendar.

        The lockup is the shared `BrandLockup` (§3), not a fourth hand-built copy.
        Sign-out lives here rather than beside the greeting: there is no user
        menu on this page, and a way out belongs in the chrome, not in the
        content.
      */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-panel px-5 shadow-chrome backdrop-blur-md backdrop-saturate-150">
        <BrandLockup subtitle="Team Portal" className="min-w-0" />

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Link href="/dashboard" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <LayoutDashboard />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
          <ThemeToggle />
          <form action={signOut}>
            <Button type="submit" variant="outline" size="sm">
              <LogOut />
              <span className="hidden sm:inline">Log out</span>
            </Button>
          </form>
        </div>
      </header>

      {/*
        CAPPED, unlike the pages inside the shell.

        `PageShell` is full width on purpose there, because a sidebar already
        eats 304px and the content has somewhere to sit. This page has no
        sidebar, so the same content on a 27-inch monitor would stretch a
        six-column bento to 2000px and leave the calendar cells wider than they
        are tall. `cn` is tailwind-merge, so the cap here replaces nothing and
        simply applies.
      */}
      <PageShell className="mx-auto w-full max-w-7xl gap-2.5">
        {/* A greeting, not a page label — there is no breadcrumb to repeat. */}
        {/* One line, not two. The greeting and the date now sit side by side —
            it is a salutation, and giving it a heading block of its own cost
            roughly a calendar row of the height the calendar needed. */}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h1 className="text-lg font-semibold tracking-[-0.022em]">Hello, {firstName}</h1>
          <p className="text-xs text-muted-foreground">
            {formatDate(today)}
            <Suspense
              fallback={
                <Streaming inline label="Loading your punch state…">
                  <InlineBar className="h-3 w-32 align-middle" />
                </Streaming>
              }
            >
              <TimedInLine punchState={punchState} />
            </Suspense>
          </p>
        </div>

        {/* THREE CONTENT-SIZED ROWS. The third used to be `minmax(0,1fr)`, which
            handed the calendar whatever the two rows above had not taken and let
            it shrink below its own content — the `minmax(0,…)` was doing that,
            not the `1fr`. Every row now takes the height it needs and the page
            scrolls, so the calendar states its own size instead of being told
            one. */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-6">
          {/* ------------------------------------------------------ row 1 · 3+3 */}
          <Cell span="sm:col-span-3" label="Daily time record">
            <CellHead title="Daily time record">
              <Suspense
                fallback={
                  <Streaming inline label="Loading your punch state…" className="ml-auto">
                    <InlineBar className="h-5.5 w-24 align-middle" />
                  </Streaming>
                }
              >
                <PunchChip punchState={punchState} />
              </Suspense>
            </CellHead>
            <CellBody className="gap-2 p-3">
              <Suspense
                fallback={
                  <Streaming label="Loading the punch panel…" className="space-y-2">
                    <Skeleton className="h-4 w-40" aria-hidden />
                    <Skeleton className="h-9 w-32" aria-hidden />
                  </Streaming>
                }
              >
                <HomePunch punchState={punchState} viewerId={context.userId} />
              </Suspense>
              <Link
                href="/dtr"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-auto w-fit")}
              >
                <Clock />
                My DTR
              </Link>
            </CellBody>
          </Cell>

          {isApprover ? (
            <Suspense
              fallback={
                <CellFallback span="sm:col-span-3" label="Waiting on you" title="Waiting on you" />
              }
            >
              <WaitingCell supabase={supabase} context={context} isApprover={isApprover} />
            </Suspense>
          ) : (
            /* A member gets their own queue in the same slot — same weight, same
             shape, and never an empty "Waiting on you" they can do nothing
             about. */
            <Suspense
              fallback={<CellFallback span="sm:col-span-3" label="Your work" title="Yours to move" />}
            >
              <YoursToMoveCell supabase={supabase} context={context} myTasks={myTasksPromise} />
            </Suspense>
          )}

          {/* ---------------------------------------------------- row 2 · 2+2+2 */}
          <Suspense
            fallback={
              /*
                ⚠️ NOT `CellFallback`, WHICH DRAWS A HEADING THIS TILE DOES NOT
                HAVE. `StatStrip` is a `Cell` wrapping a `CellBody flex-row` and
                nothing else — no `CellHead` — so the shared fallback added a
                ~30px heading row that vanished on resolve, which is the one
                movement a skeleton exists to prevent.

                Three side-by-side blocks, matching the three counts and their
                `flex-1 basis-0` split, rather than stacked rows.
              */
              <Cell span="sm:col-span-2" label="Your numbers">
                <CellBody className="flex-row">
                  <Streaming label="Loading your numbers…" className="flex flex-1 flex-row">
                    {Array.from({ length: 3 }, (_, index) => (
                      <div
                        key={index}
                        className="flex min-w-0 flex-1 basis-0 flex-col justify-center gap-1 px-3 py-2"
                      >
                        <Skeleton className="h-3 w-16" aria-hidden />
                        <Skeleton className="h-6 w-10" aria-hidden />
                      </div>
                    ))}
                  </Streaming>
                </CellBody>
              </Cell>
            }
          >
            <StatStripSection supabase={supabase} context={context} myTasks={myTasksPromise} />
          </Suspense>

          <Cell span="sm:col-span-2" label="Quick actions">
            <CellHead title="Quick actions" />
            <CellBody className="grid grid-cols-2 content-stretch gap-1.5 p-2.5">
              {/*
                FIRST IN THE GRID, and behind its own boundary so the five
                links beside it do not wait on its three queries. The fallback
                is the same button, inert — not a grey bar: this cell is a row
                of six controls and a skeleton among them reads as one of them
                having broken.
              */}
              <Suspense
                fallback={
                  <span
                    aria-hidden
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                      "h-auto min-h-9 justify-start opacity-60",
                    )}
                  >
                    <Plus />
                    New task
                  </span>
                }
              >
                <HomeNewTaskAction />
              </Suspense>

              {QUICK.map((action) => (
                <Link
                  key={action.label}
                  href={action.href}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "h-auto min-h-9 justify-start",
                  )}
                >
                  <Plus />
                  {action.label}
                </Link>
              ))}
            </CellBody>
          </Cell>

          <Suspense
            fallback={
              <CellFallback span="sm:col-span-2" label="Out of office today" title="Out today" />
            }
          >
            <OutTodayCell spans={spansPromise} today={today} />
          </Suspense>

          {/* ------------------------------------------------------- row 3 · 6 */}
          <Suspense fallback={<CalendarFallback />}>
            <LeaveCalendarSection
              supabase={supabase}
              spans={spansPromise}
              month={month}
              today={today}
              gridFrom={gridFrom}
              gridTo={gridTo}
            />
          </Suspense>
        </div>
      </PageShell>
    </div>
  );
}
