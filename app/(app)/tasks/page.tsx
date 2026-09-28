import type { Metadata } from "next";
import { Suspense } from "react";

import Loading from "./loading";
import { TasksPageView } from "./tasks-page-view";

export const metadata: Metadata = { title: "Tasks" };

/**
 * P12 Phase A — NO SERVER WORK, so opening a list switches at once. Everything
 * on the page reads from the query cache in `tasks-page-view.tsx`; the layout
 * runs the auth gate and RLS scopes every row. The boundary is what
 * `useSearchParams` needs to prerender the shell.
 */
export default function TasksPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TasksPageView />
    </Suspense>
  );
}
