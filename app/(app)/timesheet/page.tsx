import type { Metadata } from "next";
import { Suspense } from "react";

import Loading from "./loading";
import { TimesheetPageView } from "./timesheet-page-view";

export const metadata: Metadata = { title: "Timesheet" };

/**
 * P12 Phase A — NO SERVER WORK, so a click here switches at once. The week, the
 * viewer and today are all resolved in `timesheet-page-view.tsx`; the rows come
 * from the query cache. The boundary is what `useSearchParams` needs to
 * prerender the shell.
 */
export default function TimesheetPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TimesheetPageView />
    </Suspense>
  );
}
