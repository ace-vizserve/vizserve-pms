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
import { PageShell } from "@/components/page-shell";
import { StatTile } from "@/components/stat-tile";
import { PunchPanel } from "../dtr/punch-panel";
import { createClient } from "@/utils/supabase/server";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { NeedsYou, type NeedsYouRow } from "./needs-you";
import { TimesheetStrip } from "./timesheet-strip";

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
 */
export default async function DashboardPage() {
  const context = await requireAuthContext();
  const supabase = await createClient();
  const isApprover = roleAtLeast(context.role, "team_leader");
  const firstName = context.fullName.trim().split(" ")[0] || "there";

  const today = todayInAppZone();
  const monday = startOfWeek(today) ?? today;
  const weekEnd = weekDates(monday).at(-1)!;
  const lastMonday = addDays(monday, -7) ?? monday;
  const lastSunday = addDays(monday, -1) ?? monday;

  const [
    punchState,
    waiting,
    unread,
    myTasks,
    myQa,
    myWork,
    qaQueue,
    thisWeekEntries,
    thisWeekRow,
    lastWeek,
    teamWeeks,
    waitingRows,
  ] = await Promise.all([
    loadPunchState(context.userId),

    // Three queues, not one — see `countWaitingOnYou`. This tile counted client
    // requests alone until 18 Aug 2026, so a lead with a full internal queue
    // and no client work was told they had nothing to do.
    countWaitingOnYou(supabase, context.userId, isApprover),

    supabase
      .from("vizserve_pms_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),

    // P3-14 — the member's own live work. "Not finished" rather than a list of
    // active statuses, so a status added later is counted without anyone
    // remembering to come back here.
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
     * I4 — the lead's band. THE SAME NUMBERS `/timesheet/team` puts on screen,
     * read the same way, and the band links there rather than growing its own
     * version of the grid. Two implementations of "who has submitted this week"
     * is the same failure as two implementations of the day threshold.
     *
     * No department filter: the weeks policy already scopes to the departments
     * this person leads.
     */
    isApprover
      ? supabase
          .from("vizserve_pms_timesheet_weeks")
          .select("user_id, status")
          .eq("week_start", monday)
      : Promise.resolve({ data: null }),

    // I2's approval rows. The SAME function `/` uses, so the two pages cannot
    // disagree about what is in somebody's queue — which they already had once,
    // when each counted it inline.
    listWaitingOnYou(supabase, context.userId, isApprover),
  ]);

  // ------------------------------------------------------------------ I3
  const weekMinutes = (thisWeekEntries.data ?? []).reduce((sum, row) => sum + row.minutes, 0);
  const weekStatus = (thisWeekRow.data?.status ?? null) as TimesheetWeekStatus | null;

  const [lastWeekEntries, lastWeekRow] = lastWeek;
  const lastWeekUnsubmitted =
    (lastWeekEntries.count ?? 0) > 0 && !lastWeekRow.data ? lastMonday : null;

  // ------------------------------------------------------------------ I2
  type TaskLike = {
    id: string;
    title: string;
    status: TaskStatus;
    due_date: string | null;
    start_date: string | null;
    request_id: string | null;
    is_personal: boolean;
  };

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

  // ------------------------------------------------------------------ I4
  const teamRows = teamWeeks.data ?? [];
  const teamSubmitted = teamRows.filter(
    (row) => row.status === "SUBMITTED" || row.status === "APPROVED",
  ).length;

  const showQa = (myQa.count ?? 0) > 0;

  return (
    <PageShell>
      {/* The one heading in the app that is not the breadcrumb. It is a greeting,
          not a page label — the crumb already says "Dashboard". */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Hello, {firstName}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {shown.length > 0
            ? "The things waiting on you, most urgent first."
            : "Nothing is waiting on you right now."}
        </p>
      </div>

      {/* I3 first, and ABOVE the tiles, because a returned week is the only
          state where a named person has stopped and is waiting on this user. */}
      <TimesheetStrip
        weekStart={monday}
        status={weekStatus}
        minutes={weekMinutes}
        decisionReason={thisWeekRow.data?.decision_reason ?? null}
        lastWeekUnsubmitted={lastWeekUnsubmitted}
      />

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

      <div id="needs-you" className="scroll-mt-4">
        <NeedsYou
          rows={shown}
          overflow={overflow}
          overflowHref="/tasks?view=mine"
          empty={emptyNeedsYouMessage(myTasks.count ?? 0)}
        />
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
              {formatWeekRange(monday)} — {teamSubmitted}{" "}
              {teamSubmitted === 1 ? "week" : "weeks"} handed in.
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
          <PunchPanel initial={punchState} compact />
          <Link
            href="/dtr"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}
          >
            Open my DTR <ArrowRight className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
    </PageShell>
  );
}
