import type { Metadata } from "next";
import { Suspense } from "react";

import Loading from "./loading";
import { InboxView } from "./inbox-view";

export const metadata: Metadata = { title: "Inbox" };

/**
 * P12 Phase A — NO SERVER WORK, so a click here switches at once.
 *
 * The layout above has already run the auth gate for this session; the rows
 * come from the query cache (`inbox-view.tsx`), scoped by RLS. The boundary is
 * what `useSearchParams` needs to prerender the shell: on a page load it shows
 * the same skeleton `loading.tsx` draws, and on a client navigation the params
 * are already known and it never suspends.
 */
export default function InboxPage() {
  return (
    <Suspense fallback={<Loading />}>
      <InboxView />
    </Suspense>
  );
}
