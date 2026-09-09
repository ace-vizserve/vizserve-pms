import type { VizservePmsRequestStatus, VizservePmsTaskStatus } from "@/lib/database.types";
import { addDays, isOverdue } from "@/lib/dates";
import { parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import {
  clientDecisionCountSchema,
  feedbackRowSchema,
  negotiationRowSchema,
  reportHoursSchema,
  reportRequestSchema,
  reportTaskSchema,
  turnaroundRowSchema,
} from "@/lib/schemas/reports";
import { INITIAL_TASK_STATUS, TASK_STATUSES, isTerminal } from "@/lib/schemas/tasks";

import type { TaskReadClient } from "./task";

/**
 * P12-21 — THE WHOLE OF `/reports`, BEHIND ONE KEY.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT THIS REPLACES: a 465-line RSC and `lib/reports-server.ts`. Between
 * them they held nine reads and the aggregation over all of them, and the page
 * re-ran every one of them on each navigation, each back-button return and each
 * nudge of the date picker — which pushes the whole route through the server
 * because `RangePicker` calls `router.push`.
 *
 * ⚠️ SEVEN READS, ONE KEY, AND THAT IS A DECISION RATHER THAN LAZINESS. Every
 * other domain in this migration split into parts that move on different
 * schedules — `qk.taskPart(id, "comments")` exists so posting a comment does not
 * refetch the task. Nothing on this page moves on a different schedule from
 * anything else on it: they are seven readings of ONE PERIOD, taken together,
 * and the period is the key. Splitting them would buy the ability to refetch a
 * quarter of a report, which nothing wants, at the cost of four ways for a
 * report to be partly from one period and partly from another.
 *
 * ⚠️ THE EIGHTH READ LEFT ENTIRELY. The departments were fetched here for their
 * NAMES, which is reference data — so `reports-view.tsx` labels the rows from
 * `qk.ref("departments")`, the entry every other screen in the app already
 * holds, and this key stops re-reading six rows that change once a quarter every
 * time somebody nudges the date picker.
 *
 * ⚠️ AND A FAILURE TAKES THE WHOLE PAGE, DELIBERATELY. This is the one screen in
 * the product where people make decisions from numbers, and a page showing
 * three cards and a hole is a page inviting somebody to add up what is left. The
 * period is the unit of trust, so the period is the unit of failure.
 *
 * ⚠️ EVERY READ GOES THROUGH `read()`, WHICH THROWS, AND THAT IS THE POINT OF
 * THE WHOLE CONVERSION. What was here before:
 *
 *   * `page.tsx` did `(tasksResult.data ?? []) as TaskRow[]` and friends, then
 *     surfaced `tasksResult.error ?? requestsResult.error ?? hoursResult.error`
 *     — so three of the nine reads could report a fault and SIX COULD NOT.
 *     `?from=banana` is not the failure mode this guards against; a dropped
 *     socket on the fourth of nine parallel reads is, and it happened.
 *   * All four loaders in `lib/reports-server.ts` destructured `{ data }` and
 *     threw the error away completely. A dead connection rendered as
 *     "No client has given feedback in this period", "turnaround: 0 completed",
 *     "engagement: —". Every one of those is a sentence somebody repeats in a
 *     meeting.
 *   * The departments read had no error path at all, so a failure there renamed
 *     every department to "Another department" — which reads as a permissions
 *     problem and is not one.
 *
 * ⚠️ AGGREGATED IN TYPESCRIPT OVER RLS-SCOPED ROWS, exactly as before, and the
 * note the RSC carried is kept: sixteen users and one tenant do not justify a
 * `SECURITY DEFINER` aggregate, and a definer would have to re-implement the
 * department scoping the policies already do. If this ever gets slow the upgrade
 * is a definer scoped through `vizserve_pms_approvable_department_ids()`.
 *
 * ⚠️ NO DEPARTMENT FILTER IN ANY QUERY BELOW AND THERE MUST NOT BE ONE. Every
 * table scopes by policy, so the same code shows a team leader their department
 * and an owner everything. That is also why the numbers can be trusted without a
 * scope selector: there is nothing here a reader is not already entitled to see.
 *
 * ⚠️ THE HOURS ARE WHY THE PAGE IS GATED AT `team_leader`, AND THE GATE STAYS ON
 * THE SERVER. `vizserve_pms_timesheet_entries`' SELECT policy is
 * owner-or-their-lead, so a MEMBER would see only their own hours under their
 * own department's name and read it as the department's total. `page.tsx` still
 * calls `requireRole("team_leader")` before rendering anything — settled
 * decision 6, authentication does not move.
 *
 * ⚠️ AND NOTHING HERE PASSES A LIST OF IDS TO POSTGREST. Every metric is one
 * query with an `!inner` embed instead of "fetch ids, then fetch by ids". A
 * 444-entry `in.(…)` produced a 16,542-character URL on this project on 6 Sep
 * and `fetch` failed with no status code at all. Embeds keep the URL a fixed
 * length whatever the period holds.
 * ------------------------------------------------------------------------
 */

/** Both ends inclusive; `to` is widened to the day after so timestamps count. */
export type Period = { from: string; to: string };

function exclusiveEnd(to: string): string {
  return addDays(to, 1) ?? to;
}

/** Whole days between two timestamps, floored. Negative is impossible and is clamped. */
function daysBetween(startIso: string, endIso: string): number {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Days from one date to another, KEEPING THE SIGN.
 *
 * `daysBetween` clamps at zero because a turnaround cannot run backwards. A
 * negotiated date very much can — a team that pulls a deadline EARLIER than the
 * client asked is the best thing that metric can find, and a clamped figure
 * would report it as no change at all.
 */
function signedDaysBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms)) return 0;
  return Math.round(ms / 86_400_000);
}

