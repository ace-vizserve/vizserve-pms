import type { Metadata } from "next";

import { realtimeDepartmentFilter, requireRole } from "@/lib/auth/authorization";

import { RequestsView, type RequestsSearchParams } from "./requests-view";

export const metadata: Metadata = { title: "Requests" };

/**
 * P1-13 / P12-18 — the Team Leader's queue: the SERVER half, which is auth and
 * the realtime scope and nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO BE THE WHOLE PAGE — two queries, then a third keyed by
 * the reviewers on the page it had just fetched, plus the sort allowlist, the
 * paging arithmetic, the search escaping and the paginator's `hrefFor`. P12-18
 * moved the reads into the TanStack cache (`requests-view.tsx`,
 * `lib/query/fetchers/requests.ts`) and left behind exactly two things that must
 * not move:
 *
 *   1. `requireRole("team_leader")` — the role gate, on top of
 *      `requireAuthContext()`'s temporary-password wall, `app_access` gate and
 *      deactivation check. Authentication does not go through the cache, in any
 *      phase.
 *   2. THE REALTIME FILTER. `realtimeDepartmentFilter` lives in a `server-only`
 *      module and is what the browser is TOLD it may watch — it is not asking.
 *      A client component computing its own subscription scope is precisely the
 *      "scattered `if (role === 'admin')`" CLAUDE.md exists to forbid, and it is
 *      not a security control either way: RLS refuses every event the stream
 *      carries that the subscriber may not see.
 *
 * ⚠️ THERE IS NO `viewer` PROP AND THERE SHOULD NOT BE ONE. Nothing on this
 * queue turns on a role beyond the gate above — the rows are department-scoped
 * by policy, which is what makes the Phase 1 exit criterion ("a request appears
 * in the correct TL's queue and nowhere else") assertable at the API layer
 * rather than by clicking around.
 *
 * ⚠️ AND IT ISSUES NO QUERY AT ALL NOW. Every navigation into this queue cost
 * two or three server reads before the browser saw a row; it costs the session
 * lookup `requireRole` already does for the layout and nothing else.
 * ------------------------------------------------------------------------
 *
 * No <h1>. The shell breadcrumb is the page label.
 */
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<RequestsSearchParams>;
}) {
  // The context is kept rather than discarded: P8-03 needs the department scope
  // for the realtime filter. Re-resolving it would cost nothing — `resolveAuth`
  // is wrapped in React `cache()`, and it reads `getClaims()`, which is a
  // signature check on the cookie rather than a round trip — so the reason to
  // hold it is legibility, not latency: the scope handed to `RealtimeTasks` is
  // provably the scope this page was authorised under, not a second resolution
  // that could drift from it.
  const context = await requireRole("team_leader");
  const params = await searchParams;

  return <RequestsView params={params} realtimeFilter={realtimeDepartmentFilter(context)} />;
}
