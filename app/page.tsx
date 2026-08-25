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

export const metadata: Metadata = { title: "Home" };

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

  const [
    punchState,
    waiting,
    unread,
    myTasks,
    myQa,
    myOpenTasks,
    approvedLeave,
    myPendingLeave,
    holidayRows,
    eventRows,
  ] = await Promise.all([
    loadPunchState(context.userId),

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
    listWaitingOnYou(supabase, context.userId, isApprover, 5),

    supabase
      .from("vizserve_pms_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),

    // "Not finished" rather than a list of active statuses, so a status added
    // later is counted without anyone remembering to come back here.
    supabase
      .from("vizserve_pms_tasks")
      .select("id", { count: "exact", head: true })
      .eq("assignee_id", context.userId)
      .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)"),

    supabase
      .from("vizserve_pms_tasks")
      .select("id", { count: "exact", head: true })
      .eq("qa_assignee_id", context.userId)
      .in("status", ["FOR_QA", "QA_IN_PROGRESS"]),

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

  // ---------------------------------------------------------------- waiting
  // Built by `listWaitingOnYou`. Nothing left to do here but count it — the
  // shaping that used to live in this block is shared with /dashboard.
  const waitingTotal = waiting.length;

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

  // Out today comes from the SAME spans the calendar paints, so the widget and
  // the grid can never disagree about who is away.
  const outToday = spans.filter(
    (span) => !span.pending && span.start <= today && span.end >= today,
  );

  const timeIn = punchState.today?.time_in ?? null;

  const QUICK = [
    { label: "New task", href: "/tasks" },
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
        <BrandLockup subtitle="Project Management System" className="min-w-0" />

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
            {timeIn ? ` · timed in at ${formatAppTime(timeIn)}` : " · not timed in yet"}
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
              <Chip
                tone={timeIn ? "success" : "neutral"}
                label={timeIn ? "Timed in" : "Not timed in"}
                className="ml-auto"
              />
            </CellHead>
            <CellBody className="gap-2 p-3">
              <PunchPanel initial={punchState} compact />
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
                {waiting.length === 0 ? (
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
          ) : (
            /* A member gets their own queue in the same slot — same weight, same
             shape, and never an empty "Waiting on you" they can do nothing
             about. */
            <Cell span="sm:col-span-3" label="Your work">
              <CellHead
                title="Yours to move"
                count={myTasks.count ?? 0}
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
                {(myOpenTasks.data ?? []).length === 0 ? (
                  <p className="m-auto px-4 py-3 text-center text-xs text-balance text-muted-foreground">
                    Nothing is assigned to you right now. Work lands here when a Team Leader
                    approves a request or hands you something directly.
                  </p>
                ) : (
                  (myOpenTasks.data ?? []).map((task) => {
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
          )}

          {/* ---------------------------------------------------- row 2 · 2+2+2 */}
          <StatStrip
            span="sm:col-span-2"
            stats={[
              { label: "My tasks", value: myTasks.count ?? 0, href: "/tasks?view=mine" },
              { label: "On my QA", value: myQa.count ?? 0, href: "/tasks?view=qa" },
              { label: "Unread", value: unread.count ?? 0, href: "/inbox" },
            ]}
          />

          <Cell span="sm:col-span-2" label="Quick actions">
            <CellHead title="Quick actions" />
            <CellBody className="grid grid-cols-2 content-stretch gap-1.5 p-2.5">
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

          {/* ------------------------------------------------------- row 3 · 6 */}
          <LeaveCalendar
            month={month}
            today={today}
            spans={spans}
            holidays={holidays}
            events={calendarEvents}
            className="sm:col-span-6"
          />
        </div>
      </PageShell>
    </div>
  );
}