/**
 * The middle value, not the mean.
 *
 * ⚠️ A MEAN TURNAROUND IS A LIE ON THIS DATA and the median is the headline for
 * that reason. One request that sat over a holiday shutdown drags an average of
 * twenty past a fortnight while nineteen of them took two days. Both are
 * reported, because the gap between them is itself the interesting number.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/* -------------------------------------------------------------------------- */
/* The four metric shapes. Unchanged from `lib/reports-server.ts`.             */
/* -------------------------------------------------------------------------- */

export type Turnaround = {
  completed: number;
  medianDays: number | null;
  meanDays: number | null;
  fastestDays: number | null;
  slowestDays: number | null;
  /** The slowest handful, so a number has something to point at. */
  worst: { reference: string; days: number; title: string }[];
};

export type Negotiation = {
  approved: number;
  /** Where the approved date differs from what the client asked for. */
  negotiated: number;
  asRequested: number;
  /** Positive means later than asked; the median across negotiated ones only. */
  medianShiftDays: number | null;
  pulledEarlier: number;
  pushedLater: number;
};

export type ClientEngagement = {
  decisions: number;
  approved: number;
  revisionRequested: number;
  /** The cron closing a request nobody answered. See P4-09. */
  autoCompleted: number;
  /** Of everything that closed, the share a human client actually signed. */
  engagementPercent: number | null;
};

export type FeedbackReport = {
  responses: number;
  averageRating: number | null;
  /** Index 0 is one star. */
  distribution: [number, number, number, number, number];
  /** Only where the rating came with words. */
  comments: { rating: number; comment: string; at: string }[];
};

/** One department's line in the volume report. Drawn by `reports-table.tsx`. */
export type DepartmentReportRow = {
  id: string;
  name: string;
  byStatus: Record<VizservePmsTaskStatus, number>;
  notStarted: number;
  active: number;
  done: number;
  overdue: number;
  minutes: number;
  total: number;
};

export type ReportTotals = {
  notStarted: number;
  active: number;
  done: number;
  overdue: number;
  minutes: number;
  total: number;
};

export type DepartmentReport = {
  departments: DepartmentReportRow[];
  totals: ReportTotals;
  /** Client requests submitted in the period, by status, busiest first. */
  requestCounts: { status: VizservePmsRequestStatus; count: number }[];
  requestTotal: number;
  turnaround: Turnaround;
  negotiation: Negotiation;
  engagement: ClientEngagement;
  feedback: FeedbackReport;
};

