import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bell, ClipboardCheck, ListChecks, ShieldCheck, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import { countWaitingOnYou, listWaitingOnYou } from "@/lib/approvals-queue-server";
import {
  NEEDS_YOU_LIMIT,
  bucketTask,
  emptyNeedsYouMessage,
  needsYouRank,
  type NeedsYouKind,
} from "@/lib/dashboard";
import { loadPunchState } from "@/lib/dtr-server";
import {
  addDays,
  formatDate,
  formatWeekRange,
  relativeDays,
  startOfWeek,
  todayInAppZone,
  weekDates,
} from "@/lib/dates";
import { TASK_CATEGORY_LABELS, taskCategory, type TaskStatus } from "@/lib/schemas/tasks";
import type { TimesheetWeekStatus } from "@/lib/schemas/timesheet";
import { loadScheduledWeek } from "@/lib/timesheet-schedule-server";
import { PageShell } from "@/components/page-shell";
import { StatTile } from "@/components/stat-tile";
import { PunchPanel } from "../dtr/punch-panel";
import { createClient } from "@/utils/supabase/server";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { NeedsYou, type NeedsYouRow } from "./needs-you";
import { TimesheetStrip } from "./timesheet-strip";

import { StatRowSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
export const metadata: Metadata = { title: "Dashboard" };

/**
 * P0-08 / SLICE I — the dashboard.
 *
 * IT WAS A LAUNCHER: a greeting, four counts and the punch card. Every tile was a
 * number and a link somewhere else, so after the count was read the page had
 * nothing left to offer, and nothing on it had a DATE on it — "My tasks: 7" is
 * the same 7 whether one is three weeks late or all seven are due next month,
 * which is the entire question a person opens this page to ask.
 *
 * The rule the rebuild follows: **a dashboard answers "what needs me, now", and
 * lets you act on it there.** Counts are the summary layer, not the content
 * layer — so lists over numbers, and every row links to the THING rather than to
 * a filtered list containing the thing.
 *
 * Four sections, in the order they claim attention:
 *
 *   I3  the timesheet strip — RETURNED outranks everything else on the page
 *   I1  the tiles, which are the summary of what follows
 *   I2  "Needs you", the mixed queue as rows, ordered by urgency
 *   I4  the lead's band, which links into /timesheet/team rather than recomputing
 *
 * The punch card stays. Amier asked for it explicitly (16:30), and it is the only
 * thing on the page that was already an action rather than a link — it is the
 * model the rest of this follows.
 *
 * NO CHARTS. `/reports` is the charting surface and the only place `dataviz` is
 * loaded; a throughput sparkline answers a question nobody has at 9am, and one
 * here would make this a second reporting page to keep in step with the first.
 *
 * NO SECURITY DEFINER AGGREGATE. Everything below aggregates in TypeScript over
 * policy-scoped rows. If it gets slow the fix is fewer sections, not a definer
 * function re-implementing the department scoping the policies already do.
 *
 * COST, STATED RATHER THAN DISCOVERED: this page ran five parallel queries and
 * now runs eleven. All are `head: true` counts or `limit`-ed reads on indexed
 * columns, and they stay inside ONE `Promise.all` — a dashboard that awaits in
 * sequence is the classic way this becomes the slowest page in the app.
 * `loadPunchState` stays first so nothing else can push it behind a slower read.
 *
 * P8 — AND NOW IT STREAMS. The eleven reads above are still eleven reads, still
 * started before anything is awaited and still running in parallel; what changed
 * is that the PAGE no longer waits for the slowest of them before it renders a
 * single element. The greeting needs `context.fullName` and nothing else, so it
 * paints first, and each of the four sections is a `<Suspense>` boundary fed by
 * its own group. `Promise.all` moved down into those groups rather than being
 * dropped — awaiting in sequence is still the way this becomes the slowest page
 * in the app.
 *
 * ⚠️ A PROMISE SHARED BETWEEN TWO BOUNDARIES MUST BE A REAL PROMISE. Two
 * sections read this week's timesheet row, and two read the open-task count, so
 * those are created ONCE up here and awaited in both places. `loadWeek` is an
 * async function and returns a real promise; `myTasksPromise` is a PostgREST
 * builder and is NOT one — its `.then()` fires a fresh request every time it is
 * called, so it is wrapped in `Promise.resolve`, which assimilates the thenable
 * exactly once. Sharing the bare builder would have run the query twice and made
 * the page cost more in order to feel faster.
 */

/** The shape both task queries above come back as. */
type TaskLike = {
  id: string;
  title: string;
  status: TaskStatus;
  due_date: string | null;
  start_date: string | null;
  request_id: string | null;
  is_personal: boolean;
};

/**
 * I3's four reads — this week's entries and row, last week's pair, and the
 * schedule behind the target. Two boundaries want them: the strip renders them,
 * and "Needs you" leads with a RETURNED week, so this is one promise awaited
 * twice rather than two copies of the same queries.
 */
async function loadWeek({
  supabase,
  context,
  monday,
  weekEnd,
  lastMonday,
  lastSunday,
  weekDays,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof requireAuthContext>>;
  monday: string;
  weekEnd: string;
  lastMonday: string;
  lastSunday: string;
  weekDays: string[];
}) {
  const [thisWeekEntries, thisWeekRow, lastWeek, schedule] = await Promise.all([
    // I3. Minutes, summed in TypeScript — the entries policy already scopes this
    // to the caller, so there is no `.eq("user_id", …)` to write.
    supabase
      .from("vizserve_pms_timesheet_entries")
      .select("minutes")
      .gte("work_date", monday)
      .lte("work_date", weekEnd),

    supabase
      .from("vizserve_pms_timesheet_weeks")
      .select("status, decision_reason")
      .eq("user_id", context.userId)
      .eq("week_start", monday)
      .maybeSingle(),

    /*
     * I3's nag: last week's entries and last week's row, together.
     *
     * BOTH are needed to say anything. Entries with no row means "never handed
     * in"; no entries and no row means there was nothing to hand in, and slice C
     * refuses to submit an empty week anyway. Saying "last week was never handed
     * in" to somebody who was on leave all week would be the same libel the team
     * grid was fixed for.
     */
    Promise.all([
      supabase
        .from("vizserve_pms_timesheet_entries")
        .select("id", { count: "exact", head: true })
        .gte("work_date", lastMonday)
        .lte("work_date", lastSunday),
      supabase
        .from("vizserve_pms_timesheet_weeks")
        .select("status")
        .eq("user_id", context.userId)
        .eq("week_start", lastMonday)
        .maybeSingle(),
    ]),

    /*
     * P8-05 — what this week was actually supposed to come to, for THIS person.
     *
     * ⚠️ THE STRIP USED TO INVENT THIS. It rendered `STANDARD_DAY_MINUTES * 5`
     * and told everybody "22h of 40h" — a weekly constant `lib/dates.ts:417-419`
     * deliberately refuses to define, because it would mean deciding whether
     * Saturday counts. So the dashboard contradicted the module it imported the
     * figure from, and it was wrong for every part-timer, every week with a
     * public holiday in it and everybody on approved leave.
     *
     * THE SAME FUNCTION `/timesheet` CALLS, not a copy of its arithmetic. Two
     * screens quoting different targets for one week is worse than one screen
     * quoting none, because the person then has to guess which is real.
     */
    loadScheduledWeek(context.userId, weekDays),
  ]);

  // ------------------------------------------------------------------ I3
  const weekMinutes = (thisWeekEntries.data ?? []).reduce((sum, row) => sum + row.minutes, 0);
  const weekStatus = (thisWeekRow.data?.status ?? null) as TimesheetWeekStatus | null;

  const [lastWeekEntries, lastWeekRow] = lastWeek;
  const lastWeekUnsubmitted =
    (lastWeekEntries.count ?? 0) > 0 && !lastWeekRow.data ? lastMonday : null;

  return { weekMinutes, weekStatus, thisWeekRow, lastWeekUnsubmitted, schedule };
}

/**
 * I2's rows. It reads `week` as well as its own three queries, because a
 * returned week is the row that leads the list.
 */
async function loadNeedsYou({
  supabase,
  context,
  isApprover,
  today,
  monday,
  week,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof requireAuthContext>>;
  isApprover: boolean;
  today: string;
  monday: string;
  week: ReturnType<typeof loadWeek>;
}) {
  const [myWork, qaQueue, waitingRows, { weekStatus }] = await Promise.all([
    /*
     * I2 — the member's own work as ROWS, with both dates.
     *
     * `start_date` shipped in P7-06 and the board was its only reader in the
     * whole app; this is where the column earns its keep. `bucketTask` needs
     * both, because "I am meant to begin this today" is as much a claim on
     * somebody's morning as "this is due today".
     *
     * Capped generously rather than at NEEDS_YOU_LIMIT: the rows are bucketed
     * and sorted AFTER this, so a limit of eight here would let eight
     * far-future tasks crowd out an overdue one.
     */
    supabase
      .from("vizserve_pms_tasks")
      .select("id, title, status, due_date, start_date, request_id, is_personal")
      .eq("assignee_id", context.userId)
      .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(40),

    supabase
      .from("vizserve_pms_tasks")
      .select("id, title, status, due_date, start_date, request_id, is_personal")
      .eq("qa_assignee_id", context.userId)
      .in("status", ["FOR_QA", "QA_IN_PROGRESS"])
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(10),

    // I2's approval rows. The SAME function `/` uses, so the two pages cannot
    // disagree about what is in somebody's queue — which they already had once,
    // when each counted it inline.
    listWaitingOnYou(supabase, context, isApprover),

    week,
  ]);

  // ------------------------------------------------------------------ I2
  const rows: (NeedsYouRow & { kindKey: NeedsYouKind })[] = [];

  /*
   * A returned week leads the list AND has its own strip above.
   *
   * Deliberate duplication: the strip is where the reason is readable, and this
   * row is what stops the queue claiming "nothing is due" while somebody is
   * blocked. The row is the pointer, the strip is the content.
   */
  if (weekStatus === "RETURNED") {
    rows.push({
      kindKey: "returned",
      key: "week-returned",
      kind: "Timesheet",
      tone: "warning",
      title: `${formatWeekRange(monday)} was returned to you`,
      meta: "fix and resubmit",
      href: "/timesheet",
    });
  }

  for (const task of (myWork.data ?? []) as TaskLike[]) {
    const bucket = bucketTask(task, today);
    // Only what claims today. `week`, `later` and `none` are real answers and
    // they are answered by /tasks, not by a page about what needs doing now.
    if (bucket !== "overdue" && bucket !== "today") continue;

    const startingRatherThanDue = !task.due_date;

    rows.push({
      kindKey: bucket === "overdue" ? "overdue" : startingRatherThanDue ? "starting" : "today",
      key: `task-${task.id}`,
      // The same three-category label the list and the detail use. That is the
      // point of `taskCategory` existing once.
      kind: TASK_CATEGORY_LABELS[taskCategory(task)],
      tone: bucket === "overdue" ? "danger" : "info",
      title: task.title,
      meta: startingRatherThanDue
        ? `starts ${formatDate(task.start_date)}`
        : formatDate(task.due_date),
      // The WORD, not a red tint. House rule, and here it is also what makes the
      // row skimmable.
      flag: bucket === "overdue" ? "overdue" : undefined,
      href: `/tasks/${task.id}`,
    });
  }

  for (const task of (qaQueue.data ?? []) as TaskLike[]) {
    rows.push({
      kindKey: "qa",
      key: `qa-${task.id}`,
      kind: "Your QA",
      tone: "brand",
      title: task.title,
      meta: task.due_date ? formatDate(task.due_date) : "no due date",
      flag: bucketTask(task, today) === "overdue" ? "overdue" : undefined,
      href: `/tasks/${task.id}`,
    });
  }

  for (const item of waitingRows) {
    rows.push({
      kindKey: "approval",
      key: `approval-${item.id}`,
      kind: item.kind,
      tone: item.tone,
      // The person, not the queue: on this page the chip already says which
      // queue it is, and who is waiting is the part that decides whether it can
      // wait another hour.
      title: `${item.title} — ${item.who}`,
      meta: relativeDays(item.since),
      href: item.href,
    });
  }

  // By urgency, not by source. Grouping by table would put a returned week below
  // a task due next Friday purely because of how the queries are ordered above.
  rows.sort((a, b) => needsYouRank(a.kindKey) - needsYouRank(b.kindKey));

  const shown = rows.slice(0, NEEDS_YOU_LIMIT);
  const overflow = Math.max(0, rows.length - NEEDS_YOU_LIMIT);

  return { shown, overflow };
}

/**
 * ⚠️ A SUSPENSE FALLBACK IS ANNOUNCED BY NOBODY.
 *
 * `components/skeletons.tsx` hides its skeletons from assistive technology and
 * gives a reason specific to `loading.tsx`: the ROUTER announces that
 * navigation, so a second announcement would interrupt it. Nothing announces a
 * boundary streaming inside a page that has already rendered — so each fallback
 * here is a `role="status"` region carrying `aria-busy` and a label naming the
 * section, and only the grey bars inside it stay `aria-hidden`. Four of them are
 * on screen at once, which is why each label says which section it is.
 */
function Streaming({
  label,
  className,
  inline = false,
  children,
}: {
  label: string;
  className?: string;
  /** A `<span>` rather than a `<div>` — a block element inside a `<p>` is invalid
      HTML, and the two inline fallbacks here sit inside running text. */
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
  return <span aria-hidden className={cn("inline-block animate-pulse rounded-sm bg-track", className)} />;
}

/** I3 — the strip, once its four reads land. */
async function TimesheetStripSection({ week, monday }: { week: ReturnType<typeof loadWeek>; monday: string }) {
  const { weekStatus, weekMinutes, thisWeekRow, lastWeekUnsubmitted, schedule } = await week;

  return (
    <TimesheetStrip
      weekStart={monday}
      status={weekStatus}
      minutes={weekMinutes}
      /* Null when this person is exempt from a schedule, or when one of the
         four reads behind it failed. Either way the strip states the logged
         total alone — it does NOT fall back to a number, which is the whole
         reason the 40 came out. */
      scheduledWeekMinutes={schedule.scheduledWeek?.minimumMinutes ?? null}
      decisionReason={thisWeekRow.data?.decision_reason ?? null}
      lastWeekUnsubmitted={lastWeekUnsubmitted}
    />
  );
}

/** I1 — the tiles, which are the summary of what follows. */
async function StatTiles({
  supabase,
  context,
  isApprover,
  myTasks: myTasksPromise,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof requireAuthContext>>;
  isApprover: boolean;
  myTasks: Promise<{ count: number | null }>;
}) {
  const [waiting, unread, myQa, myTasks] = await Promise.all([
    // Three queues, not one — see `countWaitingOnYou`. This tile counted client
    // requests alone until 18 Aug 2026, so a lead with a full internal queue
    // and no client work was told they had nothing to do.
    countWaitingOnYou(supabase, context, isApprover),

    supabase
      .from("vizserve_pms_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),

    supabase
      .from("vizserve_pms_tasks")
      .select("id", { count: "exact", head: true })
      .eq("qa_assignee_id", context.userId)
      .in("status", ["FOR_QA", "QA_IN_PROGRESS"]),

    myTasksPromise,
  ]);

  const showQa = (myQa.count ?? 0) > 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {/* One tile summing three queues, not three tiles. The QA tile below
          already argues why: a permanent zero teaches people to stop looking,
          and two of these three are empty most days. The breakdown is in the
          hint; the link goes to the "Needs you" list on this page, which is the
          only place all three appear together — sending it to one of the three
          would make a tile that sums three queues pick a favourite. */}
      {isApprover ? (
        <StatTile
          label="Waiting on you"
          value={waiting.total}
          hint={waiting.breakdown || "Nothing awaiting your decision"}
          icon={<ClipboardCheck />}
          tone="warning"
          href="#needs-you"
          linkLabel="See the queue"
        />
      ) : null}

      <StatTile
        label="My tasks"
        value={myTasks.count ?? 0}
        hint="Assigned to you, still open"
        icon={<ListChecks />}
        tone="info"
        href="/tasks?view=mine"
        linkLabel="Open my tasks"
      />

      {/* Only shown when there is actually something to review. A permanent
          zero teaches people to stop looking at the tile. */}
      {showQa ? (
        <StatTile
          label="Waiting on my QA"
          value={myQa.count ?? 0}
          hint="Work that needs your review"
          icon={<ShieldCheck />}
          tone="info"
          href="/tasks?view=qa"
          linkLabel="Open QA queue"
        />
      ) : null}

      <StatTile
        label="Inbox"
        value={unread.count ?? 0}
        hint="Unread notifications about your work"
        icon={<Bell />}
        href="/inbox"
        linkLabel="Open inbox"
      />
    </div>
  );
}

/** I2 — the mixed queue as rows. */
async function NeedsYouSection({
  needsYou,
  myTasks: myTasksPromise,
}: {
  needsYou: ReturnType<typeof loadNeedsYou>;
  myTasks: Promise<{ count: number | null }>;
}) {
  const [{ shown, overflow }, myTasks] = await Promise.all([needsYou, myTasksPromise]);

  return (
    <NeedsYou
      rows={shown}
      overflow={overflow}
      overflowHref="/tasks?view=mine"
      empty={emptyNeedsYouMessage(myTasks.count ?? 0)}
    />
  );
}

/** The one figure in I4's band that is not already on screen. */
async function TeamSubmitted({
  supabase,
  isApprover,
  monday,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  isApprover: boolean;
  monday: string;
}) {
  const teamWeeks = await (
  isApprover
    ? supabase
        .from("vizserve_pms_timesheet_weeks")
        .select("user_id, status")
        .eq("week_start", monday)
    : Promise.resolve({ data: null })
  );

  // ------------------------------------------------------------------ I4
  const teamRows = teamWeeks.data ?? [];
  const teamSubmitted = teamRows.filter(
    (row) => row.status === "SUBMITTED" || row.status === "APPROVED",
  ).length;

  return (
    <>
      {teamSubmitted} {teamSubmitted === 1 ? "week" : "weeks"} handed in.
    </>
  );
}

/** The punch card's one waiting part. The card and its link are already drawn. */
async function DashboardPunch({ punchState }: { punchState: ReturnType<typeof loadPunchState> }) {
  return <PunchPanel initial={await punchState} compact />;
}

/** The greeting's second line, which cannot be written until the queue is counted. */
async function GreetingSubtitle({ needsYou }: { needsYou: ReturnType<typeof loadNeedsYou> }) {
  const { shown } = await needsYou;

  return (
    <>
      {shown.length > 0
        ? "The things waiting on you, most urgent first."
        : "Nothing is waiting on you right now."}
    </>
  );
}

export default async function DashboardPage() {
  const context = await requireAuthContext();
  const supabase = await createClient();
  const isApprover = roleAtLeast(context.role, "team_leader");
  const firstName = context.fullName.trim().split(" ")[0] || "there";

  const today = todayInAppZone();
  const monday = startOfWeek(today) ?? today;
  // The seven dates, kept rather than discarded after the last one: `loadScheduledWeek`
  // needs the whole week, and `days.slice(0, 5)` inside it is the weekend test.
  const weekDays = weekDates(monday);
  const weekEnd = weekDays.at(-1)!;
  const lastMonday = addDays(monday, -7) ?? monday;
  const lastSunday = addDays(monday, -1) ?? monday;

  /* EVERY READ STARTED HERE, BEFORE THE FIRST AWAIT. Below this point the page
     renders; the sections resolve as their own groups come back. */
  const punchState = loadPunchState(context.userId);

  // P3-14 — the member's own live work. "Not finished" rather than a list of
  // active statuses, so a status added later is counted without anyone
  // remembering to come back here.
  //
  // ⚠️ Wrapped, because TWO boundaries read it — the tiles and the empty
  // message under "Needs you". A PostgREST builder fires a fresh request on
  // every `.then()`, so sharing the bare builder would run this count twice.
  const myTasksPromise = Promise.resolve(
    supabase
      .from("vizserve_pms_tasks")
      .select("id", { count: "exact", head: true })
      .eq("assignee_id", context.userId)
      .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)")
  );

  const week = loadWeek({
    supabase,
    context,
    monday,
    weekEnd,
    lastMonday,
    lastSunday,
    weekDays,
  });

  const needsYou = loadNeedsYou({ supabase, context, isApprover, today, monday, week });

  return (
    <PageShell>
      {/* The one heading in the app that is not the breadcrumb. It is a greeting,
          not a page label — the crumb already says "Dashboard". */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Hello, {firstName}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          <Suspense
            fallback={
              <Streaming inline label="Loading what is waiting on you…">
                <InlineBar className="h-3 w-64 align-middle" />
              </Streaming>
            }
          >
            <GreetingSubtitle needsYou={needsYou} />
          </Suspense>
        </p>
      </div>

      {/* I3 first, and ABOVE the tiles, because a returned week is the only
          state where a named person has stopped and is waiting on this user. */}
      <Suspense
        fallback={
          <Streaming
            label="Loading this week's timesheet…"
            className="rounded-lg border p-3 grade-surface shadow-raised"
          >
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-3 w-40" />
            </div>
          </Streaming>
        }
      >
        <TimesheetStripSection week={week} monday={monday} />
      </Suspense>

      <Suspense
        fallback={
          <Streaming label="Loading your counts…">
            <StatRowSkeleton tiles={isApprover ? 3 : 2} />
          </Streaming>
        }
      >
        <StatTiles supabase={supabase} context={context} isApprover={isApprover} myTasks={myTasksPromise} />
      </Suspense>

      {/*
        ⚠️ EVERYTHING BELOW THIS IS INSIDE THE BOUNDARY, AND THAT IS THE WHOLE
        POINT. "Needs you" is the one section on this page whose height cannot be
        guessed — `NEEDS_YOU_LIMIT` is 8 and the fallback draws 3, so when it
        lands it can grow by five rows and shove the two cards under it down the
        page. Sibling boundaries resolve independently and push each other
        around; a nested one waits for the section above to be in place, so the
        page settles from the top down.

        The work still runs in parallel — `needsYou` and `punchState` were both
        started well above this. Nesting changes when things are REVEALED, not
        when they are fetched.

        Nothing else on this page needs it: the greeting, the timesheet strip and
        the stat tiles all have fallbacks the same size as their content, which is
        what `components/skeletons.tsx` exists to enforce. Reserved space and
        nesting solve the same problem, and reserved space is free.
      */}
      <Suspense
        fallback={
          <Streaming
            label="Loading the things that need you…"
            className="space-y-3 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg"
          >
            <Skeleton className="h-4 w-28" aria-hidden />
            <div className="space-y-2.5" aria-hidden>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </Streaming>
        }
      >
        <div id="needs-you" className="scroll-mt-4">
          <NeedsYouSection needsYou={needsYou} myTasks={myTasksPromise} />
        </div>

      {/* I4. Behind the role, and the numbers are read from the same table
          `/timesheet/team` reads — the band links there rather than growing its
          own grid. */}
      {isApprover ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="size-4 text-muted-foreground" aria-hidden />
              Your department this week
            </CardTitle>
            <CardDescription className="text-xs">
              {formatWeekRange(monday)} —{" "}
              <Suspense
                fallback={
                  <Streaming inline label="Counting the weeks handed in…" className="inline-block">
                    <InlineBar className="h-3 w-32 align-middle" />
                  </Streaming>
                }
              >
                <TeamSubmitted supabase={supabase} isApprover={isApprover} monday={monday} />
              </Suspense>
              {/* NOT "n of m", because m is unknowable here without a second
                  query for department headcount — and a denominator that counts
                  people on leave all week would report a shortfall that is not
                  one. The team grid is where the gaps are visible, with the leave
                  overlay that makes them readable. */}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/timesheet/team"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              Open the team week
              <ArrowRight className="size-3.5" />
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Time in / out</CardTitle>
          <CardDescription className="text-xs">
            Punch without leaving the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Suspense
            fallback={
              <Streaming label="Loading your punch state…">
                <Skeleton className="h-9 w-32" aria-hidden />
              </Streaming>
            }
          >
            <DashboardPunch punchState={punchState} />
          </Suspense>
          <Link
            href="/dtr"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}
          >
            Open my DTR <ArrowRight className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
      </Suspense>
    </PageShell>
  );
}
