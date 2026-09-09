import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/authorization";
import { addDays, addMonths, startOfMonth, todayInAppZone } from "@/lib/dates";

import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "Reports" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * P6-05 / SLICE E2 — status and volume per department.
 *
 * THE NARROW READING OF P6-05 AND NO WIDER. Tasks by stage, requests by status,
 * overdue counts, and — for the first time with data behind it — hours logged per
 * department, which is the seventh metric in docs/09-later-phases.md:111. P6-04
 * (turnaround), P6-06 (negotiation and auto-complete splits) and P6-07 (feedback)
 * followed and are the four cards. Still explicitly NOT here: P6-08 (archive) and
 * P6-09 (CSV export).
 *
 * ------------------------------------------------------------------------
 * ⚠️ P12-21 — THE EIGHT QUERIES AND THE AGGREGATION LEFT THIS FILE. WHAT IS
 * STILL HERE IS EVERYTHING THAT CANNOT LEAVE IT.
 *
 * 1. THE GATE. `requireRole("team_leader")`, and it is about the HOURS rather
 *    than about seniority: `vizserve_pms_timesheet_entries`' SELECT policy is
 *    owner-or-their-lead, so a MEMBER reading this page would see only their own
 *    hours under their own department's name and read it as the department's
 *    total. Rather than adding a definer function for it, the page is gated at
 *    the role for whom the policy already returns the whole department. A member
 *    has no departmental question to ask here anyway. Settled decision 6 —
 *    authentication does not move in any phase of the SPA migration.
 *
 * 2. THE PERIOD. `searchParams` is awaited here, narrowed here, and handed down
 *    as two plain strings. It is deliberately NOT re-read in the client with
 *    `useSearchParams`: the fallback below (this month) is a decision, and two
 *    readings of one URL is how a cache key and the query under it drift by a
 *    navigation. `RangePicker` still writes the URL through the router, so the
 *    period stays shareable — which is the whole reason it lives there.
 *
 * Everything else — the reads, the derivations, the failure states — is
 * `reports-view.tsx` and `lib/query/fetchers/reports.ts`.
 * ------------------------------------------------------------------------
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  // The gate, and it is about the HOURS rather than about seniority — see above.
  await requireRole("team_leader");

  const params = await searchParams;
  const today = todayInAppZone();

  /*
   * The period. This month by default, and narrowed rather than trusted: these
   * reach Postgres as date literals, so an unparseable value would turn a
   * mistyped bookmark into a 500.
   */
  const monthStart = startOfMonth(today) ?? today;
  const from = DATE.test(params.from ?? "") ? params.from! : monthStart;
  const to = DATE.test(params.to ?? "")
    ? params.to!
    : // The last day of the month the period starts in: forward a month, back a
      // day. `lib/dates.ts` has both, and neither needs a date library.
      (addDays(addMonths(monthStart, 1) ?? monthStart, -1) ?? today);

  /*
   * Inverted ranges are NOT silently swapped. Answering a different question than
   * the one asked is how somebody ends up trusting a period they never set — the
   * same call the DTR range makes.
   */
  return <ReportsView from={from} to={to} inverted={from > to} />;
}