/**
 * `qk.reports({ from, to })` — every figure on `/reports`, for one period.
 *
 * ⚠️ SEVEN READS IN ONE WAVE. None of them takes an argument from another:
 * every one is keyed by nothing but the period and the reader's own scope. The
 * RSC already batched them for that reason and the note it carried is kept —
 * the four metrics "depend on nothing here, so awaiting them separately would
 * add four round trips to a page that already has four".
 */
export async function fetchDepartmentReport(
  client: TaskReadClient,
  period: Period,
): Promise<DepartmentReport> {
  const end = exclusiveEnd(period.to);

  const [
    taskRows,
    requestRows,
    hoursRows,
    turnaroundRows,
    negotiationRows,
    decisionRows,
    feedbackRows,
  ] = await Promise.all([
    /*
     * Tasks CREATED in the period, not tasks touched in it.
     *
     * "Volume per department" is a question about intake, and `created_at` is
     * the only date every task has — `due_date` is nullable on most internal
     * work and would silently drop it from the count.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_tasks")
        .select("id, status, department_id, due_date, created_at")
        .gte("created_at", period.from)
        /*
         * `to` is a DATE and `created_at` is a timestamp, so `lte` on the bare
         * date would exclude everything created after midnight on the last day.
         * The day after, exclusive, is the whole day.
         */
        .lt("created_at", end),
    ),

    read<unknown[]>(
      client
        .from("vizserve_pms_requests")
        .select("id, status, created_at")
        .gte("created_at", period.from)
        .lt("created_at", end),
    ),

    /*
     * Hours logged in the period. `work_date` is a real date here, so the range
     * is inclusive on both ends with no arithmetic.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_timesheet_entries")
        .select("minutes, vizserve_pms_tasks!inner(department_id)")
        .gte("work_date", period.from)
        .lte("work_date", period.to),
    ),

    /*
     * ⚠️ NOT `qk.ref("departments")`, AND THAT IS THE ONE PLACE THIS FETCHER
     * DEPARTS FROM THE REFERENCE RULE. The names are reference data and the
     * caller DOES read them from that entry — see `reports-view.tsx`, which
     * resolves every label through it. They are not read here at all any more.
     * This comment stands where the ninth query used to, so nobody adds it back.
     */

    /*
     * P6-04 — HOW LONG A CLIENT WAITED, for every request finished in the
     * period.
     *
     * ⚠️ MEASURED FROM `sla_started_at`, NOT FROM `created_at`. The clock starts
     * when the request is submitted and the team is on the hook for it, which is
     * what a client means by "how long did it take". `created_at` would include
     * a draft sitting in somebody's browser.
     *
     * ⚠️ `COMPLETED_NO_RESPONSE` COUNTS. It is a finished request from the
     * team's side — the work was delivered and the client simply never answered
     * — and excluding it would make turnaround look better the more clients
     * ignore us. Whether the client engaged is a different question and has its
     * own metric below.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_task_status_history")
        .select(
          "created_at, vizserve_pms_tasks!inner(title, vizserve_pms_requests!inner(reference_no, sla_started_at))",
        )
        .in("to_status", ["COMPLETED", "COMPLETED_NO_RESPONSE"])
        .gte("created_at", period.from)
        .lt("created_at", end),
    ),

    /*
     * P6-06a — DOES GATE 1 CHANGE ANYTHING, OR DOES IT RUBBER-STAMP?
     *
     * `target_date` is what the client asked for and is never overwritten;
     * `approved_target_date` is what the team committed to. The delta between
     * them is the only measurable evidence the gate does work — which is exactly
     * why P2-03 kept both columns rather than one.
     *
     * ⚠️ COUNTED OVER REQUESTS REVIEWED IN THE PERIOD, not submitted in it. The
     * negotiation happens at review, so a request filed in March and approved in
     * April is April's evidence.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_requests")
        .select("target_date, approved_target_date")
        .not("reviewed_at", "is", null)
        .gte("reviewed_at", period.from)
        .lt("reviewed_at", end),
    ),

    /*
     * P6-06b — THE SINGLE NUMBER THAT SAYS WHETHER GATE 3 IS REAL.
     *
     * `APPROVED` and `REVISION_REQUESTED` are both a client engaging — one of
     * them is a client reading the work and asking for changes, which is the
     * gate doing precisely its job. `AUTO_COMPLETED` is the cron closing
     * something nobody looked at.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_client_decisions")
        .select("decision")
        .gte("created_at", period.from)
        .lt("created_at", end),
    ),

    /*
     * P6-07 — WHAT CLIENTS SAID, after the work landed.
     *
     * ⚠️ A MEAN IS THE RIGHT SUMMARY HERE AND THE WRONG ONE FOR TURNAROUND.
     * Ratings are bounded 1–5 and cannot be dragged by an outlier the way a
     * turnaround can, so the average is honest. The distribution is reported
     * beside it anyway, because a 4.0 made of fives and twos is a different
     * department from a 4.0 made of fours.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_feedback")
        .select("rating, comment, created_at")
        .gte("created_at", period.from)
        .lt("created_at", end)
        .order("created_at", { ascending: false }),
    ),
  ]);

  /* ------------------------------------------------------------ P6-05 */

  const tasks = parseAll(reportTaskSchema, taskRows, "tasks in this period");

  /**
   * Per department: the eight per-status counts, the three bands, and overdue.
   *
   * THE BANDS ARE DERIVED, not listed — `INITIAL_TASK_STATUS` and `isTerminal`
   * are the same two facts the status dropdown groups by, so a status added to
   * the enum lands in the right band here without anybody remembering to come
   * back. A hand-written list of "active statuses" is the copy that goes stale.
   *
   * ⚠️ THE NAME IS NOT RESOLVED HERE. The row carries its department's ID and
   * nothing else; `reports-view.tsx` labels it from `qk.ref("departments")`,
   * which is the entry every other screen in the app already holds. Doing it
   * here would have meant a ninth query for six rows that change once a quarter
   * — and would have put the naming of a department inside the key that is
   * refetched on every nudge of the date picker.
   */
  const rows = new Map<string, DepartmentReportRow>();

  function rowFor(departmentId: string): DepartmentReportRow {
    const existing = rows.get(departmentId);
    if (existing) return existing;

    const fresh: DepartmentReportRow = {
      id: departmentId,
      /* Filled in by the caller from the reference entry; see above. */
      name: "",
      byStatus: Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
        VizservePmsTaskStatus,
        number
      >,
      notStarted: 0,
      active: 0,
      done: 0,
      overdue: 0,
      minutes: 0,
      total: 0,
    };

    rows.set(departmentId, fresh);
    return fresh;
  }

  for (const task of tasks) {
    const row = rowFor(task.department_id);
    row.byStatus[task.status] += 1;
    row.total += 1;

    if (task.status === INITIAL_TASK_STATUS) row.notStarted += 1;
    else if (isTerminal(task.status)) row.done += 1;
    else row.active += 1;

    /*
     * Overdue only counts on live work. A completed task delivered late is
     * history, and counting it would make the figure only ever grow.
     */
    if (isOverdue(task.due_date) && !isTerminal(task.status)) row.overdue += 1;
  }

  for (const entry of parseAll(reportHoursSchema, hoursRows, "hours logged in this period")) {
    /*
     * `!inner` above means the join is guaranteed, but neither the generated
     * type nor the schema knows that. An entry with no task is not a thing the
     * schema allows.
     */
    const departmentId = entry.vizserve_pms_tasks?.department_id;
    if (!departmentId) continue;
    rowFor(departmentId).minutes += entry.minutes;
  }

  const departments = [...rows.values()];

  const totals = departments.reduce<ReportTotals>(
    (sum, row) => ({
      notStarted: sum.notStarted + row.notStarted,
      active: sum.active + row.active,
      done: sum.done + row.done,
      overdue: sum.overdue + row.overdue,
      minutes: sum.minutes + row.minutes,
      total: sum.total + row.total,
    }),
    { notStarted: 0, active: 0, done: 0, overdue: 0, minutes: 0, total: 0 },
  );

  /* --------------------------------------------------------- requests */

  const requestTally = new Map<VizservePmsRequestStatus, number>();
  for (const request of parseAll(
    reportRequestSchema,
    requestRows,
    "client requests in this period",
  )) {
    requestTally.set(request.status, (requestTally.get(request.status) ?? 0) + 1);
  }

  const requestCounts = [...requestTally.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  /* ------------------------------------------------------- turnaround */

  const finished = parseAll(turnaroundRowSchema, turnaroundRows, "completed requests").flatMap(
    (row) => {
      const request = row.vizserve_pms_tasks?.vizserve_pms_requests;
      if (!request?.sla_started_at) return [];
      return [
        {
          reference: request.reference_no,
          title: row.vizserve_pms_tasks?.title ?? "",
          days: daysBetween(request.sla_started_at, row.created_at),
        },
      ];
    },
  );

  const turnaroundDays = finished.map((row) => row.days);

  const turnaround: Turnaround = {
    completed: finished.length,
    medianDays: median(turnaroundDays),
    meanDays: mean(turnaroundDays),
    fastestDays: turnaroundDays.length > 0 ? Math.min(...turnaroundDays) : null,
    slowestDays: turnaroundDays.length > 0 ? Math.max(...turnaroundDays) : null,
    worst: [...finished].sort((a, b) => b.days - a.days).slice(0, 5),
  };

  /* ------------------------------------------------------ negotiation */

  const shifts: number[] = [];
  let asRequested = 0;
  const reviewed = parseAll(negotiationRowSchema, negotiationRows, "reviewed requests");

  for (const row of reviewed) {
    /*
     * ⚠️ A NULL `approved_target_date` MEANS "AS REQUESTED", NOT "MISSING"
     * (P2-06). Dropping these would report every rubber-stamp as an absence of
     * data and make the gate look busier than it is.
     */
    if (!row.approved_target_date || !row.target_date) {
      asRequested += 1;
      continue;
    }
    if (row.approved_target_date === row.target_date) {
      asRequested += 1;
      continue;
    }
    shifts.push(signedDaysBetween(row.target_date, row.approved_target_date));
  }

  const negotiation: Negotiation = {
    approved: reviewed.length,
    negotiated: shifts.length,
    asRequested,
    medianShiftDays: median(shifts),
    pulledEarlier: shifts.filter((days) => days < 0).length,
    pushedLater: shifts.filter((days) => days > 0).length,
  };

  /* ------------------------------------------------------- engagement */

  const decisions = parseAll(clientDecisionCountSchema, decisionRows, "client decisions");

  const approved = decisions.filter((row) => row.decision === "APPROVED").length;
  const revisionRequested = decisions.filter(
    (row) => row.decision === "REVISION_REQUESTED",
  ).length;
  const autoCompleted = decisions.filter((row) => row.decision === "AUTO_COMPLETED").length;
  const answered = approved + revisionRequested;

  const engagement: ClientEngagement = {
    decisions: decisions.length,
    approved,
    revisionRequested,
    autoCompleted,
    /*
     * ⚠️ THE DENOMINATOR IS EVERY DECISION, INCLUDING THE AUTOMATIC ONES. A
     * percentage over answered decisions only would always read 100% and would
     * say nothing at all.
     */
    engagementPercent:
      decisions.length > 0 ? Math.round((answered / decisions.length) * 100) : null,
  };

  /* --------------------------------------------------------- feedback */

  const ratings = parseAll(feedbackRowSchema, feedbackRows, "client feedback");

  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const row of ratings) {
    const index = Math.min(4, Math.max(0, Math.round(row.rating) - 1));
    distribution[index] += 1;
  }

  const feedback: FeedbackReport = {
    responses: ratings.length,
    averageRating: mean(ratings.map((row) => row.rating)),
    distribution,
    comments: ratings
      .filter((row) => row.comment?.trim())
      .slice(0, 10)
      .map((row) => ({ rating: row.rating, comment: row.comment!.trim(), at: row.created_at })),
  };

  return {
    departments,
    totals,
    requestCounts,
    requestTotal: requestCounts.reduce((sum, row) => sum + row.count, 0),
    turnaround,
    negotiation,
    engagement,
    feedback,
  };
}
