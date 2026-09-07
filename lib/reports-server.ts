import "server-only";

import { addDays } from "@/lib/dates";
import type { createClient } from "@/utils/supabase/server";

/**
 * P6-04 / P6-06 / P6-07 — the four metrics `/reports` did not have.
 *
 * P6-05 shipped the narrow half on 19 Aug: tasks by stage, requests by status,
 * overdue counts and hours per department. Its header lists what it left out,
 * and this is that list — turnaround, the negotiation split, the
 * approved-versus-auto-completed split, and feedback.
 *
 * ⚠️ TWO OF THESE ARE THE ONES NOBODY ASKS FOR AND EVERYBODY NEEDS
 * (docs/09-later-phases.md). Negotiated-versus-original target date is the only
 * evidence that Gate 1 does anything rather than rubber-stamping;
 * approved-versus-auto-completed is the single number that says whether clients
 * are engaging at Gate 3. Both are the material Amier takes to a client when he
 * argues for the process.
 *
 * ⚠️ AGGREGATED IN TYPESCRIPT OVER RLS-SCOPED ROWS, exactly as P6-05 does, and
 * for the same reason: sixteen users and one tenant do not justify a
 * `SECURITY DEFINER` aggregate, and a definer would have to re-implement the
 * department scoping the policies already do. NO QUERY BELOW CARRIES A
 * DEPARTMENT FILTER — the policies decide, so a lead sees their departments and
 * an owner sees everything from the same code.
 *
 * ⚠️ AND NOTHING HERE PASSES A LIST OF IDS TO POSTGREST. Every metric is one
 * query with an `!inner` embed instead of "fetch ids, then fetch by ids". A
 * 444-entry `in.(…)` produced a 16,542-character URL on this project on 6 Sep
 * and `fetch` failed with no status code at all. Embeds keep the URL a fixed
 * length whatever the period holds.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

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
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

// ---------------------------------------------------------------------------
// P6-04 — turnaround
// ---------------------------------------------------------------------------

export type Turnaround = {
  completed: number;
  medianDays: number | null;
  meanDays: number | null;
  fastestDays: number | null;
  slowestDays: number | null;
  /** The slowest handful, so a number has something to point at. */
  worst: { reference: string; days: number; title: string }[];
};

/**
 * How long a client waited, for every request finished in the period.
 *
 * ⚠️ MEASURED FROM `sla_started_at`, NOT FROM `created_at`. The clock starts when
 * the request is submitted and the team is on the hook for it, which is what a
 * client means by "how long did it take". `created_at` would include a draft
 * sitting in somebody's browser.
 *
 * ⚠️ AND THERE IS NO `completed_at` COLUMN, which is why this reads the HISTORY.
 * `vizserve_pms_tasks` records the current status and nothing about when it got
 * there; the only durable record of a completion instant is the
 * `vizserve_pms_task_status_history` row that wrote it. That also makes this
 * honest about re-openings: a task completed twice contributes twice, and the
 * second is the one a reader would call the real one.
 *
 * ⚠️ `COMPLETED_NO_RESPONSE` COUNTS. It is a finished request from the team's
 * side — the work was delivered and the client simply never answered — and
 * excluding it would make turnaround look better the more clients ignore us.
 * Whether the client engaged is a different question, and it has its own metric
 * below.
 */
