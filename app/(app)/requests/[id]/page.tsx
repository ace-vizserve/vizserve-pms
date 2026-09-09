import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/authorization";

import { RequestDetailView } from "./request-detail";

export const metadata: Metadata = { title: "Request" };

/**
 * P1-14 / P12-18 — request detail: the SERVER half, which is auth and the
 * reviewer's own identity and nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO BE THE WHOLE PAGE — four sequential waves of queries and
 * every derivation the cards read. P12-18 moved the reads into the TanStack
 * cache (`request-detail.tsx`, `lib/query/fetchers/requests.ts`) and left behind
 * exactly two things that must not move:
 *
 *   1. `requireRole("team_leader")` — the role gate, on top of
 *      `requireAuthContext()`'s temporary-password wall, `app_access` gate and
 *      deactivation check. Authentication does not go through the cache, in any
 *      phase.
 *   2. THE REVIEWER'S OWN ID AND NAME. P2-05 defaults the QA field to the
 *      approving TL, and who that is belongs with the session rather than with a
 *      query — the alternative is the browser asking the database who it is,
 *      which is a worse answer to a question the cookie already settled.
 *
 * ⚠️ THE 404 MOVED WITH THE ROW, DELIBERATELY. `notFound()` used to be called
 * here on a null `maybeSingle()`; it is now called in the client component after
 * `isPending` and `isError` are ruled out. That ORDER is the point, and the RSC
 * lost an afternoon to not having it: out of scope returns no row under RLS and
 * IS a 404, but a FAILED query is a fault, and rendering the same bare
 * not-found page for both sent whoever was debugging to look at RLS — exactly
 * where the answer was not.
 *
 * ⚠️ AND IT ISSUES NO QUERY AT ALL NOW. Opening a request cost eleven server
 * reads in four waves before anything painted; it costs the session lookup
 * `requireRole` already does for the layout and nothing else.
 * ------------------------------------------------------------------------
 */
export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requireRole("team_leader");

  return (
    <RequestDetailView
      requestId={id}
      currentUserId={context.userId}
      currentUserName={context.fullName}
    />
  );
}
