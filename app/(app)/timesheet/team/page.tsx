"use client";

import { Suspense } from "react";

import Loading from "./loading";
import { TeamPageView } from "./team-page-view";

/**
 * P12 Phase A — A CLIENT PAGE, so a click here is a single-page-app transition
 * with no server render at navigation time (Next's "Client Component Pages").
 * A server page — even one that computed nothing — still made the router ask
 * the server for it on every visit, which is what drew the skeleton on a quick
 * revisit. The auth gate still runs in `app/(app)/layout.tsx`; the data comes
 * from the query cache; RLS scopes every read. Metadata lives in `layout.tsx`
 * beside this file, because a client page cannot export it.
 *
 * The boundary is what `useSearchParams`/`useParams` need to prerender the
 * shell on a page load; on a client navigation it never suspends.
 */
export default function TeamWeekPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TeamPageView />
    </Suspense>
  );
}