export async function loadTurnaround(supabase: Supabase, period: Period): Promise<Turnaround> {
  const { data } = await supabase
    .from("vizserve_pms_task_status_history")
    .select(
      "created_at, vizserve_pms_tasks!inner(title, vizserve_pms_requests!inner(reference_no, sla_started_at))",
    )
    .in("to_status", ["COMPLETED", "COMPLETED_NO_RESPONSE"])
    .gte("created_at", period.from)
    .lt("created_at", exclusiveEnd(period.to));

  type Row = {
    created_at: string;
    vizserve_pms_tasks: {
      title: string;
      vizserve_pms_requests: { reference_no: string; sla_started_at: string | null } | null;
    } | null;
  };

  const finished = ((data ?? []) as unknown as Row[]).flatMap((row) => {
    const request = row.vizserve_pms_tasks?.vizserve_pms_requests;
    if (!request?.sla_started_at) return [];
    return [
      {
        reference: request.reference_no,
        title: row.vizserve_pms_tasks?.title ?? "",
        days: daysBetween(request.sla_started_at, row.created_at),
      },
    ];
  });

  const days = finished.map((row) => row.days);

  return {
    completed: finished.length,
    medianDays: median(days),
    meanDays: mean(days),
    fastestDays: days.length > 0 ? Math.min(...days) : null,
    slowestDays: days.length > 0 ? Math.max(...days) : null,
    worst: [...finished].sort((a, b) => b.days - a.days).slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// P6-06a — negotiation
// ---------------------------------------------------------------------------

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

/**
 * Does Gate 1 change anything, or does it rubber-stamp?
 *
 * `target_date` is what the client asked for and is never overwritten;
 * `approved_target_date` is what the team committed to. The delta between them
 * is the only measurable evidence the gate does work — which is exactly why
 * P2-03 kept both columns rather than one.
 *
 * ⚠️ COUNTED OVER REQUESTS REVIEWED IN THE PERIOD, not submitted in it. The
 * negotiation happens at review, so a request filed in March and approved in
 * April is April's evidence.
 *
 * ⚠️ A NULL `approved_target_date` MEANS "AS REQUESTED", NOT "MISSING". P2-06
 * spells that out and it is the reason this counts nulls into `asRequested`
 * rather than dropping them — dropping would report every rubber-stamp as an
 * absence of data and make the gate look busier than it is.
 */
export async function loadNegotiation(supabase: Supabase, period: Period): Promise<Negotiation> {
  const { data } = await supabase
    .from("vizserve_pms_requests")
    .select("target_date, approved_target_date")
    .not("reviewed_at", "is", null)
    .gte("reviewed_at", period.from)
    .lt("reviewed_at", exclusiveEnd(period.to));

  const rows = (data ?? []) as { target_date: string | null; approved_target_date: string | null }[];

  const shifts: number[] = [];
  let asRequested = 0;

  for (const row of rows) {
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

  return {
    approved: rows.length,
    negotiated: shifts.length,
    asRequested,
    medianShiftDays: median(shifts),
    pulledEarlier: shifts.filter((days) => days < 0).length,
    pushedLater: shifts.filter((days) => days > 0).length,
  };
}

/**
 * Days from one date to another, KEEPING THE SIGN.
 *
 * `daysBetween` clamps at zero because a turnaround cannot run backwards. A
 * negotiated date very much can — a team that pulls a deadline EARLIER than the
 * client asked is the best thing this metric can find, and a clamped figure
 * would report it as no change at all.
 */
function signedDaysBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms)) return 0;
  return Math.round(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
// P6-06b — did the client actually answer?
// ---------------------------------------------------------------------------

export type ClientEngagement = {
  decisions: number;
  approved: number;
  revisionRequested: number;
  /** The cron closing a request nobody answered. See P4-09. */
  autoCompleted: number;
  /** Of everything that closed, the share a human client actually signed. */
  engagementPercent: number | null;
};

/**
 * The single number that says whether Gate 3 is real.
 *
 * `APPROVED` and `REVISION_REQUESTED` are both a client engaging — one of them
 * is a client reading the work and asking for changes, which is the gate doing
 * precisely its job. `AUTO_COMPLETED` is the cron closing something nobody
 * looked at.
 *
 * ⚠️ THE DENOMINATOR IS EVERY DECISION, INCLUDING THE AUTOMATIC ONES. A
 * percentage over answered decisions only would always read 100% and would say
 * nothing at all.
 */
export async function loadClientEngagement(
  supabase: Supabase,
  period: Period,
): Promise<ClientEngagement> {
  const { data } = await supabase
    .from("vizserve_pms_client_decisions")
    .select("decision")
    .gte("created_at", period.from)
    .lt("created_at", exclusiveEnd(period.to));

  const rows = (data ?? []) as { decision: string }[];

  const approved = rows.filter((row) => row.decision === "APPROVED").length;
  const revisionRequested = rows.filter((row) => row.decision === "REVISION_REQUESTED").length;
  const autoCompleted = rows.filter((row) => row.decision === "AUTO_COMPLETED").length;
  const answered = approved + revisionRequested;

  return {
    decisions: rows.length,
    approved,
    revisionRequested,
    autoCompleted,
    engagementPercent: rows.length > 0 ? Math.round((answered / rows.length) * 100) : null,
  };
}

// ---------------------------------------------------------------------------
// P6-07 — feedback
// ---------------------------------------------------------------------------

export type FeedbackReport = {
  responses: number;
  averageRating: number | null;
  /** Index 0 is one star. */
  distribution: [number, number, number, number, number];
  /** Only where the rating came with words. */
  comments: { rating: number; comment: string; at: string }[];
};

/**
 * What clients said, after the work landed.
 *
 * ⚠️ A MEAN IS THE RIGHT SUMMARY HERE AND THE WRONG ONE ABOVE. Ratings are
 * bounded 1–5 and cannot be dragged by an outlier the way a turnaround can, so
 * the average is honest. The distribution is reported beside it anyway, because
 * a 4.0 made of fives and twos is a different department from a 4.0 made of
 * fours.
 *
 * ⚠️ THE COUNT MATTERS MORE THAN THE AVERAGE at this volume. Three responses
 * averaging 5.0 is not a rating; it is three people. The screen shows the
 * denominator next to the figure for that reason.
 */
export async function loadFeedback(supabase: Supabase, period: Period): Promise<FeedbackReport> {
  const { data } = await supabase
    .from("vizserve_pms_feedback")
    .select("rating, comment, created_at")
    .gte("created_at", period.from)
    .lt("created_at", exclusiveEnd(period.to))
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as { rating: number; comment: string | null; created_at: string }[];

  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const row of rows) {
    const index = Math.min(4, Math.max(0, Math.round(row.rating) - 1));
    distribution[index] += 1;
  }

  return {
    responses: rows.length,
    averageRating: mean(rows.map((row) => row.rating)),
    distribution,
    comments: rows
      .filter((row) => row.comment?.trim())
      .slice(0, 10)
      .map((row) => ({ rating: row.rating, comment: row.comment!.trim(), at: row.created_at })),
  };
}
